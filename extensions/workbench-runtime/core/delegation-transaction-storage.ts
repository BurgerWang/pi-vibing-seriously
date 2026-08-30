/**
 * Durable storage for delegation transaction v2.
 *
 * The state machine remains pure in delegation-transaction.ts. This module
 * serializes every lifecycle mutation behind a per-delegation exclusive lock
 * and publishes immutable committed generations before it publishes a
 * terminal transaction state.
 */

import { createHash, randomBytes } from "node:crypto";
import { open, lstat, mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { canonicalHash } from "../cache/canonical-hash.ts";

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
	delegationRepairReviewPathsV1,
	isCurrentDelegationTerminalOutcome,
	parseDelegationTransaction,
	publishDelegationCommit,
	requireDelegationRecovery,
	reviewDelegationTransaction,
	resumeDelegationTransaction,
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
import { isWorkerRunFailureCode } from "./worker-run-failure.ts";
import {
	REVIEW_RECORD_MAX_BYTES,
	REVIEW_PAGE_SOURCE_MAX_BYTES,
	REVIEW_PAGE_BODY_MAX_BYTES,
	REVIEW_PAGE_BODY_MAX_LINES,
	REVIEW_PRESENTATION_PROGRESS_MAX_ITEMS,
	REVIEW_PRESENTATION_SEGMENT_MAX_ITEMS,
	REVIEW_PATCH_MAX_BYTES,
	REVIEW_PATCH_MAX_LINES,
	isCompleteReviewPresentationEntry,
	isScopeIntegrityPacketComplete,
	isStrictSemanticAcceptedOrZeroDelta,
	type ReviewPatchEntry,
	type ReviewPresentationProgress,
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
import { validateSemanticReviewEnvelopeV1 } from "./semantic-review-envelope.ts";
import {
	SEMANTIC_REVIEW_EVIDENCE_MAX_BYTES_V2,
	validateSemanticReviewEvidenceV2,
	verifySemanticReviewEvidenceBindingV2,
	verifySemanticReviewParentEvidenceV2,
	type SemanticReviewEvidenceV2,
} from "./semantic-review-evidence-v2.ts";
import {
	validateSemanticReviewProgressV2,
	type SemanticReviewProgressV2,
} from "./structured-sol-review.ts";
import {
	WORKER_CHECKPOINT_MAX_BYTES_V1,
	validateWorkerCheckpointV1,
	type WorkerCheckpointV1,
} from "./worker-checkpoint.ts";
import { validateChangeSet, type ChangeSetRecord } from "./change-set.ts";
import {
	validateDelegationCommandProvenance,
	type DelegationCommandProvenanceRecord,
} from "./delegation-command-effect-provenance.ts";
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
const SEMANTIC_REVIEW_EVIDENCE_V2_FILE = "semantic-review-evidence-v2.json";
const SEMANTIC_REVIEW_PROGRESS_V2_FILE = "semantic-review-progress-v2.json";
const WORKER_CHECKPOINT_V1_FILE = "worker-checkpoint-v1.json";
const SEMANTIC_MIGRATION_FILE = "semantic-migration.json";
const SEMANTIC_REPAIR_DECISION_FILE = "repair-decision.json";
const TERMINAL_NEGATIVE_REPAIR_DECISION_FILE = "terminal-negative-repair-decision.json";

export const DELEGATION_SEMANTIC_MIGRATION_MAX_BYTES = 524_288 as const;
export const DELEGATION_SEMANTIC_REPAIR_DECISION_MAX_BYTES = 16_384 as const;
export const DELEGATION_TERMINAL_NEGATIVE_REPAIR_DECISION_MAX_BYTES = 32_768 as const;
export const DELEGATION_SEMANTIC_REVIEW_EVIDENCE_V2_MAX_BYTES = SEMANTIC_REVIEW_EVIDENCE_MAX_BYTES_V2;
export const DELEGATION_SEMANTIC_REVIEW_PROGRESS_V2_MAX_BYTES = 4 * 1024 * 1024;
export const DELEGATION_WORKER_CHECKPOINT_V1_MAX_BYTES = WORKER_CHECKPOINT_MAX_BYTES_V1;

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

export const DELEGATION_SEMANTIC_MIGRATION_STORAGE_FAULT_POINTS = [
	"semantic_migration.temp.write",
	"semantic_migration.temp.read",
	"semantic_migration.rename",
	"semantic_migration.final.read",
] as const;

export const DELEGATION_SEMANTIC_REPAIR_STORAGE_FAULT_POINTS = [
	"repair_decision.temp.write",
	"repair_decision.temp.read",
	"repair_decision.rename",
	"repair_decision.final.read",
] as const;

export const DELEGATION_TERMINAL_NEGATIVE_REPAIR_STORAGE_FAULT_POINTS = [
	"terminal_negative_repair.temp.write",
	"terminal_negative_repair.temp.read",
	"terminal_negative_repair.rename",
	"terminal_negative_repair.final.read",
] as const;

export const DELEGATION_SEMANTIC_REVIEW_EVIDENCE_V2_STORAGE_FAULT_POINTS = [
	"semantic_evidence_v2.temp.write",
	"semantic_evidence_v2.temp.read",
	"semantic_evidence_v2.rename",
	"semantic_evidence_v2.final.read",
] as const;

export const DELEGATION_SEMANTIC_REVIEW_PROGRESS_V2_STORAGE_FAULT_POINTS = [
	"semantic_progress_v2.write.before",
	"semantic_progress_v2.rename.before",
	"semantic_progress_v2.rename.after",
	"semantic_progress_v2.readback.before",
	"semantic_progress_v2.readback.after",
] as const;

export const DELEGATION_WORKER_CHECKPOINT_V1_STORAGE_FAULT_POINTS = [
	"worker_checkpoint_v1.temp.write",
	"worker_checkpoint_v1.temp.read",
	"worker_checkpoint_v1.rename",
	"worker_checkpoint_v1.final.read",
] as const;

export type DelegationTransactionStorageFaultPoint =
	| (typeof DELEGATION_TRANSACTION_STORAGE_FAULT_POINTS)[number]
	| (typeof DELEGATION_REVIEW_STORAGE_FAULT_POINTS)[number]
	| (typeof DELEGATION_SEMANTIC_MIGRATION_STORAGE_FAULT_POINTS)[number]
	| (typeof DELEGATION_SEMANTIC_REPAIR_STORAGE_FAULT_POINTS)[number]
	| (typeof DELEGATION_TERMINAL_NEGATIVE_REPAIR_STORAGE_FAULT_POINTS)[number]
	| (typeof DELEGATION_SEMANTIC_REVIEW_EVIDENCE_V2_STORAGE_FAULT_POINTS)[number]
	| (typeof DELEGATION_SEMANTIC_REVIEW_PROGRESS_V2_STORAGE_FAULT_POINTS)[number]
	| (typeof DELEGATION_WORKER_CHECKPOINT_V1_STORAGE_FAULT_POINTS)[number];

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
	readBootId?(): Promise<string | null>;
	readProcessStartTicks?(processId: number): Promise<string | null>;
	fault?(point: DelegationTransactionStorageFaultPoint, bytes?: Readonly<Uint8Array>):
		void | Uint8Array | Promise<void | Uint8Array>;
}

/**
 * Narrow Node primitives used by the production adapter. The optional
 * injection point exists so durability ordering and failure propagation can
 * be tested without changing the long-standing custom storage-adapter
 * contract above.
 */
export interface DelegationTransactionNodeFileHandle {
	write(buffer: Uint8Array, offset: number, length: number, position: number):
		Promise<{ bytesWritten: number }>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

export interface DelegationTransactionNodeFsPrimitives {
	open(path: string, flags: string, mode?: number): Promise<DelegationTransactionNodeFileHandle>;
	mkdir(path: string, options: Readonly<{ recursive: boolean; mode: number }>): Promise<string | undefined>;
	rename(source: string, destination: string): Promise<void>;
	unlink(path: string): Promise<void>;
}

const NODE_DELEGATION_TRANSACTION_FS: DelegationTransactionNodeFsPrimitives = {
	open: async (path, flags, mode) => open(path, flags, mode),
	mkdir: async (path, options) => mkdir(path, options),
	rename,
	unlink,
};

async function closeNodeHandleAfterSuccess(handle: DelegationTransactionNodeFileHandle): Promise<void> {
	await handle.close();
}

async function syncNodeDirectory(
	path: string,
	fs: DelegationTransactionNodeFsPrimitives,
): Promise<void> {
	const handle = await fs.open(path, "r");
	try {
		await handle.sync();
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
	await closeNodeHandleAfterSuccess(handle);
}

async function writeNodeFileDurably(
	path: string,
	bytes: Uint8Array,
	exclusive: boolean,
	fs: DelegationTransactionNodeFsPrimitives,
): Promise<void> {
	const handle = await fs.open(path, exclusive ? "wx" : "w", 0o600);
	try {
		let offset = 0;
		while (offset < bytes.byteLength) {
			const remaining = bytes.byteLength - offset;
			const { bytesWritten } = await handle.write(bytes, offset, remaining, offset);
			if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
				throw new Error("short durable write made no valid progress");
			}
			offset += bytesWritten;
		}
		await handle.sync();
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
	await closeNodeHandleAfterSuccess(handle);
	// fsync(file) persists bytes and inode metadata; fsync(parent) persists a
	// newly created exclusive name. Always syncing the parent also covers the
	// adapter's non-exclusive create/truncate compatibility path.
	await syncNodeDirectory(dirname(resolve(path)), fs);
}

async function makeNodeDirectoryDurably(
	path: string,
	exclusive: boolean,
	fs: DelegationTransactionNodeFsPrimitives,
): Promise<void> {
	const created = await fs.mkdir(path, { recursive: !exclusive, mode: 0o700 });
	if (exclusive) {
		await syncNodeDirectory(dirname(resolve(path)), fs);
		return;
	}
	if (created === undefined) return;

	// Recursive mkdir reports the first path it created. Sync every parent
	// containing a new directory entry, deepest first, so each link in the
	// newly-created chain is durable before the call reports success.
	const firstCreated = resolve(created);
	let current = resolve(path);
	const parents: string[] = [];
	for (;;) {
		parents.push(dirname(current));
		if (current === firstCreated) break;
		const parent = dirname(current);
		if (parent === current) throw new Error("recursive mkdir returned an unrelated created path");
		current = parent;
	}
	for (const parent of parents) await syncNodeDirectory(parent, fs);
}

async function moveNodeEntryDurably(
	source: string,
	destination: string,
	fs: DelegationTransactionNodeFsPrimitives,
): Promise<void> {
	await fs.rename(source, destination);
	const destinationParent = dirname(resolve(destination));
	const sourceParent = dirname(resolve(source));
	await syncNodeDirectory(destinationParent, fs);
	if (sourceParent !== destinationParent) await syncNodeDirectory(sourceParent, fs);
}

async function removeNodeFileDurably(
	path: string,
	fs: DelegationTransactionNodeFsPrimitives,
): Promise<void> {
	await fs.unlink(path);
	await syncNodeDirectory(dirname(resolve(path)), fs);
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

async function nodeReadBootId(): Promise<string | null> {
	try {
		const value = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().toLowerCase();
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value) ? value : null;
	} catch {
		return null;
	}
}

async function nodeReadProcessStartTicks(processId: number): Promise<string | null> {
	if (!Number.isSafeInteger(processId) || processId <= 0) return null;
	try {
		const raw = await readFile(`/proc/${processId}/stat`, "utf8");
		const commandEnd = raw.lastIndexOf(")");
		if (commandEnd < 0) return null;
		const value = raw.slice(commandEnd + 1).trim().split(/\s+/u)[19];
		return value !== undefined && /^(0|[1-9][0-9]*)$/u.test(value) ? value : null;
	} catch {
		return null;
	}
}

/** Default production adapter: Node filesystem only, no shell or argv. */
export function createNodeDelegationTransactionStorageAdapter(
	fault?: DelegationTransactionStorageAdapter["fault"],
	fs: DelegationTransactionNodeFsPrimitives = NODE_DELEGATION_TRANSACTION_FS,
): DelegationTransactionStorageAdapter {
	return {
		async makeDirectory(path, exclusive) {
			await makeNodeDirectoryDurably(path, exclusive, fs);
		},
		async write(path, bytes, exclusive) {
			await writeNodeFileDurably(path, bytes, exclusive, fs);
		},
		readBounded: nodeReadBounded,
		async move(source, destination) {
			await moveNodeEntryDurably(source, destination, fs);
		},
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
		async removeFile(path) {
			await removeNodeFileDurably(path, fs);
		},
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
		readBootId: nodeReadBootId,
		readProcessStartTicks: nodeReadProcessStartTicks,
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
	/** Optional immutable supplement for historical mechanical FINAL records. */
	semantic_migration?: DelegationSemanticMigrationV1;
	/** Optional immutable Sol decision that rejects this provisional delta for repair. */
	semantic_repair?: DelegationSemanticRepairDecisionV1;
	/** New protocol owner. Legacy embedded/migration authority remains read-only when absent. */
	semantic_evidence_v2?: SemanticReviewEvidenceV2;
	/**
	 * Read-only compatibility proof for a strictly revalidated historical
	 * negative lifecycle. It is derived, never persisted as caller authority.
	 */
	terminal_negative_committed_compatibility?: true;
}

export interface PublishDelegationReviewV2Input extends DelegationCasInput {
	artifact: DelegationReviewArtifactV2;
}

export interface PublishDelegationSemanticReviewEvidenceV2Input extends DelegationCasInput {
	base_review_hash: string;
	evidence: SemanticReviewEvidenceV2;
}

export interface DelegationSemanticRepairReviewerV1 {
	provider: "openai" | "openai-codex";
	model: "gpt-5.6-sol";
}

/** Immutable, packet-bound Sol decision. It grants repair provenance, never review or Gate authority. */
export interface DelegationSemanticRepairDecisionV1 {
	schema_version: 1;
	delegation_id: string;
	contract_hash: string;
	generation: number;
	transaction_revision: 3;
	generation_content_hash: string;
	base_review_hash: string;
	expected_bound_diff_hash: string;
	decision: "REPAIR";
	repair_reason: string;
	repair_reason_hash: string;
	reviewer: DelegationSemanticRepairReviewerV1;
	decided_at: string;
	decision_hash: string;
}

export interface PublishDelegationSemanticRepairDecisionV1Input extends DelegationCasInput {
	base_review_hash: string;
	expected_bound_diff_hash: string;
	repair_reason: string;
	reviewer: DelegationSemanticRepairReviewerV1;
}

export type DelegationTerminalNegativeStatusV1 = "INTERRUPTED" | "FAILED";

/**
 * Distinct immutable wrapper for a Sol REPAIR decision over a committed
 * terminal-negative generation.  The nested decision deliberately retains
 * the established repair-decision shape consumed by exact-repair recovery;
 * the wrapper additionally binds the exact parent state and its closed
 * failure facts so it can never be confused with a PENDING_REVIEW decision.
 */
export interface DelegationTerminalNegativeRepairDecisionArtifactV1 {
	schema_version: 1;
	kind: "delegation-terminal-negative-repair-decision-v1";
	delegation_id: string;
	contract_hash: string;
	generation: number;
	transaction_revision: 3;
	terminal_status: DelegationTerminalNegativeStatusV1;
	parent_state_hash: string;
	generation_content_hash: string;
	base_review_hash: string;
	expected_bound_diff_hash: string;
	failure_facts_hash: string;
	decision: DelegationSemanticRepairDecisionV1;
	artifact_hash: string;
}

export interface DelegationTerminalNegativeReviewAuthorityV1 extends DelegationReviewAuthorityV2 {
	state: DelegationTransactionRecord & { status: DelegationTerminalNegativeStatusV1 };
	finalized: false;
	terminal_negative_repair?: DelegationTerminalNegativeRepairDecisionArtifactV1;
}

/** Structural seam consumed by strict exact-repair authority recovery. */
export interface DelegationTerminalNegativeSolAuthorityV1 {
	state: DelegationTransactionRecord;
	review_hash: string;
	bound_diff_hash: string;
	decision: DelegationSemanticRepairDecisionV1;
}

export interface PublishDelegationTerminalNegativeRepairDecisionV1Input extends DelegationCasInput {
	base_review_hash: string;
	expected_bound_diff_hash: string;
	repair_reason: string;
	reviewer: DelegationSemanticRepairReviewerV1;
}

export interface DelegationSemanticMigrationCandidateProjectionV1 {
	schema_version: 1;
	kind: "historical-semantic-migration-v1";
	old_git_head: string;
	candidate_git_head: string;
	head_delta_paths: string[];
	head_delta_hash: string;
	closed_content_hash: string;
	baseline_guard_hash: string;
	migration_binding_hash: string;
}

export interface DelegationSemanticMigrationPresenterV1 {
	provider: "openai" | "openai-codex";
	model: "gpt-5.6-sol";
}

interface DelegationSemanticMigrationBaseV1 {
	schema_version: 1;
	delegation_id: string;
	task_kind: "implementation";
	contract_hash: string;
	generation: number;
	base_transaction_revision: 4;
	base_review_hash: string;
	expected_bound_diff_hash: string;
	migration_projection: DelegationSemanticMigrationCandidateProjectionV1;
	presented_at: string;
	presenter: DelegationSemanticMigrationPresenterV1;
}

export interface DelegationSemanticMigrationPresentedV1 extends DelegationSemanticMigrationBaseV1 {
	status: "PRESENTED";
}

export interface DelegationSemanticMigrationAcceptedV1 extends DelegationSemanticMigrationBaseV1 {
	status: "ACCEPTED";
	acceptance: {
		decision: "ACCEPT";
		expected_bound_diff_hash: string;
		expected_migration_binding_hash: string;
		reviewer: DelegationSemanticMigrationPresenterV1;
		accepted_at: string;
	};
}

export type DelegationSemanticMigrationV1 =
	| DelegationSemanticMigrationPresentedV1
	| DelegationSemanticMigrationAcceptedV1;

export interface PublishDelegationSemanticMigrationPresentationV1Input {
	delegation_id: string;
	contract_hash: string;
	worker_identity: DelegationWorkerIdentity;
	expected_generation: number;
	expected_revision: 4;
	base_transaction_revision: 4;
	base_review_hash: string;
	expected_bound_diff_hash: string;
	migration_projection: DelegationSemanticMigrationCandidateProjectionV1;
	presenter: DelegationSemanticMigrationPresenterV1;
	now: string;
}

export interface AcceptDelegationSemanticMigrationV1Input {
	delegation_id: string;
	contract_hash: string;
	worker_identity: DelegationWorkerIdentity;
	expected_generation: number;
	expected_revision: 4;
	base_transaction_revision: 4;
	base_review_hash: string;
	expected_bound_diff_hash: string;
	expected_migration_binding_hash: string;
	migration_projection: DelegationSemanticMigrationCandidateProjectionV1;
	reviewer: DelegationSemanticMigrationPresenterV1;
	now: string;
}

export type HistoricalSemanticMigrationRecordV2 = DelegationSemanticMigrationV1;

export interface PublishHistoricalSemanticMigrationPresentationV2Input extends DelegationCasInput {
	base_review_hash: string;
	expected_bound_diff_hash: string;
	projection: DelegationSemanticMigrationCandidateProjectionV1;
	presenter: DelegationSemanticMigrationPresenterV1;
}

export interface PublishHistoricalSemanticMigrationAcceptanceV2Input extends DelegationCasInput {
	base_review_hash: string;
	expected_bound_diff_hash: string;
	expected_migration_binding_hash: string;
	projection: DelegationSemanticMigrationCandidateProjectionV1;
	reviewer: DelegationSemanticMigrationPresenterV1;
}

export interface HistoricalSemanticMigrationBindingV2Input {
	delegation_id: string;
	contract_hash: string;
	base_review_hash: string;
	expected_bound_diff_hash: string;
	projection: Omit<DelegationSemanticMigrationCandidateProjectionV1, "migration_binding_hash">;
}

/** Canonical hash formula shared by the collector and strict storage reader. */
export function computeHistoricalSemanticMigrationBindingHashV2(
	input: HistoricalSemanticMigrationBindingV2Input,
): string {
	return canonicalHash({
		schema_version: input.projection.schema_version,
		kind: input.projection.kind,
		delegation_id: input.delegation_id,
		contract_hash: input.contract_hash,
		base_review_hash: input.base_review_hash,
		expected_bound_diff_hash: input.expected_bound_diff_hash,
		old_git_head: input.projection.old_git_head,
		candidate_git_head: input.projection.candidate_git_head,
		head_delta_paths: input.projection.head_delta_paths,
		head_delta_hash: input.projection.head_delta_hash,
		closed_content_hash: input.projection.closed_content_hash,
		baseline_guard_hash: input.projection.baseline_guard_hash,
	});
}

interface DelegationLockOwner {
	schema_version: 1 | 2;
	delegation_id: string;
	token: string;
	process_id: number;
	process_start_ticks?: string | null;
	boot_id?: string | null;
	created_at: string;
}

interface HeldLock {
	path: string;
	token: string;
}

const LOCK_FIELDS_V1 = ["schema_version", "delegation_id", "token", "process_id", "created_at"] as const;
const LOCK_FIELDS_V2 = ["schema_version", "delegation_id", "token", "process_id", "process_start_ticks", "boot_id", "created_at"] as const;
const PROCESS_START_TICKS_RE = /^(0|[1-9]\d*)$/u;
const BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTITY_RECORD_FIELDS = [
	"schema_version", "delegation_id", "task_kind", "contract_hash", "generation", "revision", "worker_identity",
] as const;
const SCOPE_RECORD_FIELDS = [
	"schema_version", "delegation_id", "task_kind", "contract_hash", "allowed_paths", "changed_paths",
	"write_journal", "change_set",
] as const;
const SCOPE_RECORD_FIELDS_WITH_COMMAND = [...SCOPE_RECORD_FIELDS, "command_provenance"] as const;
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
const AFTER_WORKER_OUTCOME_FIELDS = ["worker_success", "worker_failure_code"] as const;
const AFTER_RECORD_FIELDS_GUARD_V2 = [...AFTER_RECORD_FIELDS, "diff_identity_kind"] as const;
const AFTER_RECORD_FIELDS_GUARD_V2_ENVELOPE = [...AFTER_RECORD_FIELDS_GUARD_V2, "review_envelope"] as const;
const AFTER_RECORD_FIELDS_GUARD_V2_COMMAND = [
	...AFTER_RECORD_FIELDS_GUARD_V2, "command_provenance_hash", "effective_delta_hash",
] as const;
const AFTER_RECORD_FIELDS_GUARD_V2_COMMAND_ENVELOPE = [...AFTER_RECORD_FIELDS_GUARD_V2_COMMAND, "review_envelope"] as const;
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
const REVIEW_PRESENTATION_FIELDS = [
	"fully_presented_paths", "presentation_remaining_paths", "presentation_complete",
] as const;
const REVIEW_PAGINATION_FIELDS = ["presentation_progress"] as const;
const REVIEW_SEMANTIC_FIELDS = ["semantic_review"] as const;
const REVIEW_SEMANTIC_ACCEPTANCE_FIELDS = ["semantic_acceptance"] as const;
const REVIEW_RECORD_FIELDS_WITH_PRESENTATION = [
	...REVIEW_RECORD_FIELDS, ...REVIEW_PRESENTATION_FIELDS, ...REVIEW_SEMANTIC_FIELDS,
] as const;
const REVIEW_RECORD_FIELDS_WITH_ACCEPTANCE = [
	...REVIEW_RECORD_FIELDS_WITH_PRESENTATION, ...REVIEW_SEMANTIC_ACCEPTANCE_FIELDS,
] as const;
const REVIEW_RECORD_FIELDS_RELEVANCE_V2 = [
	...REVIEW_RECORD_FIELDS, "diff_identity_kind", "relevance_binding", "relevance_projection",
] as const;
const REVIEW_RECORD_FIELDS_RELEVANCE_V2_WITH_PRESENTATION = [
	...REVIEW_RECORD_FIELDS_WITH_PRESENTATION, "diff_identity_kind", "relevance_binding", "relevance_projection",
] as const;
const REVIEW_RECORD_FIELDS_RELEVANCE_V2_WITH_ACCEPTANCE = [
	...REVIEW_RECORD_FIELDS_WITH_ACCEPTANCE, "diff_identity_kind", "relevance_binding", "relevance_projection",
] as const;
const SEMANTIC_MIGRATION_BASE_FIELDS = [
	"schema_version", "delegation_id", "task_kind", "contract_hash", "generation",
	"base_transaction_revision", "base_review_hash", "expected_bound_diff_hash",
	"migration_projection", "presented_at", "presenter", "status",
] as const;
const SEMANTIC_MIGRATION_ACCEPTED_FIELDS = [...SEMANTIC_MIGRATION_BASE_FIELDS, "acceptance"] as const;
const SEMANTIC_MIGRATION_PROJECTION_FIELDS = [
	"schema_version", "kind", "old_git_head", "candidate_git_head", "head_delta_paths",
	"head_delta_hash", "closed_content_hash", "baseline_guard_hash", "migration_binding_hash",
] as const;
const SEMANTIC_MIGRATION_ACCEPTANCE_FIELDS = [
	"decision", "expected_bound_diff_hash", "expected_migration_binding_hash", "reviewer", "accepted_at",
] as const;
const SEMANTIC_REPAIR_DECISION_FIELDS = [
	"schema_version", "delegation_id", "contract_hash", "generation", "transaction_revision",
	"generation_content_hash", "base_review_hash", "expected_bound_diff_hash", "decision", "repair_reason",
	"repair_reason_hash", "reviewer", "decided_at", "decision_hash",
] as const;
const TERMINAL_NEGATIVE_REPAIR_ARTIFACT_FIELDS = [
	"schema_version", "kind", "delegation_id", "contract_hash", "generation", "transaction_revision",
	"terminal_status", "parent_state_hash", "generation_content_hash", "base_review_hash",
	"expected_bound_diff_hash", "failure_facts_hash", "decision", "artifact_hash",
] as const;
const SOL_IDENTITY_FIELDS = ["provider", "model"] as const;

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

function effectiveDeltaPaths(
	changeSet: Readonly<ChangeSetRecord>,
	command: Readonly<DelegationCommandProvenanceRecord> | undefined,
): string[] {
	return command === undefined ? workerDeltaPaths(changeSet) : [...command.effective_paths];
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
	const hasPage = Object.prototype.hasOwnProperty.call(value, "page");
	if (hasCompact && hasPage) return false;
	if (!exactFields(value, [
		"path", "source", "text", "truncated",
		...(hasCompact ? ["compact"] : []),
		...(hasPage ? ["page"] : []),
	])) return false;
	if (!isStrictReviewPath(value.path) || !["git-diff", "file-content", "deleted", "compact", "withheld"].includes(String(value.source)) ||
		typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > REVIEW_PATCH_MAX_BYTES ||
		value.text.split("\n").length > REVIEW_PATCH_MAX_LINES || typeof value.truncated !== "boolean") return false;
	if ((value.source === "compact") !== hasCompact) return false;
	if (hasPage) {
		if (value.source !== "git-diff" && value.source !== "file-content") return false;
		const page = value.page;
		if (!isRecord(page) || !exactFields(page, ["stream_sha256", "start_byte", "end_byte", "total_bytes"]) ||
			typeof page.stream_sha256 !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(page.stream_sha256) ||
			!Number.isSafeInteger(page.start_byte) || Number(page.start_byte) < 0 ||
			!Number.isSafeInteger(page.end_byte) || Number(page.end_byte) <= Number(page.start_byte) ||
			!Number.isSafeInteger(page.total_bytes) || Number(page.total_bytes) < Number(page.end_byte) ||
			Number(page.total_bytes) > REVIEW_PAGE_SOURCE_MAX_BYTES ||
			Buffer.byteLength(value.text, "utf8") !== Number(page.end_byte) - Number(page.start_byte) ||
			Buffer.byteLength(value.text, "utf8") > REVIEW_PAGE_BODY_MAX_BYTES ||
			value.text.split("\n").length > REVIEW_PAGE_BODY_MAX_LINES ||
			value.truncated !== (Number(page.start_byte) > 0 || Number(page.end_byte) < Number(page.total_bytes))) return false;
		if (page.start_byte === 0 && page.end_byte === page.total_bytes &&
			createHash("sha256").update(value.text, "utf8").digest("hex") !== page.stream_sha256) return false;
	}
	if (!hasCompact) return true;
	const compact = value.compact;
	const hasContentKind = isRecord(compact) && Object.prototype.hasOwnProperty.call(compact, "content_kind");
	if (!isRecord(compact) || !exactFields(compact, [
		...(hasContentKind ? ["content_kind"] : []),
		"git_status", "size_bytes", "digest", "digest_kind", "digest_max_bytes", "digest_matches_after",
		"generator_equality", "head_preview", "tail_preview", "head_lines", "tail_lines", "head_partial_line",
		"tail_partial_line", "head_bytes", "tail_bytes", "content_truncated",
	])) return false;
	const commonValid = typeof compact.git_status === "string" && compact.git_status.length <= 4 &&
		Number.isSafeInteger(compact.size_bytes) && Number(compact.size_bytes) >= 0 &&
		typeof compact.digest === "string" && /^[a-f0-9]{64}(?::\d+)?$/.test(compact.digest) &&
		(compact.digest_kind === "sha256" || compact.digest_kind === "sha256-prefix+size") &&
		Number.isSafeInteger(compact.digest_max_bytes) && Number(compact.digest_max_bytes) > 0 &&
		typeof compact.digest_matches_after === "boolean" && compact.generator_equality === "NOT_VERIFIED" &&
		typeof compact.head_preview === "string" && typeof compact.tail_preview === "string" &&
		[compact.head_lines, compact.tail_lines, compact.head_bytes, compact.tail_bytes].every((item) => Number.isSafeInteger(item) && Number(item) >= 0) &&
		typeof compact.head_partial_line === "boolean" && typeof compact.tail_partial_line === "boolean" &&
		typeof compact.content_truncated === "boolean";
	if (!commonValid) return false;
	if (!hasContentKind) return true;
	return compact.content_kind === "binary" && compact.head_preview === '"(binary preview omitted)"' &&
		compact.tail_preview === '"(binary preview omitted)"' && compact.head_lines === 0 && compact.tail_lines === 0 &&
		compact.head_bytes === 0 && compact.tail_bytes === 0 && compact.head_partial_line === false &&
		compact.tail_partial_line === false && compact.content_truncated === (Number(compact.size_bytes) > 0);
}

function validReviewPresentationProgress(value: unknown): value is ReviewPresentationProgress[] {
	if (!Array.isArray(value) || value.length > REVIEW_PRESENTATION_PROGRESS_MAX_ITEMS) return false;
	let previous = "";
	for (const item of value) {
		if (!isRecord(item)) return false;
		const accumulated = Object.prototype.hasOwnProperty.call(item, "page_count") ||
			Object.prototype.hasOwnProperty.call(item, "receipt_sha256");
		if (!exactFields(item, accumulated
			? ["path", "source", "stream_sha256", "next_byte", "total_bytes", "segments", "page_count", "receipt_sha256"]
			: ["path", "source", "stream_sha256", "next_byte", "total_bytes", "segments"]) ||
			!isStrictReviewPath(item.path) || !["git-diff", "file-content", "deleted", "compact", "withheld"].includes(String(item.source)) ||
			typeof item.stream_sha256 !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(item.stream_sha256) ||
			!Number.isSafeInteger(item.next_byte) || Number(item.next_byte) < 0 ||
			!Number.isSafeInteger(item.total_bytes) || Number(item.total_bytes) < 0 ||
			Number(item.total_bytes) > REVIEW_PAGE_SOURCE_MAX_BYTES || Number(item.next_byte) > Number(item.total_bytes) ||
			(!["git-diff", "file-content"].includes(String(item.source)) && item.next_byte !== item.total_bytes) ||
			(previous !== "" && byteCompare(previous, item.path) >= 0)) return false;
		if (!Array.isArray(item.segments)) return false;
		if (accumulated) {
			if (!Number.isSafeInteger(item.page_count) || Number(item.page_count) < 0 ||
				Number(item.page_count) > Number(item.next_byte) ||
				typeof item.receipt_sha256 !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(item.receipt_sha256) ||
				item.segments.length > 1 || (Number(item.next_byte) === 0) !== (Number(item.page_count) === 0) ||
				(Number(item.next_byte) === 0) !== (item.segments.length === 0)) return false;
			const segment = item.segments[0];
			if (segment !== undefined && (!isRecord(segment) || !exactFields(segment, ["start_byte", "end_byte", "page_sha256"]) ||
				!Number.isSafeInteger(segment.start_byte) || Number(segment.start_byte) < 0 ||
				!Number.isSafeInteger(segment.end_byte) || Number(segment.end_byte) !== Number(item.next_byte) ||
				Number(segment.end_byte) <= Number(segment.start_byte) || Number(segment.end_byte) > Number(item.total_bytes) ||
				typeof segment.page_sha256 !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(segment.page_sha256))) return false;
		} else {
			if (item.segments.length > REVIEW_PRESENTATION_SEGMENT_MAX_ITEMS) return false;
			let segmentCursor = 0;
			for (const segment of item.segments) {
				if (!isRecord(segment) || !exactFields(segment, ["start_byte", "end_byte", "page_sha256"]) ||
					!Number.isSafeInteger(segment.start_byte) || Number(segment.start_byte) !== segmentCursor ||
					!Number.isSafeInteger(segment.end_byte) || Number(segment.end_byte) <= Number(segment.start_byte) ||
					Number(segment.end_byte) > Number(item.total_bytes) ||
					typeof segment.page_sha256 !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(segment.page_sha256)) return false;
				segmentCursor = Number(segment.end_byte);
			}
			if (segmentCursor !== item.next_byte || (item.total_bytes === 0 && item.segments.length !== 0) ||
				(Number(item.total_bytes) > 0 && Number(item.next_byte) > 0 && item.segments.length === 0)) return false;
		}
		previous = item.path;
	}
	return true;
}

function validReviewRecordForState(value: unknown, state: DelegationTransactionRecord): value is ReviewRecord {
	if (!isRecord(value)) return false;
	const relevanceV2 = value.schema_version === 2;
	const hasPresentation = REVIEW_PRESENTATION_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(value, field));
	const hasPartialPresentation = REVIEW_PRESENTATION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field)) && !hasPresentation;
	const hasPagination = REVIEW_PAGINATION_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(value, field));
	const hasSemantic = Object.prototype.hasOwnProperty.call(value, "semantic_review");
	const hasAcceptance = Object.prototype.hasOwnProperty.call(value, "semantic_acceptance");
	const hasEnvelope = Object.prototype.hasOwnProperty.call(value, "review_envelope");
	if (hasPartialPresentation || hasPresentation !== hasSemantic || (hasAcceptance && !hasSemantic) ||
		(hasPagination && !hasPresentation) || (hasEnvelope && !relevanceV2)) return false;
	const expectedFields: string[] = relevanceV2
		? [...(hasAcceptance ? REVIEW_RECORD_FIELDS_RELEVANCE_V2_WITH_ACCEPTANCE
			: hasPresentation ? REVIEW_RECORD_FIELDS_RELEVANCE_V2_WITH_PRESENTATION : REVIEW_RECORD_FIELDS_RELEVANCE_V2)]
		: [...(hasAcceptance ? REVIEW_RECORD_FIELDS_WITH_ACCEPTANCE
			: hasPresentation ? REVIEW_RECORD_FIELDS_WITH_PRESENTATION : REVIEW_RECORD_FIELDS)];
	if (hasPagination) expectedFields.push(...REVIEW_PAGINATION_FIELDS);
	if (hasEnvelope) expectedFields.push("review_envelope");
	const fieldsValid = exactFields(value, expectedFields);
	if (!fieldsValid) return false;
	if ((value.schema_version !== 1 && !relevanceV2) || value.delegation_id !== state.delegation_id || !isCanonicalTime(value.reviewed_at) ||
		(value.verdict !== "PASS" && value.verdict !== "FAIL") ||
		typeof value.bound_diff_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(value.bound_diff_hash) ||
		typeof value.recorded_after_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(value.recorded_after_hash) ||
		typeof value.mismatch !== "boolean" || value.mismatch !== (value.bound_diff_hash !== value.recorded_after_hash) ||
		typeof value.patch_truncated !== "boolean" || typeof value.coverage_complete !== "boolean") return false;
	if (!validReviewPaths(value.drift_paths) || !validReviewPaths(value.allowed_paths, 50) ||
		!validByteSortedPaths(value.checked_paths, 500) || !validReviewPaths(value.include_paths, 50) ||
		!validByteSortedPaths(value.displayed_paths, 500) || !validByteSortedPaths(value.remaining_paths, 500)) return false;
	if (hasPresentation && (
		!validByteSortedPaths(value.fully_presented_paths, 500)
		|| !validByteSortedPaths(value.presentation_remaining_paths, 500)
		|| typeof value.presentation_complete !== "boolean"
	)) return false;
	if (hasPagination && !validReviewPresentationProgress(value.presentation_progress)) return false;
	if (hasSemantic && !["required", "accepted", "not_required"].includes(String(value.semantic_review))) return false;
	if (hasAcceptance) {
		const acceptance = value.semantic_acceptance;
		if (!isRecord(acceptance) || !exactFields(acceptance, ["decision", "expected_bound_diff_hash", "reviewer", "accepted_at"]) ||
			acceptance.decision !== "ACCEPT" || acceptance.expected_bound_diff_hash !== value.bound_diff_hash ||
			!isCanonicalTime(acceptance.accepted_at) || acceptance.accepted_at !== value.reviewed_at || !isRecord(acceptance.reviewer) ||
			!exactFields(acceptance.reviewer, ["provider", "model"]) ||
			!(["openai", "openai-codex"] as unknown[]).includes(acceptance.reviewer.provider) ||
			acceptance.reviewer.model !== "gpt-5.6-sol") return false;
	}
	if (relevanceV2 && (value.diff_identity_kind !== REVIEW_RELEVANCE_KIND_V2 ||
		!validateReviewRelevanceBindingV2(value.relevance_binding) ||
		!validateReviewRelevanceProjectionV2(value.relevance_projection) ||
		value.relevance_binding.projection_hash !== computeReviewRelevanceProjectionHashV2(value.relevance_projection) ||
		value.bound_diff_hash !== value.relevance_binding.projection_hash ||
		value.relevance_projection.delegation_id !== state.delegation_id ||
		value.relevance_projection.contract_hash !== state.contract_hash)) return false;
	if (hasEnvelope && (!validateSemanticReviewEnvelopeV1(value.review_envelope) ||
		value.review_envelope.relevance_projection_hash !== (value.relevance_binding as { projection_hash: string }).projection_hash ||
		value.review_envelope.path_count !== (value.checked_paths as unknown[]).length)) return false;
	if (state.terminal_outcome === null) return false;
	const repairReviewPaths = delegationRepairReviewPathsV1(
		state.terminal_outcome.changed_paths,
		state.repair_lineage,
	);
	if (!sameJson(value.allowed_paths, state.allowed_paths) || repairReviewPaths === undefined ||
		(!sameJson(value.checked_paths, state.terminal_outcome.changed_paths) &&
			!sameJson(value.checked_paths, repairReviewPaths))) return false;
	if (!Array.isArray(value.violations) || value.violations.length > 10 || !value.violations.every((item) =>
		isRecord(item) && exactFields(item, ["path", "reason"]) && isStrictReviewPath(item.path) &&
		typeof item.reason === "string" && item.reason.length > 0 && item.reason.length <= 240)) return false;
	if ((value.verdict === "PASS") !== (value.violations.length === 0)) return false;
	if (!Array.isArray(value.patch) || value.patch.length > 50 || !value.patch.every(validReviewPatchEntry)) return false;
	if ((value.patch as ReviewPatchEntry[]).some((entry) => entry.page !== undefined) && !hasPagination) return false;
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
	if (hasPresentation) {
		const fullyPresented = value.fully_presented_paths as string[];
		const presentationRemaining = value.presentation_remaining_paths as string[];
		if (!fullyPresented.every((path) => checked.includes(path)) || !presentationRemaining.every((path) => checked.includes(path)) ||
			fullyPresented.some((path) => presentationRemaining.includes(path)) ||
			!samePathSetByte([...fullyPresented, ...presentationRemaining], checked) ||
			value.presentation_complete !== (presentationRemaining.length === 0)) return false;
		const compactEntries = (value.patch as ReviewPatchEntry[]).filter((entry) => entry.source === "compact");
		if (compactEntries.some((entry) => fullyPresented.includes(entry.path) && !isCompleteReviewPresentationEntry(entry))) return false;
		if (hasPagination) {
			const progress = value.presentation_progress as ReviewPresentationProgress[];
			const completedPaths = progress
				.filter((item) => item.next_byte === item.total_bytes)
				.map((item) => item.path);
			if (progress.some((item) => !checked.includes(item.path)) || !samePathSetByte(completedPaths, fullyPresented)) return false;
			for (const entry of value.patch as ReviewPatchEntry[]) {
				const item = progress.find((candidate) => candidate.path === entry.path);
				if (entry.page !== undefined) {
					if (item === undefined || item.source !== entry.source || item.stream_sha256 !== entry.page.stream_sha256 ||
						item.total_bytes !== entry.page.total_bytes || item.next_byte !== entry.page.end_byte) return false;
					const lastSegment = item.segments.at(-1);
					if (lastSegment === undefined || lastSegment.start_byte !== entry.page.start_byte ||
						lastSegment.end_byte !== entry.page.end_byte ||
						lastSegment.page_sha256 !== createHash("sha256").update(entry.text, "utf8").digest("hex")) return false;
					continue;
				}
				if (!isCompleteReviewPresentationEntry(entry)) continue;
				const bytes = Buffer.byteLength(entry.text, "utf8");
				const hash = createHash("sha256").update(entry.text, "utf8").digest("hex");
				if (item === undefined || item.source !== entry.source || item.stream_sha256 !== hash ||
					item.next_byte !== bytes || item.total_bytes !== bytes ||
					(bytes === 0 ? item.segments.length !== 0 : item.segments.length !== 1 ||
						item.segments[0]?.start_byte !== 0 || item.segments[0]?.end_byte !== bytes || item.segments[0]?.page_sha256 !== hash)) return false;
			}
		}
		if (checked.length === 0) {
			if (value.semantic_review !== "not_required" || hasAcceptance) return false;
		} else if ((value.semantic_review === "accepted") !== hasAcceptance || value.semantic_review === "not_required") {
			return false;
		}
	}
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

function validSolIdentity(value: unknown): value is DelegationSemanticMigrationPresenterV1 {
	return isRecord(value) && exactFields(value, SOL_IDENTITY_FIELDS) &&
		(value.provider === "openai" || value.provider === "openai-codex") && value.model === "gpt-5.6-sol";
}

function validGitObjectId(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value);
}

function validSemanticMigrationProjection(
	value: unknown,
	review: ReviewRecord,
): value is DelegationSemanticMigrationCandidateProjectionV1 {
	if (!isRecord(value) || !exactFields(value, SEMANTIC_MIGRATION_PROJECTION_FIELDS) ||
		value.schema_version !== 1 || value.kind !== "historical-semantic-migration-v1" ||
		!validGitObjectId(value.old_git_head) || !validGitObjectId(value.candidate_git_head) ||
		!validByteSortedPaths(value.head_delta_paths, 500) ||
		![value.head_delta_hash, value.closed_content_hash, value.baseline_guard_hash, value.migration_binding_hash]
			.every((hash) => typeof hash === "string" && DELEGATION_TRANSACTION_HASH_RE.test(hash))) return false;
	if (review.schema_version !== 2 || !validateReviewRelevanceProjectionV2(review.relevance_projection) ||
		review.relevance_projection.git_head !== value.old_git_head) return false;
	const headDeltaPaths = value.head_delta_paths as string[];
	return headDeltaPaths.length === review.checked_paths.length &&
		headDeltaPaths.every((path, index) => path === review.checked_paths[index]);
}

function historicalSemanticMigrationEligible(authority: DelegationReviewAuthorityV2): boolean {
	return authority.finalized && authority.state.status === "REVIEWED" && authority.state.revision === 4 &&
		authority.state.task_kind === "implementation" && authority.artifact.schema_version === 2 &&
		authority.review.schema_version === 2 && authority.review.checked_paths.length > 0 &&
		authority.review.semantic_acceptance === undefined && isScopeIntegrityPacketComplete(authority.review) &&
		!isStrictSemanticAcceptedOrZeroDelta(authority.review) &&
		validateReviewRelevanceProjectionV2(authority.review.relevance_projection);
}

function parseSemanticMigrationForAuthority(
	value: unknown,
	authority: DelegationReviewAuthorityV2,
): DelegationSemanticMigrationV1 | undefined {
	if (!historicalSemanticMigrationEligible(authority) || !isRecord(value) ||
		(value.status !== "PRESENTED" && value.status !== "ACCEPTED") ||
		!exactFields(value, value.status === "ACCEPTED" ? SEMANTIC_MIGRATION_ACCEPTED_FIELDS : SEMANTIC_MIGRATION_BASE_FIELDS) ||
		value.schema_version !== 1 || value.delegation_id !== authority.state.delegation_id ||
		value.task_kind !== "implementation" || value.contract_hash !== authority.state.contract_hash ||
		value.generation !== authority.state.generation || value.base_transaction_revision !== 4 ||
		value.base_transaction_revision !== authority.state.revision ||
		value.base_review_hash !== authority.review_hash || value.expected_bound_diff_hash !== authority.review.bound_diff_hash ||
		!DELEGATION_TRANSACTION_HASH_RE.test(String(value.base_review_hash)) ||
		!DELEGATION_TRANSACTION_HASH_RE.test(String(value.expected_bound_diff_hash)) ||
		!isCanonicalTime(value.presented_at) || !validSolIdentity(value.presenter) ||
		!validSemanticMigrationProjection(value.migration_projection, authority.review)) return undefined;
	if (value.migration_projection.migration_binding_hash !== computeHistoricalSemanticMigrationBindingHashV2({
		delegation_id: value.delegation_id as string,
		contract_hash: value.contract_hash as string,
		base_review_hash: value.base_review_hash as string,
		expected_bound_diff_hash: value.expected_bound_diff_hash as string,
		projection: value.migration_projection,
	})) return undefined;
	if (value.status === "ACCEPTED") {
		const acceptance = value.acceptance;
		if (!isRecord(acceptance) || !exactFields(acceptance, SEMANTIC_MIGRATION_ACCEPTANCE_FIELDS) ||
			acceptance.decision !== "ACCEPT" || acceptance.expected_bound_diff_hash !== value.expected_bound_diff_hash ||
			acceptance.expected_migration_binding_hash !== value.migration_projection.migration_binding_hash ||
			!DELEGATION_TRANSACTION_HASH_RE.test(String(acceptance.expected_bound_diff_hash)) ||
			!DELEGATION_TRANSACTION_HASH_RE.test(String(acceptance.expected_migration_binding_hash)) ||
			!validSolIdentity(acceptance.reviewer) || !isCanonicalTime(acceptance.accepted_at) ||
			Date.parse(acceptance.accepted_at as string) < Date.parse(value.presented_at as string)) return undefined;
	}
	return value as unknown as DelegationSemanticMigrationV1;
}

function encodeSemanticMigration(value: DelegationSemanticMigrationV1): Uint8Array | undefined {
	return encodeJson(value, DELEGATION_SEMANTIC_MIGRATION_MAX_BYTES);
}

function validSemanticRepairReason(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 1_024 &&
		value === value.trim() && !value.includes("\0");
}

function semanticRepairReasonHash(reason: string): string {
	return createHash("sha256").update(reason, "utf8").digest("hex");
}

function semanticRepairDecisionHash(
	decision: Omit<DelegationSemanticRepairDecisionV1, "decision_hash">,
): string {
	return canonicalHash(decision);
}

function semanticRepairDecisionEligible(authority: DelegationReviewAuthorityV2): boolean {
	return !authority.finalized && authority.state.status === "PENDING_REVIEW" && authority.state.revision === 3 &&
		authority.state.task_kind === "implementation" && authority.state.review === null &&
		authority.state.committed_proof !== null && authority.state.committed_proof.revision === 2 &&
		authority.artifact.schema_version === 2 && authority.artifact.transaction_revision === 3 &&
		authority.review.schema_version === 2 && authority.review.checked_paths.length > 0 &&
		authority.review.semantic_review === "required" && authority.review.semantic_acceptance === undefined &&
		isScopeIntegrityPacketComplete(authority.review);
}

function parseSemanticRepairDecisionForAuthority(
	value: unknown,
	authority: DelegationReviewAuthorityV2,
): DelegationSemanticRepairDecisionV1 | undefined {
	if (!semanticRepairDecisionEligible(authority) || !isRecord(value) ||
		!exactFields(value, SEMANTIC_REPAIR_DECISION_FIELDS) || value.schema_version !== 1 ||
		value.delegation_id !== authority.state.delegation_id || value.contract_hash !== authority.state.contract_hash ||
		value.generation !== authority.state.generation || value.transaction_revision !== 3 ||
		value.generation_content_hash !== authority.state.committed_proof?.content_hash ||
		value.base_review_hash !== authority.review_hash ||
		value.expected_bound_diff_hash !== authority.review.bound_diff_hash || value.decision !== "REPAIR" ||
		![value.generation_content_hash, value.base_review_hash, value.expected_bound_diff_hash,
			value.repair_reason_hash, value.decision_hash].every((hash) =>
			typeof hash === "string" && DELEGATION_TRANSACTION_HASH_RE.test(hash)) ||
		!validSemanticRepairReason(value.repair_reason) ||
		value.repair_reason_hash !== semanticRepairReasonHash(value.repair_reason) ||
		!validSolIdentity(value.reviewer) || !isCanonicalTime(value.decided_at) ||
		Date.parse(value.decided_at) < Date.parse(authority.review.reviewed_at)) return undefined;
	const { decision_hash: suppliedDecisionHash, ...decisionPayload } = value;
	if (suppliedDecisionHash !== semanticRepairDecisionHash(
		decisionPayload as Omit<DelegationSemanticRepairDecisionV1, "decision_hash">,
	)) return undefined;
	return value as unknown as DelegationSemanticRepairDecisionV1;
}

function encodeSemanticRepairDecision(value: DelegationSemanticRepairDecisionV1): Uint8Array | undefined {
	return encodeJson(value, DELEGATION_SEMANTIC_REPAIR_DECISION_MAX_BYTES);
}

function semanticEvidenceV2Eligible(authority: DelegationReviewAuthorityV2): boolean {
	return authority.state.task_kind === "implementation" && authority.state.committed_proof !== null
		&& authority.artifact.schema_version === 2 && authority.review.schema_version === 2
		&& authority.review.semantic_review === "required" && authority.review.semantic_acceptance === undefined
		&& authority.review.relevance_binding !== undefined && authority.review.relevance_projection !== undefined
		&& authority.review.review_envelope !== undefined && validateSemanticReviewEnvelopeV1(authority.review.review_envelope)
		&& isScopeIntegrityPacketComplete(authority.review)
		&& ((authority.state.status === "PENDING_REVIEW" && authority.state.revision === 3 && !authority.finalized)
			|| (authority.state.status === "REVIEWED" && authority.state.revision === 4 && authority.finalized));
}

function parseSemanticReviewEvidenceV2ForAuthority(
	value: unknown,
	authority: DelegationReviewAuthorityV2,
): SemanticReviewEvidenceV2 | undefined {
	if (!semanticEvidenceV2Eligible(authority) || !validateSemanticReviewEvidenceV2(value)) return undefined;
	const envelope = authority.review.review_envelope!;
	if (!verifySemanticReviewEvidenceBindingV2(value, {
		delegation_id: authority.state.delegation_id,
		generation: authority.state.generation,
		generation_content_hash: authority.state.committed_proof!.content_hash,
		contract_hash: authority.state.contract_hash,
		bound_diff_hash: authority.review.bound_diff_hash,
		relevance_projection_hash: authority.review.relevance_binding!.projection_hash,
		review_envelope_hash: canonicalHash(envelope),
		review_policy_hash: value.review_policy_hash,
		model_identity: value.model_identity,
		runtime_build_identity: value.runtime_build_identity,
		stream_set_hash: envelope.stream_set_hash,
		parent_evidence_hash: value.parent_evidence_hash,
	})) return undefined;
	if (Date.parse(value.completed_at) < Date.parse(authority.artifact.reviewed_at)
		|| value.cross_file_assessment.affected_paths.some((path) => !value.streams.some((stream) => stream.path === path))) return undefined;
	if (value.final_decision === "ACCEPT") {
		if (authority.state.status !== "PENDING_REVIEW" && authority.state.status !== "REVIEWED") return undefined;
	} else if (authority.state.status !== "PENDING_REVIEW" || authority.finalized) return undefined;
	return value;
}

function encodeSemanticReviewEvidenceV2(value: SemanticReviewEvidenceV2): Uint8Array | undefined {
	return encodeJson(value, DELEGATION_SEMANTIC_REVIEW_EVIDENCE_V2_MAX_BYTES);
}

function semanticRepairProjectionFromEvidenceV2(
	authority: DelegationReviewAuthorityV2,
	evidence: SemanticReviewEvidenceV2,
): DelegationSemanticRepairDecisionV1 | undefined {
	if (evidence.final_decision !== "REPAIR" || evidence.repair_reason === null) return undefined;
	const payload: Omit<DelegationSemanticRepairDecisionV1, "decision_hash"> = {
		schema_version: 1,
		delegation_id: evidence.delegation_id,
		contract_hash: evidence.contract_hash,
		generation: evidence.generation,
		transaction_revision: 3,
		generation_content_hash: evidence.generation_content_hash,
		base_review_hash: authority.review_hash,
		expected_bound_diff_hash: evidence.bound_diff_hash,
		decision: "REPAIR",
		repair_reason: evidence.repair_reason,
		repair_reason_hash: semanticRepairReasonHash(evidence.repair_reason),
		reviewer: { provider: "openai-codex", model: "gpt-5.6-sol" },
		decided_at: evidence.completed_at,
	};
	const projected = { ...payload, decision_hash: semanticRepairDecisionHash(payload) };
	return parseSemanticRepairDecisionForAuthority(projected, authority);
}

function isDelegationTerminalNegativeReviewStateCandidateV1(
	state: Readonly<DelegationTransactionRecord>,
): state is DelegationTransactionRecord & { status: DelegationTerminalNegativeStatusV1 } {
	const outcome = state.terminal_outcome;
	return state.task_kind === "implementation"
		&& (state.status === "INTERRUPTED" || state.status === "FAILED")
		&& state.revision === 3 && state.committed_proof !== null && state.committed_proof.revision === 2
		&& state.review === null && outcome !== null && outcome.terminal_facts_complete === true
		&& outcome.scope_complete === true
		&& outcome.changed_paths.length > 0 && outcome.delta_hash !== null
		&& outcome.changed_paths.every((path) => delegationPathAllowedV2(path, state.allowed_paths));
}

export function isDelegationTerminalNegativeReviewEligibleV1(
	state: Readonly<DelegationTransactionRecord>,
): state is DelegationTransactionRecord & { status: DelegationTerminalNegativeStatusV1 } {
	return isDelegationTerminalNegativeReviewStateCandidateV1(state)
		&& state.terminal_outcome!.change_set_status === "ATTRIBUTED";
}

/**
 * Strict read compatibility for historical committed negative lifecycles.
 * This predicate grants only terminal-negative REPAIR review, never ACCEPT.
 * Every generation record must revalidate and the worker delta must remain
 * non-empty, exact-file scoped, and bound to the immutable terminal outcome.
 * Command drift/conflicts remain negative evidence and are carried into the
 * successor review scope by exact-repair recovery.
 */
export function isDelegationTerminalNegativeReviewEligibleFromCommittedV1(
	state: Readonly<DelegationTransactionRecord>,
	records: DelegationCommittedRecords,
): state is DelegationTransactionRecord & { status: DelegationTerminalNegativeStatusV1 } {
	if (isDelegationTerminalNegativeReviewEligibleV1(state)) return true;
	return isDelegationTerminalNegativeReviewStateCandidateV1(state)
		&& validateCommittedRecordBindings(state, records, true);
}

function terminalNegativeFailureFactsHash(state: Readonly<DelegationTransactionRecord>): string {
	return canonicalHash({
		schema_version: 1,
		kind: "delegation-terminal-negative-failure-facts-v1",
		status: state.status,
		postcondition_reasons: state.postcondition_reasons,
		terminal_outcome: state.terminal_outcome,
	});
}

function terminalNegativeDecisionEligible(authority: DelegationReviewAuthorityV2): authority is DelegationTerminalNegativeReviewAuthorityV1 {
	return (isDelegationTerminalNegativeReviewEligibleV1(authority.state)
		|| authority.terminal_negative_committed_compatibility === true) && !authority.finalized
		&& authority.artifact.schema_version === 2 && authority.artifact.transaction_revision === 3
		&& authority.review.schema_version === 2 && authority.review.checked_paths.length > 0
		&& authority.review.verdict === "PASS" && authority.review.mismatch === false
		&& authority.review.drift_paths.length === 0 && authority.review.violations.length === 0
		&& authority.review.semantic_review === "required" && authority.review.semantic_acceptance === undefined
		&& isScopeIntegrityPacketComplete(authority.review);
}

function terminalNegativeArtifactProjection(
	artifact: Omit<DelegationTerminalNegativeRepairDecisionArtifactV1, "artifact_hash">
		| DelegationTerminalNegativeRepairDecisionArtifactV1,
): Omit<DelegationTerminalNegativeRepairDecisionArtifactV1, "artifact_hash"> {
	const { artifact_hash: _artifactHash, ...projection } = artifact as DelegationTerminalNegativeRepairDecisionArtifactV1;
	return projection;
}

function parseTerminalNegativeRepairArtifactForAuthority(
	value: unknown,
	authority: DelegationReviewAuthorityV2,
): DelegationTerminalNegativeRepairDecisionArtifactV1 | undefined {
	if (!terminalNegativeDecisionEligible(authority) || !isRecord(value)
		|| !exactFields(value, TERMINAL_NEGATIVE_REPAIR_ARTIFACT_FIELDS)
		|| value.schema_version !== 1 || value.kind !== "delegation-terminal-negative-repair-decision-v1"
		|| value.delegation_id !== authority.state.delegation_id || value.contract_hash !== authority.state.contract_hash
		|| value.generation !== authority.state.generation || value.transaction_revision !== authority.state.revision
		|| value.terminal_status !== authority.state.status
		|| value.parent_state_hash !== canonicalHash(authority.state)
		|| value.generation_content_hash !== authority.state.committed_proof?.content_hash
		|| value.base_review_hash !== authority.review_hash
		|| value.expected_bound_diff_hash !== authority.review.bound_diff_hash
		|| value.failure_facts_hash !== terminalNegativeFailureFactsHash(authority.state)
		|| ![value.parent_state_hash, value.generation_content_hash, value.base_review_hash,
			value.expected_bound_diff_hash, value.failure_facts_hash, value.artifact_hash]
			.every((hash) => typeof hash === "string" && DELEGATION_TRANSACTION_HASH_RE.test(hash))) return undefined;
	const decision = value.decision;
	if (!isRecord(decision) || !exactFields(decision, SEMANTIC_REPAIR_DECISION_FIELDS)
		|| decision.schema_version !== 1 || decision.decision !== "REPAIR"
		|| decision.delegation_id !== authority.state.delegation_id || decision.contract_hash !== authority.state.contract_hash
		|| decision.generation !== authority.state.generation || decision.transaction_revision !== authority.state.revision
		|| decision.generation_content_hash !== value.generation_content_hash
		|| decision.base_review_hash !== value.base_review_hash
		|| decision.expected_bound_diff_hash !== value.expected_bound_diff_hash
		|| !validSemanticRepairReason(decision.repair_reason)
		|| decision.repair_reason_hash !== semanticRepairReasonHash(decision.repair_reason)
		|| !validSolIdentity(decision.reviewer) || !isCanonicalTime(decision.decided_at)
		|| Date.parse(decision.decided_at) < Date.parse(authority.review.reviewed_at)
		|| Date.parse(decision.decided_at) < Date.parse(authority.state.updated_at)) return undefined;
	const { decision_hash: suppliedDecisionHash, ...decisionPayload } = decision;
	if (typeof suppliedDecisionHash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(suppliedDecisionHash)
		|| suppliedDecisionHash !== semanticRepairDecisionHash(
			decisionPayload as Omit<DelegationSemanticRepairDecisionV1, "decision_hash">,
		)) return undefined;
	const parsed = value as unknown as DelegationTerminalNegativeRepairDecisionArtifactV1;
	return parsed.artifact_hash === canonicalHash(terminalNegativeArtifactProjection(parsed)) ? parsed : undefined;
}

function encodeTerminalNegativeRepairArtifact(
	value: DelegationTerminalNegativeRepairDecisionArtifactV1,
): Uint8Array | undefined {
	return encodeJson(value, DELEGATION_TERMINAL_NEGATIVE_REPAIR_DECISION_MAX_BYTES);
}

function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function delegationReviewRelativePathV2(delegationId: string): string | undefined {
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId)) return undefined;
	return posix.join(CONFIG_DIR_NAME, "workbench", "delegations", delegationId, "v2", REVIEW_FILE);
}

export function delegationSemanticReviewEvidenceRelativePathV2(delegationId: string): string | undefined {
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId)) return undefined;
	return posix.join(CONFIG_DIR_NAME, "workbench", "delegations", delegationId, "v2", SEMANTIC_REVIEW_EVIDENCE_V2_FILE);
}

export function delegationSemanticReviewProgressRelativePathV2(delegationId: string): string | undefined {
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId)) return undefined;
	return posix.join(CONFIG_DIR_NAME, "workbench", "delegations", delegationId, "v2", SEMANTIC_REVIEW_PROGRESS_V2_FILE);
}

export function delegationWorkerCheckpointRelativePathV1(delegationId: string): string | undefined {
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId)) return undefined;
	return posix.join(CONFIG_DIR_NAME, "workbench", "delegations", delegationId, "v2", WORKER_CHECKPOINT_V1_FILE);
}

export function delegationSemanticMigrationRelativePathV1(delegationId: string): string | undefined {
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId)) return undefined;
	return posix.join(CONFIG_DIR_NAME, "workbench", "delegations", delegationId, "v2", SEMANTIC_MIGRATION_FILE);
}

export function delegationSemanticRepairDecisionRelativePathV1(delegationId: string): string | undefined {
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId)) return undefined;
	return posix.join(CONFIG_DIR_NAME, "workbench", "delegations", delegationId, "v2", SEMANTIC_REPAIR_DECISION_FILE);
}

export function delegationTerminalNegativeRepairDecisionRelativePathV1(delegationId: string): string | undefined {
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId)) return undefined;
	return posix.join(CONFIG_DIR_NAME, "workbench", "delegations", delegationId, "v2", TERMINAL_NEGATIVE_REPAIR_DECISION_FILE);
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
	semanticEvidenceV2: string;
	semanticProgressV2: string;
	workerCheckpointV1: string;
	semanticMigration: string;
	semanticRepair: string;
	terminalNegativeRepair: string;
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
		semanticEvidenceV2: join(v2, SEMANTIC_REVIEW_EVIDENCE_V2_FILE),
		semanticProgressV2: join(v2, SEMANTIC_REVIEW_PROGRESS_V2_FILE),
		workerCheckpointV1: join(v2, WORKER_CHECKPOINT_V1_FILE),
		semanticMigration: join(v2, SEMANTIC_MIGRATION_FILE),
		semanticRepair: join(v2, SEMANTIC_REPAIR_DECISION_FILE),
		terminalNegativeRepair: join(v2, TERMINAL_NEGATIVE_REPAIR_DECISION_FILE),
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
	if (!isRecord(raw) || (raw.schema_version === 1
		? !exactFields(raw, LOCK_FIELDS_V1)
		: raw.schema_version === 2 ? !exactFields(raw, LOCK_FIELDS_V2) : true)) return undefined;
	if ((raw.schema_version !== 1 && raw.schema_version !== 2) || raw.delegation_id !== delegationId) return undefined;
	if (typeof raw.token !== "string" || !/^[a-f0-9]{32}$/.test(raw.token)) return undefined;
	if (!Number.isSafeInteger(raw.process_id) || Number(raw.process_id) <= 0 || !isCanonicalTime(raw.created_at)) return undefined;
	if (raw.schema_version === 2 &&
		!(raw.process_start_ticks === null || (typeof raw.process_start_ticks === "string" && PROCESS_START_TICKS_RE.test(raw.process_start_ticks)))) return undefined;
	if (raw.schema_version === 2 &&
		!(raw.boot_id === null || (typeof raw.boot_id === "string" && BOOT_ID_RE.test(raw.boot_id)))) return undefined;
	return raw as unknown as DelegationLockOwner;
}

async function readLockBootId(adapter: DelegationTransactionStorageAdapter): Promise<string | null> {
	try {
		const value = await (adapter.readBootId ?? nodeReadBootId)();
		return value !== null && BOOT_ID_RE.test(value) ? value : null;
	} catch {
		return null;
	}
}

async function readLockProcessStartTicks(adapter: DelegationTransactionStorageAdapter, processId: number): Promise<string | null> {
	try {
		const value = await (adapter.readProcessStartTicks ?? nodeReadProcessStartTicks)(processId);
		return value !== null && PROCESS_START_TICKS_RE.test(value) ? value : null;
	} catch {
		return null;
	}
}

async function lockOwnerIsLive(owner: DelegationLockOwner, adapter: DelegationTransactionStorageAdapter): Promise<boolean> {
	if (!adapter.isProcessAlive(owner.process_id)) return false;
	// Historical v1 owners contain no process-incarnation facts. They retain
	// the prior conservative PID-only behavior while every newly written v2
	// lock is protected against PID reuse and reboot.
	if (owner.schema_version === 1) return true;
	if (owner.boot_id !== null) {
		const currentBoot = await readLockBootId(adapter);
		if (currentBoot === null) return true;
		if (currentBoot !== owner.boot_id) return false;
	}
	if (owner.process_start_ticks !== null) {
		const currentStart = await readLockProcessStartTicks(adapter, owner.process_id);
		if (currentStart === null) return true;
		if (currentStart !== owner.process_start_ticks) return false;
	}
	return true;
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
	const ownerBootId = await readLockBootId(adapter);
	const ownerProcessStartTicks = await readLockProcessStartTicks(adapter, adapter.processId);
	for (let attempt = 0; attempt <= DELEGATION_TRANSACTION_LOCK_RECOVERY_ATTEMPTS; attempt += 1) {
		const token = storageToken(adapter);
		if (token === undefined) return failure("storage_failure", "storage random token is invalid", "lock.acquire");
		const owner: DelegationLockOwner = {
			schema_version: 2,
			delegation_id: delegationId,
			token,
			process_id: adapter.processId,
			process_start_ticks: ownerProcessStartTicks,
			boot_id: ownerBootId,
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
			if (parsed === undefined || parsed.token !== token || parsed.process_id !== adapter.processId ||
				parsed.process_start_ticks !== ownerProcessStartTicks || parsed.boot_id !== ownerBootId) {
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
		if (existing !== undefined && await lockOwnerIsLive(existing, adapter)) {
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
	const repairReviewPaths = delegationRepairReviewPathsV1(
		state.terminal_outcome.changed_paths,
		state.repair_lineage,
	);
	const envelope = after.review_envelope;
	const checkedPathsBindEnvelope = repairReviewPaths !== undefined && isRecord(envelope) &&
		validateSemanticReviewEnvelopeV1(envelope)
		? (envelope.path_count === repairReviewPaths.length
			? sameJson(artifact.review.checked_paths, repairReviewPaths)
			: envelope.path_count === state.terminal_outcome.changed_paths.length &&
				sameJson(artifact.review.checked_paths, state.terminal_outcome.changed_paths))
		: repairReviewPaths !== undefined &&
			(sameJson(artifact.review.checked_paths, state.terminal_outcome.changed_paths) ||
				sameJson(artifact.review.checked_paths, repairReviewPaths));
	const base = typeof after.diff_hash === "string" && DELEGATION_TRANSACTION_HASH_RE.test(after.diff_hash) &&
		validByteSortedPaths(after.changed_paths, 500) &&
		sameJson(after.changed_paths, state.terminal_outcome.changed_paths) &&
		artifact.review.recorded_after_hash === (tagged ? artifact.review.bound_diff_hash : after.diff_hash) &&
		checkedPathsBindEnvelope &&
		validateScopeRecord(scope, state) &&
		sameJson(artifact.review.allowed_paths, scope.allowed_paths);
	if (!base || !tagged) return base;
	const review = artifact.review;
	const changeSet = scope.change_set;
	if (!isRecord(changeSet) || !validateChangeSet(changeSet) || review.relevance_projection === undefined ||
		review.relevance_binding === undefined) return false;
	const projection = review.relevance_projection;
	const command = Object.prototype.hasOwnProperty.call(scope, "command_provenance")
		? scope.command_provenance as DelegationCommandProvenanceRecord
		: undefined;
	if (command !== undefined && !validateDelegationCommandProvenance(command, changeSet)) return false;
	const effective = projection.entries.filter((entry) => entry.roles.includes("W") || entry.roles.includes("C"))
		.map((entry) => entry.path);
	const dependencies = projection.entries.filter((entry) => entry.roles.includes("D")).map((entry) => entry.path);
	return projection.change_set_hash === changeSet.change_set_hash && projection.worker_delta_hash === changeSet.worker_delta_hash &&
		projection.command_provenance_hash === command?.command_provenance_hash &&
		projection.git_head === after.git_head && sameJson(effective, after.changed_paths) &&
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
		let terminalNegativeCommittedCompatibility = false;
		if (state.status === "PENDING_REVIEW") {
			if (state.revision !== 3 || state.review !== null) return failure("invalid_record", "pending review state is inconsistent", point);
		} else if (state.status === "INTERRUPTED" || state.status === "FAILED") {
			if (!isDelegationTerminalNegativeReviewEligibleFromCommittedV1(state, records)) {
				return failure("invalid_record", "terminal-negative review state is ineligible or incomplete", point);
			}
			terminalNegativeCommittedCompatibility = !isDelegationTerminalNegativeReviewEligibleV1(state);
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
				...(terminalNegativeCommittedCompatibility ? { terminal_negative_committed_compatibility: true as const } : {}),
				bytes: Uint8Array.from(bytes),
			},
		};
	} catch (error) {
		return isErrno(error, "ENOENT")
			? failure("not_found", "delegation v2 review artifact does not exist", point)
			: failure("storage_failure", "delegation v2 review artifact read failed", point);
	}
}

async function readSemanticReviewEvidenceV2At(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	authority: DelegationReviewAuthorityV2,
	adapter: DelegationTransactionStorageAdapter,
	point?: "semantic_evidence_v2.temp.read" | "semantic_evidence_v2.final.read",
): Promise<DelegationTransactionStorageResult<SemanticReviewEvidenceV2 | undefined>> {
	try {
		const stat = await adapter.inspect(paths.semanticEvidenceV2);
		if (stat.kind !== "file" || stat.size > DELEGATION_SEMANTIC_REVIEW_EVIDENCE_V2_MAX_BYTES) {
			return failure("invalid_record", "semantic review evidence v2 path is unsafe or oversized", point);
		}
		const bytes = point === undefined
			? await adapter.readBounded(paths.semanticEvidenceV2, DELEGATION_SEMANTIC_REVIEW_EVIDENCE_V2_MAX_BYTES)
			: await readBytesAtPoint(adapter, paths.semanticEvidenceV2, DELEGATION_SEMANTIC_REVIEW_EVIDENCE_V2_MAX_BYTES, point);
		const parsed = parseSemanticReviewEvidenceV2ForAuthority(decodeJson(bytes), authority);
		const canonical = parsed === undefined ? undefined : encodeSemanticReviewEvidenceV2(parsed);
		if (parsed === undefined || canonical === undefined || !Buffer.from(canonical).equals(Buffer.from(bytes))) {
			return failure("invalid_record", "semantic review evidence v2 is corrupt, non-canonical, or unbound", point);
		}
		return { ok: true, value: parsed };
	} catch (error) {
		return isErrno(error, "ENOENT")
			? { ok: true, value: undefined }
			: failure("storage_failure", "semantic review evidence v2 read failed", point);
	}
}

function encodeSemanticReviewProgressV2(value: SemanticReviewProgressV2): Uint8Array | undefined {
	return validateSemanticReviewProgressV2(value)
		? encodeJson(value, DELEGATION_SEMANTIC_REVIEW_PROGRESS_V2_MAX_BYTES)
		: undefined;
}

async function readSemanticReviewProgressV2At(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	delegationId: string,
	adapter: DelegationTransactionStorageAdapter,
): Promise<DelegationTransactionStorageResult<SemanticReviewProgressV2 | undefined>> {
	try {
		const stat = await adapter.inspect(paths.semanticProgressV2);
		if (stat.kind !== "file" || stat.size > DELEGATION_SEMANTIC_REVIEW_PROGRESS_V2_MAX_BYTES) {
			return failure("invalid_record", "semantic review progress v2 path is unsafe or oversized");
		}
		const bytes = await adapter.readBounded(paths.semanticProgressV2, DELEGATION_SEMANTIC_REVIEW_PROGRESS_V2_MAX_BYTES);
		const value = decodeJson(bytes);
		if (!validateSemanticReviewProgressV2(value)) {
			return failure("invalid_record", "semantic review progress v2 is corrupt, non-canonical, or unbound");
		}
		const canonical = encodeSemanticReviewProgressV2(value);
		if (canonical === undefined || !Buffer.from(canonical).equals(Buffer.from(bytes)) || value.delegation_id !== delegationId) {
			return failure("invalid_record", "semantic review progress v2 is corrupt, non-canonical, or unbound");
		}
		return { ok: true, value };
	} catch (error) {
		return isErrno(error, "ENOENT")
			? { ok: true, value: undefined }
			: failure("storage_failure", "semantic review progress v2 read failed");
	}
}

function progressCanAdvanceV2(
	prior: Readonly<SemanticReviewProgressV2> | undefined,
	next: Readonly<SemanticReviewProgressV2>,
): boolean {
	if (prior === undefined) return true;
	if (prior.review_job_id !== next.review_job_id || prior.delegation_id !== next.delegation_id
		|| prior.generation !== next.generation || prior.input_identity_hash !== next.input_identity_hash
		|| prior.review_policy_hash !== next.review_policy_hash || prior.batches.length !== next.batches.length) return false;
	if (prior.status === "COMPLETED") return prior.progress_hash === next.progress_hash;
	if (next.cumulative_usage.totalTokens < prior.cumulative_usage.totalTokens) return false;
	return prior.batches.every((batch, index) => batch.status !== "COMPLETED"
		|| next.batches[index]?.status === "COMPLETED" && next.batches[index]?.batch_hash === batch.batch_hash);
}

async function writeSemanticReviewProgressV2Locked(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	progress: SemanticReviewProgressV2,
	adapter: DelegationTransactionStorageAdapter,
): Promise<DelegationTransactionStorageResult<SemanticReviewProgressV2>> {
	const encoded = encodeSemanticReviewProgressV2(progress);
	if (encoded === undefined) return failure("invalid_input", "semantic review progress v2 is invalid or oversized");
	const existing = await readSemanticReviewProgressV2At(paths, progress.delegation_id, adapter);
	if (!existing.ok) return existing;
	if (existing.value?.progress_hash === progress.progress_hash) return { ok: true, value: existing.value };
	if (!progressCanAdvanceV2(existing.value, progress)) {
		return failure("conflict", "semantic review progress v2 identity or monotonicity check failed");
	}
	const token = storageToken(adapter);
	if (token === undefined) return failure("storage_failure", "storage random token is invalid", "semantic_progress_v2.write.before");
	const temp = join(paths.v2, `.semantic-review-progress-v2.${token}.tmp`);
	try {
		await invokeFault(adapter, "semantic_progress_v2.write.before");
		await adapter.write(temp, encoded, true);
		const tempBytes = await adapter.readBounded(temp, DELEGATION_SEMANTIC_REVIEW_PROGRESS_V2_MAX_BYTES);
		if (!Buffer.from(tempBytes).equals(Buffer.from(encoded))) throw new Error("progress temp readback mismatch");
		await invokeFault(adapter, "semantic_progress_v2.rename.before");
		await adapter.move(temp, paths.semanticProgressV2);
		await invokeFault(adapter, "semantic_progress_v2.rename.after");
		await invokeFault(adapter, "semantic_progress_v2.readback.before");
		const readback = await readSemanticReviewProgressV2At(paths, progress.delegation_id, adapter);
		await invokeFault(adapter, "semantic_progress_v2.readback.after");
		if (!readback.ok || readback.value?.progress_hash !== progress.progress_hash) throw new Error("progress final readback mismatch");
		return { ok: true, value: readback.value };
	} catch {
		return failure("storage_failure", "semantic review progress v2 atomic publish failed");
	}
}

function encodeWorkerCheckpointV1(value: WorkerCheckpointV1): Uint8Array | undefined {
	return validateWorkerCheckpointV1(value) ? encodeJson(value, DELEGATION_WORKER_CHECKPOINT_V1_MAX_BYTES) : undefined;
}

async function readWorkerCheckpointV1At(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	delegationId: string,
	contractHash: string,
	adapter: DelegationTransactionStorageAdapter,
	point?: "worker_checkpoint_v1.temp.read" | "worker_checkpoint_v1.final.read",
): Promise<DelegationTransactionStorageResult<WorkerCheckpointV1 | undefined>> {
	try {
		const stat = await adapter.inspect(paths.workerCheckpointV1);
		if (stat.kind !== "file" || stat.size > DELEGATION_WORKER_CHECKPOINT_V1_MAX_BYTES) {
			return failure("invalid_record", "worker checkpoint path is unsafe or oversized", point);
		}
		const bytes = point === undefined
			? await adapter.readBounded(paths.workerCheckpointV1, DELEGATION_WORKER_CHECKPOINT_V1_MAX_BYTES)
			: await readBytesAtPoint(adapter, paths.workerCheckpointV1, DELEGATION_WORKER_CHECKPOINT_V1_MAX_BYTES, point);
		const value = decodeJson(bytes);
		if (!validateWorkerCheckpointV1(value)) return failure("invalid_record", "worker checkpoint is corrupt or non-canonical", point);
		const canonical = encodeWorkerCheckpointV1(value);
		if (canonical === undefined || !Buffer.from(canonical).equals(Buffer.from(bytes))
			|| value.delegation_id !== delegationId || value.contract_hash !== contractHash) {
			return failure("invalid_record", "worker checkpoint is unbound", point);
		}
		return { ok: true, value };
	} catch (error) {
		return isErrno(error, "ENOENT") ? { ok: true, value: undefined }
			: failure("storage_failure", "worker checkpoint read failed", point);
	}
}

function workerCheckpointCanAdvanceV1(prior: WorkerCheckpointV1 | undefined, next: WorkerCheckpointV1): boolean {
	if (prior === undefined) return next.attempt === 1 && next.parent_checkpoint_hash === null;
	if (prior.checkpoint_hash === next.checkpoint_hash) return true;
	if (prior.machine_state === "PAUSED_BUDGET" || next.attempt !== prior.attempt + 1
		|| next.parent_checkpoint_hash !== prior.checkpoint_hash || next.delegation_id !== prior.delegation_id
		|| next.contract_hash !== prior.contract_hash || next.runtime_build_identity !== prior.runtime_build_identity
		|| next.before_binding_hash !== prior.before_binding_hash || next.cumulative_turns < prior.cumulative_turns
		|| next.cumulative_usage.totalTokens < prior.cumulative_usage.totalTokens
		|| next.cumulative_usage.output < prior.cumulative_usage.output
		|| (prior.remaining_budget.profile === "extended" && next.remaining_budget.profile !== "extended")) return false;
	const recipes = new Set(next.completed_recipe_run_ids);
	return prior.completed_recipe_run_ids.every((id) => recipes.has(id));
}

async function writeWorkerCheckpointV1Locked(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	checkpoint: WorkerCheckpointV1,
	adapter: DelegationTransactionStorageAdapter,
): Promise<DelegationTransactionStorageResult<WorkerCheckpointV1>> {
	const encoded = encodeWorkerCheckpointV1(checkpoint);
	if (encoded === undefined) return failure("invalid_input", "worker checkpoint is invalid or oversized");
	const existing = await readWorkerCheckpointV1At(paths, checkpoint.delegation_id, checkpoint.contract_hash, adapter);
	if (!existing.ok) return existing;
	if (existing.value?.checkpoint_hash === checkpoint.checkpoint_hash) return { ok: true, value: existing.value };
	if (!workerCheckpointCanAdvanceV1(existing.value, checkpoint)) return failure("conflict", "worker checkpoint chain is not monotonic");
	const token = storageToken(adapter);
	if (token === undefined) return failure("storage_failure", "storage random token is invalid", "worker_checkpoint_v1.temp.write");
	const temp = join(paths.v2, `.worker-checkpoint-v1.${token}.tmp`);
	try {
		await invokeFault(adapter, "worker_checkpoint_v1.temp.write");
		await adapter.write(temp, encoded, true);
		const tempBytes = await readBytesAtPoint(adapter, temp, DELEGATION_WORKER_CHECKPOINT_V1_MAX_BYTES, "worker_checkpoint_v1.temp.read");
		if (!Buffer.from(tempBytes).equals(Buffer.from(encoded))) throw new Error("checkpoint temp readback mismatch");
		await invokeFault(adapter, "worker_checkpoint_v1.rename");
		await adapter.move(temp, paths.workerCheckpointV1);
	} catch {
		return failure("storage_failure", "worker checkpoint atomic publish failed", "worker_checkpoint_v1.rename");
	}
	const finalRead = await readWorkerCheckpointV1At(
		paths, checkpoint.delegation_id, checkpoint.contract_hash, adapter, "worker_checkpoint_v1.final.read",
	);
	return finalRead.ok && finalRead.value?.checkpoint_hash === checkpoint.checkpoint_hash
		? { ok: true, value: finalRead.value }
		: failure("storage_failure", "worker checkpoint final readback mismatch", "worker_checkpoint_v1.final.read");
}

async function readSemanticMigrationAt(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	authority: DelegationReviewAuthorityV2,
	adapter: DelegationTransactionStorageAdapter,
	point?: "semantic_migration.temp.read" | "semantic_migration.final.read",
): Promise<DelegationTransactionStorageResult<DelegationSemanticMigrationV1 | undefined>> {
	try {
		const stat = await adapter.inspect(paths.semanticMigration);
		if (stat.kind !== "file" || stat.size > DELEGATION_SEMANTIC_MIGRATION_MAX_BYTES) {
			return failure("invalid_record", "semantic migration path is unsafe or oversized", point);
		}
		const bytes = point === undefined
			? await adapter.readBounded(paths.semanticMigration, DELEGATION_SEMANTIC_MIGRATION_MAX_BYTES)
			: await readBytesAtPoint(adapter, paths.semanticMigration, DELEGATION_SEMANTIC_MIGRATION_MAX_BYTES, point);
		const migration = parseSemanticMigrationForAuthority(decodeJson(bytes), authority);
		const canonical = migration === undefined ? undefined : encodeSemanticMigration(migration);
		if (migration === undefined || canonical === undefined || !Buffer.from(canonical).equals(Buffer.from(bytes))) {
			return failure("invalid_record", "semantic migration is corrupt, non-canonical, or unbound", point);
		}
		return { ok: true, value: migration };
	} catch (error) {
		return isErrno(error, "ENOENT")
			? { ok: true, value: undefined }
			: failure("storage_failure", "semantic migration read failed", point);
	}
}

async function readSemanticRepairDecisionAt(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	authority: DelegationReviewAuthorityV2,
	adapter: DelegationTransactionStorageAdapter,
	point?: "repair_decision.temp.read" | "repair_decision.final.read",
): Promise<DelegationTransactionStorageResult<DelegationSemanticRepairDecisionV1 | undefined>> {
	try {
		const stat = await adapter.inspect(paths.semanticRepair);
		if (stat.kind !== "file" || stat.size > DELEGATION_SEMANTIC_REPAIR_DECISION_MAX_BYTES) {
			return failure("invalid_record", "semantic repair decision path is unsafe or oversized", point);
		}
		const bytes = point === undefined
			? await adapter.readBounded(paths.semanticRepair, DELEGATION_SEMANTIC_REPAIR_DECISION_MAX_BYTES)
			: await readBytesAtPoint(adapter, paths.semanticRepair, DELEGATION_SEMANTIC_REPAIR_DECISION_MAX_BYTES, point);
		const decision = parseSemanticRepairDecisionForAuthority(decodeJson(bytes), authority);
		const canonical = decision === undefined ? undefined : encodeSemanticRepairDecision(decision);
		if (decision === undefined || canonical === undefined || !Buffer.from(canonical).equals(Buffer.from(bytes))) {
			return failure("invalid_record", "semantic repair decision is corrupt, non-canonical, or unbound", point);
		}
		return { ok: true, value: decision };
	} catch (error) {
		return isErrno(error, "ENOENT")
			? { ok: true, value: undefined }
			: failure("storage_failure", "semantic repair decision read failed", point);
	}
}

async function readTerminalNegativeRepairArtifactAt(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	authority: DelegationReviewAuthorityV2,
	adapter: DelegationTransactionStorageAdapter,
	point?: "terminal_negative_repair.temp.read" | "terminal_negative_repair.final.read",
): Promise<DelegationTransactionStorageResult<DelegationTerminalNegativeRepairDecisionArtifactV1 | undefined>> {
	try {
		const stat = await adapter.inspect(paths.terminalNegativeRepair);
		if (stat.kind !== "file" || stat.size > DELEGATION_TERMINAL_NEGATIVE_REPAIR_DECISION_MAX_BYTES) {
			return failure("invalid_record", "terminal-negative repair decision path is unsafe or oversized", point);
		}
		const bytes = point === undefined
			? await adapter.readBounded(paths.terminalNegativeRepair, DELEGATION_TERMINAL_NEGATIVE_REPAIR_DECISION_MAX_BYTES)
			: await readBytesAtPoint(adapter, paths.terminalNegativeRepair, DELEGATION_TERMINAL_NEGATIVE_REPAIR_DECISION_MAX_BYTES, point);
		const artifact = parseTerminalNegativeRepairArtifactForAuthority(decodeJson(bytes), authority);
		const canonical = artifact === undefined ? undefined : encodeTerminalNegativeRepairArtifact(artifact);
		if (artifact === undefined || canonical === undefined || !Buffer.from(canonical).equals(Buffer.from(bytes))) {
			return failure("invalid_record", "terminal-negative repair decision is corrupt, non-canonical, or unbound", point);
		}
		return { ok: true, value: artifact };
	} catch (error) {
		return isErrno(error, "ENOENT")
			? { ok: true, value: undefined }
			: failure("storage_failure", "terminal-negative repair decision read failed", point);
	}
}

/** Existing repair authority freezes its exact provisional packet. */
async function readSemanticRepairBeforeReviewMutation(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	state: DelegationTransactionRecord,
	records: DelegationCommittedRecords,
	adapter: DelegationTransactionStorageAdapter,
): Promise<DelegationTransactionStorageResult<DelegationSemanticRepairDecisionV1 | undefined>> {
	try {
		await adapter.inspect(paths.semanticRepair);
	} catch (error) {
		return isErrno(error, "ENOENT")
			? { ok: true, value: undefined }
			: failure("storage_failure", "semantic repair decision inspection failed");
	}
	const review = await readReviewArtifactAt(paths, state, records, adapter);
	if (!review.ok) {
		return failure("invalid_record", "semantic repair decision exists without its exact provisional review authority");
	}
	const { bytes: _bytes, ...authority } = review.value;
	return readSemanticRepairDecisionAt(paths, authority, adapter);
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

/** CAS the exact checkpointed RECOVERY_REQUIRED transaction back to RUNNING. */
export async function persistResumedRunningDelegationTransaction(
	projectRoot: string,
	input: DelegationCasInput,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationTransactionRecord>> {
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, input.delegation_id, input.now, adapter, async (paths) => {
		const current = await readStateAt(paths.transaction, adapter);
		if (!current.ok) return current;
		const next = resumeDelegationTransaction(current.value, input);
		if (!next.ok) return failure("conflict", "delegation checkpoint resume CAS or lifecycle check failed");
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
	if (!isRecord(value) || !(exactFields(value, SCOPE_RECORD_FIELDS)
		|| exactFields(value, SCOPE_RECORD_FIELDS_WITH_COMMAND)) || state.terminal_outcome === null) return false;
	if (value.schema_version !== DELEGATION_TRANSACTION_SCHEMA_VERSION || value.delegation_id !== state.delegation_id ||
		value.task_kind !== state.task_kind || value.contract_hash !== state.contract_hash ||
		!Array.isArray(value.allowed_paths) || !sameJson(value.allowed_paths, state.allowed_paths) ||
		!Array.isArray(value.changed_paths) || !sameJson(value.changed_paths, state.terminal_outcome.changed_paths)) return false;
	if (!validateWorkerWriteJournalRecord(value.write_journal) || !validateChangeSet(value.change_set)) return false;
	const journal = value.write_journal as WorkerWriteJournalRecord;
	const changeSet = value.change_set as ChangeSetRecord;
	const command = Object.prototype.hasOwnProperty.call(value, "command_provenance")
		? value.command_provenance as DelegationCommandProvenanceRecord
		: undefined;
	if (command !== undefined && !validateDelegationCommandProvenance(command, changeSet)) return false;
	const changedPaths = effectiveDeltaPaths(changeSet, command);
	const effectiveStatus = command?.effective_status ?? changeSet.status;
	const effectiveHash = command?.effective_delta_hash ?? changeSet.worker_delta_hash;
	const successfulWrites = journal.operations.filter((operation) =>
		operation.status === "completed" && operation.outcome === "succeeded").length;
	return journal.state === "SEALED" && journal.journal_hash !== null &&
		journal.delegation_id === state.delegation_id && journal.contract_hash === state.contract_hash &&
		changeSet.delegation_id === state.delegation_id && changeSet.contract_hash === state.contract_hash &&
		changeSet.journal_hash === journal.journal_hash && sameJson(value.changed_paths, changedPaths) &&
		state.terminal_outcome.change_set_status === effectiveStatus &&
		state.terminal_outcome.terminal_facts_complete === true &&
		state.terminal_outcome.scope_complete === changedPaths.every((path) => delegationPathAllowedV2(path, state.allowed_paths)) &&
		state.terminal_outcome.successful_write_count === successfulWrites &&
		(state.task_kind === "implementation"
			? state.terminal_outcome.delta_hash === effectiveHash
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
	command: DelegationCommandProvenanceRecord | undefined,
	allowLegacyRead: boolean,
): boolean {
	if (!isRecord(value) || !validateWorkspaceGuard(value.workspace_guard)) return false;
	const tagged = value.diff_identity_kind === DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2;
	const envelopeTagged = tagged && Object.prototype.hasOwnProperty.call(value, "review_envelope");
	const commandTagged = tagged && Object.prototype.hasOwnProperty.call(value, "command_provenance_hash");
	const hasWorkerSuccess = Object.prototype.hasOwnProperty.call(value, "worker_success");
	const hasWorkerFailure = Object.prototype.hasOwnProperty.call(value, "worker_failure_code");
	if (hasWorkerSuccess !== hasWorkerFailure) return false;
	const baseFields = tagged
		? commandTagged
			? (envelopeTagged ? AFTER_RECORD_FIELDS_GUARD_V2_COMMAND_ENVELOPE : AFTER_RECORD_FIELDS_GUARD_V2_COMMAND)
			: (envelopeTagged ? AFTER_RECORD_FIELDS_GUARD_V2_ENVELOPE : AFTER_RECORD_FIELDS_GUARD_V2)
		: AFTER_RECORD_FIELDS;
	if (!exactFields(value, hasWorkerSuccess ? [...baseFields, ...AFTER_WORKER_OUTCOME_FIELDS] : baseFields) ||
		(!tagged && !allowLegacyRead)) return false;
	const outcome = state.terminal_outcome;
	if (outcome === null) return false;
	const currentOutcome = isCurrentDelegationTerminalOutcome(outcome);
	// Legacy shapes are read-only. Every newly compiled generation must carry
	// the closed worker outcome, while historical state and records must agree
	// on both fields being absent.
	if (hasWorkerSuccess !== currentOutcome || (!currentOutcome && !allowLegacyRead)) return false;
	if (currentOutcome && (typeof value.worker_success !== "boolean" ||
		!(value.worker_failure_code === null || isWorkerRunFailureCode(value.worker_failure_code)) ||
		value.worker_success !== (value.worker_failure_code === null) ||
		value.worker_success !== outcome.worker_success || value.worker_failure_code !== outcome.worker_failure_code ||
		value.status !== (value.worker_success ? "success" : "failure"))) return false;
	const guard = value.workspace_guard as WorkspaceGuardRecord;
	if (commandTagged !== (command !== undefined)) return false;
	const changedPaths = effectiveDeltaPaths(changeSet, command);
	const reviewPaths = delegationRepairReviewPathsV1(changedPaths, state.repair_lineage);
	const effectiveStatus = command?.effective_status ?? changeSet.status;
	const fullPaths = guard.entries.map((entry) => entry.path);
	const common = value.schema_version === DELEGATION_TRANSACTION_SCHEMA_VERSION && value.delegation_id === state.delegation_id &&
		isCanonicalTime(value.recorded_at) && (value.status === "success" || value.status === "failure") &&
		Number.isSafeInteger(value.exit_code) && typeof value.diff_hash === "string" && DELEGATION_TRANSACTION_HASH_RE.test(value.diff_hash) &&
		validByteSortedPaths(value.changed_paths, 500) && sameJson(value.changed_paths, changedPaths) &&
		validReviewPaths(value.changed_since_before, 500) && validReviewPaths(value.reported_paths, 500) &&
		isRecord(value.pinned_identity) &&
		isRecord(value.usage) && isRecord(value.budget) && typeof value.report_summary === "string" && value.review_status === "PENDING_REVIEW" &&
		value.change_set_status === effectiveStatus && value.worker_delta_hash === changeSet.worker_delta_hash &&
		value.workspace_guard_hash === changeSet.workspace_guard_hash && value.change_set_hash === changeSet.change_set_hash &&
		(command === undefined || (value.command_provenance_hash === command.command_provenance_hash
			&& value.effective_delta_hash === command.effective_delta_hash)) &&
		guard.workspace_guard_hash === changeSet.after_workspace_guard_hash;
	if (!common || reviewPaths === undefined || (envelopeTagged && (!validateSemanticReviewEnvelopeV1(value.review_envelope) ||
		(value.review_envelope.path_count !== changedPaths.length &&
			value.review_envelope.path_count !== reviewPaths.length)))) return false;
	if (!tagged) return allowLegacyRead &&
		validateGuardDiagnostics(guard, value.git_head, value.git_dirty, value.path_statuses, value.path_digests) &&
		value.diff_hash === computeDiffHash(fullPaths, value.path_digests as Record<string, string>, value.path_statuses as Record<string, string>);
	if (!guardStatusDiagnostics(guard, value.git_head, value.git_dirty, value.path_statuses) || !isRecord(value.path_digests)
		|| value.diff_hash !== guard.workspace_guard_hash || !validByteSortedPaths(value.changed_since_before, 500)) return false;
	const unsafePaths = [...new Set([
		...changedPaths,
		...(command?.remaining_workspace_drift ?? changeSet.workspace_drift).map((entry) => entry.path),
		...changeSet.conflicts.map((entry) => entry.path),
	])].sort(byteCompare);
	const expectedDigestPaths = [
		...changeSet.worker_delta.filter((entry) => entry.after.kind === "file").map((entry) => entry.path),
		...(command?.command_delta ?? []).filter((entry) => entry.after.kind === "file").map((entry) => entry.path),
	].sort(byteCompare);
	return sameJson(value.changed_since_before, unsafePaths) && sameJson(Object.keys(value.path_digests).sort(byteCompare), expectedDigestPaths) &&
	Object.entries(value.path_digests).every(([path, digest]) => {
		const delta = changeSet.worker_delta.find((entry) => entry.path === path)
			?? command?.command_delta.find((entry) => entry.path === path);
		return delta !== undefined && delta.after.kind === "file" && typeof digest === "string" &&
			/^[a-f0-9]{64}$/u.test(digest) && digest === delta.after.sha256;
	});
}

function validateCommittedWorkerOutcomeRecord(
	value: unknown,
	state: DelegationTransactionRecord,
	allowLegacyRead: boolean,
): boolean {
	if (!isRecord(value) || state.terminal_outcome === null) return false;
	const hasWorkerSuccess = Object.prototype.hasOwnProperty.call(value, "worker_success");
	const hasWorkerFailure = Object.prototype.hasOwnProperty.call(value, "worker_failure_code");
	if (hasWorkerSuccess !== hasWorkerFailure) return false;
	const outcome = state.terminal_outcome;
	const currentOutcome = isCurrentDelegationTerminalOutcome(outcome);
	if (hasWorkerSuccess !== currentOutcome || (!currentOutcome && !allowLegacyRead)) return false;
	if (!currentOutcome) return true;
	return typeof value.worker_success === "boolean" &&
		(value.worker_failure_code === null || isWorkerRunFailureCode(value.worker_failure_code)) &&
		value.worker_success === (value.worker_failure_code === null) &&
		value.worker_success === outcome.worker_success &&
		value.worker_failure_code === outcome.worker_failure_code &&
		value.status === (value.worker_success ? "success" : "failure");
}

function validateCommittedRecordBindings(
	state: DelegationTransactionRecord,
	records: DelegationCommittedRecords,
	allowLegacyRead: boolean,
): boolean {
	if (!validateScopeRecord(records["scope.json"], state)) return false;
	const scope = records["scope.json"] as {
		change_set: ChangeSetRecord;
		write_journal: WorkerWriteJournalRecord;
		command_provenance?: DelegationCommandProvenanceRecord;
	};
	const changeSet = scope.change_set;
	const command = scope.command_provenance;
	if (!validateBeforeRecord(records["before.json"], state, changeSet, allowLegacyRead) ||
		!validateAfterRecord(records["after.json"], state, changeSet, command, allowLegacyRead)) return false;
	const beforeTagged = isRecord(records["before.json"]) && records["before.json"].diff_identity_kind === DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2;
	const afterTagged = isRecord(records["after.json"]) && records["after.json"].diff_identity_kind === DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2;
	if (beforeTagged !== afterTagged || (!allowLegacyRead && !beforeTagged)) return false;
	const summary = records["worker-summary.json"];
	const usage = records["usage.json"];
	if (!validateCommittedWorkerOutcomeRecord(summary, state, allowLegacyRead) ||
		!validateCommittedWorkerOutcomeRecord(usage, state, allowLegacyRead) ||
		!isRecord(summary) || !validByteSortedPaths(summary.changed_paths, 500) ||
		!sameJson(summary.changed_paths, effectiveDeltaPaths(changeSet, command))) return false;
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
	const publishedStatuses = new Set(["PENDING_REVIEW", "INTERRUPTED", "FINISHED", "REVIEWED", "FAILED", "RECOVERY_REQUIRED"]);
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

async function readSemanticReviewEvidenceV2Chain(
	projectRoot: string,
	committed: DelegationCommittedGenerationV2,
	authority: DelegationReviewAuthorityV2,
	adapter: DelegationTransactionStorageAdapter,
	visited: ReadonlySet<string>,
): Promise<DelegationTransactionStorageResult<SemanticReviewEvidenceV2 | undefined>> {
	if (visited.has(committed.state.delegation_id) || visited.size >= 64) {
		return failure("invalid_record", "semantic review evidence parent chain is cyclic or exceeds its bound");
	}
	const paths = transactionPaths(projectRoot, committed.state.delegation_id);
	if (paths === undefined) return failure("invalid_input", "invalid semantic review evidence delegation id");
	const read = await readSemanticReviewEvidenceV2At(paths, authority, adapter);
	if (!read.ok || read.value === undefined) return read;
	const evidence = read.value;
	if (evidence.parent_evidence_hash === null) {
		return verifySemanticReviewParentEvidenceV2(evidence, null)
			? { ok: true, value: evidence }
			: failure("invalid_record", "semantic review evidence has inherited streams without a parent");
	}
	const parentId = committed.state.repair_lineage?.repair_of;
	if (parentId === undefined || parentId === committed.state.delegation_id) {
		return failure("invalid_record", "semantic review evidence parent is not the exact repair predecessor");
	}
	const parentCommitted = await readDelegationCommittedGenerationV2(projectRoot, parentId, { adapter });
	if (!parentCommitted.ok) return failure("invalid_record", "semantic review evidence parent generation is unavailable");
	const parentPaths = transactionPaths(projectRoot, parentId);
	if (parentPaths === undefined) return failure("invalid_record", "semantic review evidence parent path is invalid");
	const parentBase = await readReviewArtifactAt(parentPaths, parentCommitted.value.state, parentCommitted.value.records, adapter);
	if (!parentBase.ok) return failure("invalid_record", "semantic review evidence parent review is unavailable");
	const { bytes: _bytes, ...parentAuthority } = parentBase.value;
	const parent = await readSemanticReviewEvidenceV2Chain(
		projectRoot,
		parentCommitted.value,
		parentAuthority,
		adapter,
		new Set([...visited, committed.state.delegation_id]),
	);
	if (!parent.ok || parent.value === undefined || !verifySemanticReviewParentEvidenceV2(evidence, parent.value)) {
		return failure("invalid_record", "semantic review evidence inherited proof does not match the direct parent");
	}
	return { ok: true, value: evidence };
}

/** Strict V2 evidence read. Absence is legacy/V1, malformed and future records fail closed. */
export async function readDelegationSemanticReviewEvidenceV2(
	projectRoot: string,
	delegationId: string,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<SemanticReviewEvidenceV2 | undefined>> {
	const committed = await readDelegationCommittedGenerationV2(projectRoot, delegationId, options);
	if (!committed.ok) return committed;
	const paths = transactionPaths(projectRoot, delegationId);
	if (paths === undefined) return failure("invalid_input", "invalid delegation id");
	const adapter = adapterOf(options);
	const base = await readReviewArtifactAt(paths, committed.value.state, committed.value.records, adapter);
	if (!base.ok) return base;
	const { bytes: _bytes, ...authority } = base.value;
	return readSemanticReviewEvidenceV2Chain(projectRoot, committed.value, authority, adapter, new Set());
}

/** Read-only operational progress. It is never semantic ACCEPT authority. */
export async function readDelegationSemanticReviewProgressV2(
	projectRoot: string,
	delegationId: string,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<SemanticReviewProgressV2 | undefined>> {
	const paths = transactionPaths(projectRoot, delegationId);
	if (paths === undefined) return failure("invalid_input", "invalid delegation id");
	return readSemanticReviewProgressV2At(paths, delegationId, adapterOf(options));
}

/**
 * Serialize a complete resumable review runner behind the existing live-owner
 * transaction lock. The callback may perform model calls, but can publish only
 * validated monotonic progress through the provided closure.
 */
export async function withDelegationSemanticReviewJobV2<T>(
	projectRoot: string,
	delegationId: string,
	now: string,
	operation: (context: {
		progress: Readonly<SemanticReviewProgressV2> | undefined;
		publishProgress: (progress: Readonly<SemanticReviewProgressV2>) => Promise<DelegationTransactionStorageResult<SemanticReviewProgressV2>>;
	}) => Promise<T>,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<T>> {
	if (!isCanonicalTime(now)) return failure("invalid_input", "review job lock time must be canonical ISO-8601");
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, delegationId, now, adapter, async (paths) => {
		const state = await readStateAt(paths.transaction, adapter);
		if (!state.ok) return state;
		if (state.value.task_kind !== "implementation" || state.value.committed_proof === null
			|| (state.value.status !== "PENDING_REVIEW" && state.value.status !== "REVIEWED")) {
			return failure("conflict", "semantic review job requires a committed review lifecycle");
		}
		const existing = await readSemanticReviewProgressV2At(paths, delegationId, adapter);
		if (!existing.ok) return existing;
		try {
			const value = await operation({
				progress: existing.value,
				publishProgress: async (progress) => {
					if (progress.delegation_id !== delegationId || progress.generation !== state.value.generation) {
						return failure("conflict", "semantic review progress does not match locked generation");
					}
					return writeSemanticReviewProgressV2Locked(paths, structuredClone(progress), adapter);
				},
			});
			return { ok: true, value };
		} catch {
			return failure("storage_failure", "semantic review job callback failed");
		}
	});
}

/** Final progress publication after immutable evidence has been read back. */
export async function publishDelegationSemanticReviewProgressV2(
	projectRoot: string,
	progress: Readonly<SemanticReviewProgressV2>,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<SemanticReviewProgressV2>> {
	if (!validateSemanticReviewProgressV2(progress)) return failure("invalid_input", "semantic review progress v2 is invalid");
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, progress.delegation_id, progress.updated_at, adapter, async (paths) =>
		writeSemanticReviewProgressV2Locked(paths, structuredClone(progress), adapter));
}

/** Latest machine checkpoint; it is execution state, never semantic review authority. */
export async function readDelegationWorkerCheckpointV1(
	projectRoot: string,
	delegationId: string,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<WorkerCheckpointV1 | undefined>> {
	const state = await readDelegationTransactionV2(projectRoot, delegationId, options);
	if (!state.ok) return state;
	const paths = transactionPaths(projectRoot, delegationId);
	if (paths === undefined) return failure("invalid_input", "invalid delegation id");
	return readWorkerCheckpointV1At(paths, delegationId, state.value.contract_hash, adapterOf(options));
}

/** Publish exactly one monotonic checkpoint attempt under the transaction lock. */
export async function publishDelegationWorkerCheckpointV1(
	projectRoot: string,
	checkpoint: Readonly<WorkerCheckpointV1>,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<WorkerCheckpointV1>> {
	if (!validateWorkerCheckpointV1(checkpoint)) return failure("invalid_input", "worker checkpoint is invalid");
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, checkpoint.delegation_id, checkpoint.created_at, adapter, async (paths) => {
		const state = await readStateAt(paths.transaction, adapter);
		if (!state.ok) return state;
		if (state.value.status !== "RUNNING" || state.value.contract_hash !== checkpoint.contract_hash) {
			return failure("conflict", "worker checkpoint does not bind the active transaction state");
		}
		return writeWorkerCheckpointV1Locked(paths, structuredClone(checkpoint), adapter);
	});
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
	const adapter = adapterOf(options);
	const read = await readReviewArtifactAt(paths, generation.value.state, generation.value.records, adapter);
	if (!read.ok) {
		try {
			await adapter.inspect(paths.semanticRepair);
			return failure("invalid_record", "semantic repair decision exists without its exact provisional review authority");
		} catch (error) {
			if (!isErrno(error, "ENOENT")) return failure("storage_failure", "semantic repair decision inspection failed");
		}
		return read;
	}
	const { bytes: _bytes, ...authority } = read.value;
	const migration = await readSemanticMigrationAt(paths, authority, adapter);
	if (!migration.ok) return migration;
	const repair = await readSemanticRepairDecisionAt(paths, authority, adapter);
	if (!repair.ok) return repair;
	const evidence = await readSemanticReviewEvidenceV2Chain(
		projectRoot, generation.value, authority, adapter, new Set(),
	);
	if (!evidence.ok) return evidence;
	if (evidence.value !== undefined && (migration.value !== undefined || repair.value !== undefined
		|| authority.review.semantic_review === "accepted" || authority.review.semantic_acceptance !== undefined)) {
		return failure("invalid_record", "semantic review evidence v2 conflicts with a legacy semantic owner");
	}
	const evidenceRepair = evidence.value === undefined ? undefined : semanticRepairProjectionFromEvidenceV2(authority, evidence.value);
	if (evidence.value?.final_decision === "REPAIR" && evidenceRepair === undefined) {
		return failure("invalid_record", "semantic review evidence v2 repair projection is invalid");
	}
	return {
		ok: true,
		value: {
			...authority,
			...(migration.value === undefined ? {} : { semantic_migration: migration.value }),
			...(repair.value === undefined ? {} : { semantic_repair: repair.value }),
			...(evidence.value === undefined ? {} : { semantic_evidence_v2: evidence.value }),
			...(evidenceRepair === undefined ? {} : { semantic_repair: evidenceRepair }),
		},
	};
}

/**
 * Strict terminal-negative review read.  It never accepts REVIEWED,
 * PENDING_REVIEW, RECOVERY_REQUIRED, an empty delta, or ambiguous ordinary
 * semantic sidecars.
 */
export async function readDelegationTerminalNegativeReviewV1(
	projectRoot: string,
	delegationId: string,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationTerminalNegativeReviewAuthorityV1>> {
	const generation = await readDelegationCommittedGenerationV2(projectRoot, delegationId, options);
	if (!generation.ok) return generation;
	if (!isDelegationTerminalNegativeReviewEligibleFromCommittedV1(generation.value.state, generation.value.records)) {
		return failure("invalid_record", "delegation is not an eligible committed terminal-negative implementation");
	}
	const paths = transactionPaths(projectRoot, delegationId);
	if (paths === undefined) return failure("invalid_input", "invalid delegation id");
	const adapter = adapterOf(options);
	for (const ambiguousPath of [paths.semanticRepair, paths.semanticMigration]) {
		try {
			await adapter.inspect(ambiguousPath);
			return failure("invalid_record", "terminal-negative review conflicts with an ordinary semantic sidecar");
		} catch (error) {
			if (!isErrno(error, "ENOENT")) return failure("storage_failure", "terminal-negative sidecar inspection failed");
		}
	}
	const read = await readReviewArtifactAt(paths, generation.value.state, generation.value.records, adapter);
	if (!read.ok) {
		try {
			await adapter.inspect(paths.terminalNegativeRepair);
			return failure("invalid_record", "terminal-negative repair decision exists without its exact provisional review authority");
		} catch (error) {
			if (!isErrno(error, "ENOENT")) return failure("storage_failure", "terminal-negative repair decision inspection failed");
		}
		return read;
	}
	const { bytes: _bytes, ...base } = read.value;
	const repair = await readTerminalNegativeRepairArtifactAt(paths, base, adapter);
	if (!repair.ok) return repair;
	return {
		ok: true,
		value: {
			...base,
			state: generation.value.state,
			finalized: false,
			...(repair.value === undefined ? {} : { terminal_negative_repair: repair.value }),
		} as DelegationTerminalNegativeReviewAuthorityV1,
	};
}

/** Exact structural readback consumed by terminal-negative exact repair. */
export async function readDelegationTerminalNegativeSolAuthorityV1(
	projectRoot: string,
	delegationId: string,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationTerminalNegativeSolAuthorityV1>> {
	const authority = await readDelegationTerminalNegativeReviewV1(projectRoot, delegationId, options);
	if (!authority.ok) return authority;
	const repair = authority.value.terminal_negative_repair;
	if (repair === undefined) return failure("not_found", "terminal-negative Sol REPAIR authority is not yet published");
	return {
		ok: true,
		value: {
			state: structuredClone(authority.value.state),
			review_hash: authority.value.review_hash,
			bound_diff_hash: authority.value.review.bound_diff_hash,
			decision: structuredClone(repair.decision),
		},
	};
}

/** Strict optional migration read: absence is a successful `undefined`. */
export async function readDelegationSemanticMigrationV1(
	projectRoot: string,
	delegationId: string,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationSemanticMigrationV1 | undefined>> {
	const authority = await readDelegationReviewV2(projectRoot, delegationId, options);
	if (!authority.ok) {
		return authority.error.code === "storage_failure"
			? authority
			: failure("invalid_record", "semantic repair decision exists without strict review authority");
	}
	return { ok: true, value: authority.value.semantic_migration };
}

/**
 * Presence-only freeze check for replaceable derived review evidence. Any
 * entry at either immutable semantic sidecar path blocks regeneration; the
 * entry is never followed or interpreted without its strict review authority.
 */
export async function readDelegationImmutableReviewSidecarPresenceV1(
	projectRoot: string,
	delegationId: string,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<{ semantic_migration: boolean; semantic_repair: boolean; semantic_evidence_v2: boolean }>> {
	const paths = transactionPaths(projectRoot, delegationId);
	if (paths === undefined) return failure("invalid_input", "invalid delegation id");
	const adapter = adapterOf(options);
	const presence = { semantic_migration: false, semantic_repair: false, semantic_evidence_v2: false };
	for (const [key, path] of [
		["semantic_migration", paths.semanticMigration],
		["semantic_repair", paths.semanticRepair],
		["semantic_evidence_v2", paths.semanticEvidenceV2],
	] as const) {
		try {
			await adapter.inspect(path);
			presence[key] = true;
		} catch (error) {
			if (!isErrno(error, "ENOENT")) return failure("storage_failure", "semantic sidecar inspection failed");
		}
	}
	return { ok: true, value: presence };
}

/** Strict optional repair-decision read: legacy absence is a successful `undefined`. */
export async function readDelegationSemanticRepairDecisionV1(
	projectRoot: string,
	delegationId: string,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationSemanticRepairDecisionV1 | undefined>> {
	const paths = transactionPaths(projectRoot, delegationId);
	if (paths === undefined) return failure("invalid_input", "invalid delegation id");
	const adapter = adapterOf(options);
	try {
		await adapter.inspect(paths.semanticRepair);
	} catch (error) {
		return isErrno(error, "ENOENT")
			? { ok: true, value: undefined }
			: failure("storage_failure", "semantic repair decision inspection failed");
	}
	const authority = await readDelegationReviewV2(projectRoot, delegationId, options);
	if (!authority.ok) return authority;
	return { ok: true, value: authority.value.semantic_repair };
}

/**
 * Read the semantic REPAIR decision which currently governs one exact
 * committed generation.  A terminal-negative decision may belong to either
 * a lineage root or a later repair tip: lineage position does not change the
 * sidecar's binding to this committed parent.
 */
export async function readDelegationCurrentSemanticRepairDecisionV1(
	projectRoot: string,
	committed: DelegationCommittedGenerationV2,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationSemanticRepairDecisionV1 | undefined>> {
	const state = committed.state;
	if (state.status === "PENDING_REVIEW") {
		const read = await readDelegationSemanticRepairDecisionV1(projectRoot, state.delegation_id, options);
		if (!read.ok) return read;
		if (read.value === undefined) {
			const presence = await readDelegationImmutableReviewSidecarPresenceV1(projectRoot, state.delegation_id, options);
			if (!presence.ok || !presence.value.semantic_evidence_v2) {
				return presence.ok ? { ok: true, value: undefined } : presence;
			}
			const review = await readDelegationReviewV2(projectRoot, state.delegation_id, options);
			if (!review.ok) return review.error.code === "not_found" ? { ok: true, value: undefined } : review;
			return { ok: true, value: review.value.semantic_repair };
		}
		return read.value.delegation_id === state.delegation_id
			&& read.value.contract_hash === state.contract_hash
			? read
			: failure("invalid_record", "semantic repair decision does not bind the committed delegation");
	}
	if ((state.status !== "FAILED" && state.status !== "INTERRUPTED")
		|| !isDelegationTerminalNegativeReviewEligibleFromCommittedV1(state, committed.records)) {
		return { ok: true, value: undefined };
	}
	const read = await readDelegationTerminalNegativeSolAuthorityV1(projectRoot, state.delegation_id, options);
	if (!read.ok) {
		return read.error.code === "not_found" ? { ok: true, value: undefined } : read;
	}
	if (canonicalHash(read.value.state) !== canonicalHash(state)
		|| read.value.decision.delegation_id !== state.delegation_id
		|| read.value.decision.contract_hash !== state.contract_hash) {
		return failure("invalid_record", "terminal-negative repair decision does not bind the committed delegation");
	}
	return { ok: true, value: read.value.decision };
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

async function readHistoricalSemanticMigrationAuthorityLocked(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	state: DelegationTransactionRecord,
	adapter: DelegationTransactionStorageAdapter,
): Promise<DelegationTransactionStorageResult<DelegationReviewAuthorityV2>> {
	if (state.status !== "REVIEWED" || state.revision !== 4 || state.task_kind !== "implementation" ||
		state.committed_proof === null || state.review === null) {
		return failure("invalid_record", "semantic migration requires a finalized revision-4 implementation review");
	}
	const name = generationName(state.generation);
	if (name === undefined || state.committed_proof.generation !== state.generation || state.committed_proof.revision !== 2) {
		return failure("invalid_record", "semantic migration generation binding is invalid");
	}
	const verified = await verifyGenerationDirectory(join(paths.generations, name), {
		...state,
		status: "COMMITTING",
		revision: state.committed_proof.revision,
		committed_proof: null,
		review: null,
	}, adapter);
	if (!verified.ok || !sameJson(verified.value.inventory.proof, state.committed_proof)) {
		return failure("invalid_record", "semantic migration committed generation is unavailable");
	}
	const read = await readReviewArtifactAt(paths, state, verified.value.records, adapter);
	if (!read.ok || !read.value.finalized) {
		return failure("invalid_record", "semantic migration base review authority is unavailable");
	}
	const { bytes: _bytes, ...authority } = read.value;
	return historicalSemanticMigrationEligible(authority)
		? { ok: true, value: authority }
		: failure("invalid_record", "review is not eligible for historical semantic migration");
}

async function writeSemanticMigrationLocked(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	authority: DelegationReviewAuthorityV2,
	migration: DelegationSemanticMigrationV1,
	adapter: DelegationTransactionStorageAdapter,
): Promise<DelegationTransactionStorageResult<DelegationSemanticMigrationV1>> {
	const encoded = encodeSemanticMigration(migration);
	if (encoded === undefined || parseSemanticMigrationForAuthority(migration, authority) === undefined) {
		return failure("invalid_input", "semantic migration input is invalid or exceeds its fixed bound");
	}
	const token = storageToken(adapter);
	if (token === undefined) {
		return failure("storage_failure", "storage random token is invalid", "semantic_migration.temp.write");
	}
	const temp = join(paths.v2, `.semantic-migration.${token}.tmp`);
	try {
		await invokeFault(adapter, "semantic_migration.temp.write");
		await adapter.write(temp, encoded, true);
		const tempBytes = await readBytesAtPoint(
			adapter,
			temp,
			DELEGATION_SEMANTIC_MIGRATION_MAX_BYTES,
			"semantic_migration.temp.read",
		);
		const parsed = parseSemanticMigrationForAuthority(decodeJson(tempBytes), authority);
		const canonical = parsed === undefined ? undefined : encodeSemanticMigration(parsed);
		if (parsed === undefined || canonical === undefined || !Buffer.from(canonical).equals(Buffer.from(tempBytes)) ||
			!Buffer.from(tempBytes).equals(Buffer.from(encoded))) {
			return failure("storage_failure", "semantic migration temp readback mismatch", "semantic_migration.temp.read");
		}
		await invokeFault(adapter, "semantic_migration.rename");
		await adapter.move(temp, paths.semanticMigration);
	} catch {
		return failure("storage_failure", "semantic migration atomic publish failed", "semantic_migration.rename");
	}
	const finalRead = await readSemanticMigrationAt(paths, authority, adapter, "semantic_migration.final.read");
	if (!finalRead.ok || finalRead.value === undefined || !sameJson(finalRead.value, migration)) {
		return failure("storage_failure", "semantic migration final readback mismatch", "semantic_migration.final.read");
	}
	return { ok: true, value: finalRead.value };
}

async function writeSemanticReviewEvidenceV2Locked(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	authority: DelegationReviewAuthorityV2,
	evidence: SemanticReviewEvidenceV2,
	adapter: DelegationTransactionStorageAdapter,
): Promise<DelegationTransactionStorageResult<SemanticReviewEvidenceV2>> {
	const encoded = encodeSemanticReviewEvidenceV2(evidence);
	if (encoded === undefined || parseSemanticReviewEvidenceV2ForAuthority(evidence, authority) === undefined) {
		return failure("invalid_input", "semantic review evidence v2 is invalid or exceeds its fixed bound");
	}
	const token = storageToken(adapter);
	if (token === undefined) return failure("storage_failure", "storage random token is invalid", "semantic_evidence_v2.temp.write");
	const temp = join(paths.v2, `.semantic-review-evidence-v2.${token}.tmp`);
	try {
		await invokeFault(adapter, "semantic_evidence_v2.temp.write");
		await adapter.write(temp, encoded, true);
		const tempBytes = await readBytesAtPoint(
			adapter, temp, DELEGATION_SEMANTIC_REVIEW_EVIDENCE_V2_MAX_BYTES, "semantic_evidence_v2.temp.read",
		);
		const parsed = parseSemanticReviewEvidenceV2ForAuthority(decodeJson(tempBytes), authority);
		const canonical = parsed === undefined ? undefined : encodeSemanticReviewEvidenceV2(parsed);
		if (parsed === undefined || canonical === undefined || !Buffer.from(canonical).equals(Buffer.from(tempBytes))
			|| !Buffer.from(tempBytes).equals(Buffer.from(encoded))) {
			return failure("storage_failure", "semantic review evidence v2 temp readback mismatch", "semantic_evidence_v2.temp.read");
		}
		await invokeFault(adapter, "semantic_evidence_v2.rename");
		await adapter.move(temp, paths.semanticEvidenceV2);
	} catch {
		return failure("storage_failure", "semantic review evidence v2 atomic publish failed", "semantic_evidence_v2.rename");
	}
	const finalRead = await readSemanticReviewEvidenceV2At(paths, authority, adapter, "semantic_evidence_v2.final.read");
	if (!finalRead.ok || finalRead.value === undefined || finalRead.value.evidence_hash !== evidence.evidence_hash) {
		return failure("storage_failure", "semantic review evidence v2 final readback mismatch", "semantic_evidence_v2.final.read");
	}
	return { ok: true, value: finalRead.value };
}

async function writeSemanticRepairDecisionLocked(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	authority: DelegationReviewAuthorityV2,
	decision: DelegationSemanticRepairDecisionV1,
	adapter: DelegationTransactionStorageAdapter,
): Promise<DelegationTransactionStorageResult<DelegationSemanticRepairDecisionV1>> {
	const encoded = encodeSemanticRepairDecision(decision);
	if (encoded === undefined || parseSemanticRepairDecisionForAuthority(decision, authority) === undefined) {
		return failure("invalid_input", "semantic repair decision is invalid or exceeds its fixed bound");
	}
	const token = storageToken(adapter);
	if (token === undefined) {
		return failure("storage_failure", "storage random token is invalid", "repair_decision.temp.write");
	}
	const temp = join(paths.v2, `.repair-decision.${token}.tmp`);
	try {
		await invokeFault(adapter, "repair_decision.temp.write");
		await adapter.write(temp, encoded, true);
		const tempBytes = await readBytesAtPoint(
			adapter,
			temp,
			DELEGATION_SEMANTIC_REPAIR_DECISION_MAX_BYTES,
			"repair_decision.temp.read",
		);
		const parsed = parseSemanticRepairDecisionForAuthority(decodeJson(tempBytes), authority);
		const canonical = parsed === undefined ? undefined : encodeSemanticRepairDecision(parsed);
		if (parsed === undefined || canonical === undefined || !Buffer.from(canonical).equals(Buffer.from(tempBytes)) ||
			!Buffer.from(tempBytes).equals(Buffer.from(encoded))) {
			return failure("storage_failure", "semantic repair decision temp readback mismatch", "repair_decision.temp.read");
		}
		await invokeFault(adapter, "repair_decision.rename");
		await adapter.move(temp, paths.semanticRepair);
	} catch {
		return failure("storage_failure", "semantic repair decision atomic publish failed", "repair_decision.rename");
	}
	const finalRead = await readSemanticRepairDecisionAt(paths, authority, adapter, "repair_decision.final.read");
	if (!finalRead.ok || finalRead.value === undefined || !sameJson(finalRead.value, decision)) {
		return failure("storage_failure", "semantic repair decision final readback mismatch", "repair_decision.final.read");
	}
	return { ok: true, value: finalRead.value };
}

async function writeTerminalNegativeRepairArtifactLocked(
	paths: NonNullable<ReturnType<typeof transactionPaths>>,
	authority: DelegationTerminalNegativeReviewAuthorityV1,
	artifact: DelegationTerminalNegativeRepairDecisionArtifactV1,
	adapter: DelegationTransactionStorageAdapter,
): Promise<DelegationTransactionStorageResult<DelegationTerminalNegativeRepairDecisionArtifactV1>> {
	const encoded = encodeTerminalNegativeRepairArtifact(artifact);
	if (encoded === undefined || parseTerminalNegativeRepairArtifactForAuthority(artifact, authority) === undefined) {
		return failure("invalid_input", "terminal-negative repair decision is invalid or exceeds its fixed bound");
	}
	const token = storageToken(adapter);
	if (token === undefined) return failure("storage_failure", "storage random token is invalid", "terminal_negative_repair.temp.write");
	const temp = join(paths.v2, `.terminal-negative-repair.${token}.tmp`);
	try {
		await invokeFault(adapter, "terminal_negative_repair.temp.write");
		await adapter.write(temp, encoded, true);
		const tempBytes = await readBytesAtPoint(
			adapter, temp, DELEGATION_TERMINAL_NEGATIVE_REPAIR_DECISION_MAX_BYTES, "terminal_negative_repair.temp.read",
		);
		const parsed = parseTerminalNegativeRepairArtifactForAuthority(decodeJson(tempBytes), authority);
		const canonical = parsed === undefined ? undefined : encodeTerminalNegativeRepairArtifact(parsed);
		if (parsed === undefined || canonical === undefined || !Buffer.from(canonical).equals(Buffer.from(tempBytes))
			|| !Buffer.from(tempBytes).equals(Buffer.from(encoded))) {
			return failure("storage_failure", "terminal-negative repair temp readback mismatch", "terminal_negative_repair.temp.read");
		}
		await invokeFault(adapter, "terminal_negative_repair.rename");
		await adapter.move(temp, paths.terminalNegativeRepair);
	} catch {
		return failure("storage_failure", "terminal-negative repair atomic publish failed", "terminal_negative_repair.rename");
	}
	const finalRead = await readTerminalNegativeRepairArtifactAt(paths, authority, adapter, "terminal_negative_repair.final.read");
	if (!finalRead.ok || finalRead.value === undefined || !sameJson(finalRead.value, artifact)) {
		return failure("storage_failure", "terminal-negative repair final readback mismatch", "terminal_negative_repair.final.read");
	}
	return { ok: true, value: finalRead.value };
}

/**
 * Publish the sole semantic owner for an explicitly selected V2 review.
 * ACCEPT atomically advances the existing packet to REVIEWED only after the
 * immutable evidence has been written and read back. REPAIR stays pending.
 */
export async function publishDelegationSemanticReviewEvidenceV2(
	projectRoot: string,
	input: PublishDelegationSemanticReviewEvidenceV2Input,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<SemanticReviewEvidenceV2>> {
	if (!validateSemanticReviewEvidenceV2(input.evidence) || input.now !== input.evidence.completed_at
		|| input.evidence.delegation_id !== input.delegation_id || input.evidence.contract_hash !== input.contract_hash) {
		return failure("invalid_input", "semantic review evidence v2 input is invalid or not bound to the CAS request");
	}
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, input.delegation_id, input.now, adapter, async (paths) => {
		const currentResult = await readStateAt(paths.transaction, adapter);
		if (!currentResult.ok) return currentResult;
		const current = currentResult.value;
		const replayedAccept = current.status === "REVIEWED" && current.revision === 4
			&& input.evidence.final_decision === "ACCEPT" && current.review !== null
			&& current.review.review_hash === input.base_review_hash;
		if (!replayedAccept && (current.status !== "PENDING_REVIEW" || current.revision !== 3)) {
			return failure("conflict", "semantic review evidence v2 lifecycle check failed");
		}
		if (current.task_kind !== "implementation" || current.committed_proof === null
			|| current.generation !== input.expected_generation || current.contract_hash !== input.contract_hash
			|| !sameIdentity(current.worker_identity, input.worker_identity)
			|| (!replayedAccept && current.revision !== input.expected_revision)
			|| (replayedAccept && input.expected_revision !== 3 && input.expected_revision !== 4)) {
			return failure("conflict", "semantic review evidence v2 CAS, identity, or generation check failed");
		}
		const generation = generationName(current.generation);
		if (generation === undefined) return failure("invalid_record", "semantic review evidence v2 generation is invalid");
		const verified = await verifyGenerationDirectory(join(paths.generations, generation), {
			...current,
			status: "COMMITTING",
			revision: current.committed_proof.revision,
			committed_proof: null,
			review: null,
		}, adapter);
		if (!verified.ok || !sameJson(verified.value.inventory.proof, current.committed_proof)) {
			return failure("invalid_record", "semantic review evidence v2 conflicts with the committed generation");
		}
		const baseRead = await readReviewArtifactAt(paths, current, verified.value.records, adapter);
		if (!baseRead.ok) return baseRead;
		const { bytes: _bytes, ...authority } = baseRead.value;
		if (authority.review_hash !== input.base_review_hash || !semanticEvidenceV2Eligible(authority)
			|| parseSemanticReviewEvidenceV2ForAuthority(input.evidence, authority) === undefined) {
			return failure("conflict", "semantic review evidence v2 does not match the exact complete review packet");
		}
		const [migration, repair] = await Promise.all([
			readSemanticMigrationAt(paths, authority, adapter),
			readSemanticRepairDecisionAt(paths, authority, adapter),
		]);
		if (!migration.ok) return migration;
		if (!repair.ok) return repair;
		if (migration.value !== undefined || repair.value !== undefined || authority.review.semantic_acceptance !== undefined
			|| authority.review.semantic_review === "accepted") {
			return failure("conflict", "semantic review evidence v2 cannot dual-write a legacy semantic owner");
		}
		let parent: SemanticReviewEvidenceV2 | null = null;
		if (input.evidence.parent_evidence_hash !== null) {
			const parentId = current.repair_lineage?.repair_of;
			if (parentId === undefined) return failure("invalid_record", "semantic review evidence v2 parent is not a repair predecessor");
			const parentRead = await readDelegationSemanticReviewEvidenceV2(projectRoot, parentId, { adapter });
			if (!parentRead.ok || parentRead.value === undefined) {
				return failure("invalid_record", "semantic review evidence v2 parent authority is unavailable");
			}
			parent = parentRead.value;
		}
		if (!verifySemanticReviewParentEvidenceV2(input.evidence, parent)) {
			return failure("invalid_record", "semantic review evidence v2 inherited proof is invalid");
		}
		const existing = await readSemanticReviewEvidenceV2At(paths, authority, adapter);
		if (!existing.ok) return existing;
		let publishedEvidence: SemanticReviewEvidenceV2;
		if (existing.value !== undefined) {
			if (existing.value.evidence_hash !== input.evidence.evidence_hash) {
				return failure("conflict", "semantic review evidence v2 is immutable");
			}
			publishedEvidence = existing.value;
		} else {
			const written = await writeSemanticReviewEvidenceV2Locked(paths, authority, input.evidence, adapter);
			if (!written.ok) return written;
			publishedEvidence = written.value;
		}
		if (publishedEvidence.final_decision === "REPAIR" || replayedAccept) return { ok: true, value: publishedEvidence };
		const next = reviewDelegationTransaction(current, {
			delegation_id: current.delegation_id,
			contract_hash: current.contract_hash,
			worker_identity: current.worker_identity,
			expected_generation: current.generation,
			expected_revision: current.revision,
			now: authority.artifact.reviewed_at,
			review_hash: authority.review_hash,
		});
		if (!next.ok) return failure("conflict", "semantic review evidence v2 state transition failed");
		const state = await publishState(paths, next.state, adapter, "review_state");
		if (!state.ok) return state;
		return { ok: true, value: publishedEvidence };
	});
}

/**
 * Publish one immutable, complete-packet-bound Sol REPAIR decision.
 * The transaction deliberately remains PENDING_REVIEW revision 3: this
 * sidecar authorizes only an exact repair successor and never grants review,
 * successor, verification, or Gate authority.
 */
export async function publishDelegationSemanticRepairDecisionV1(
	projectRoot: string,
	input: PublishDelegationSemanticRepairDecisionV1Input,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationSemanticRepairDecisionV1>> {
	if (!validSemanticRepairReason(input.repair_reason) || !validSolIdentity(input.reviewer) || !isCanonicalTime(input.now)) {
		return failure("invalid_input", "semantic repair decision requires a bounded reason, active Sol reviewer, and canonical time");
	}
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, input.delegation_id, input.now, adapter, async (paths) => {
		const currentResult = await readStateAt(paths.transaction, adapter);
		if (!currentResult.ok) return currentResult;
		const current = currentResult.value;
		if (current.status !== "PENDING_REVIEW" || current.revision !== 3 || current.task_kind !== "implementation" ||
			current.committed_proof === null || current.review !== null || current.generation !== input.expected_generation ||
			input.expected_revision !== 3 || current.contract_hash !== input.contract_hash ||
			!sameIdentity(current.worker_identity, input.worker_identity) || input.now < current.updated_at) {
			return failure("conflict", "semantic repair decision CAS, identity, or lifecycle check failed");
		}
		const generation = generationName(current.generation);
		if (generation === undefined) return failure("invalid_record", "semantic repair generation is invalid");
		const verified = await verifyGenerationDirectory(join(paths.generations, generation), {
			...current,
			status: "COMMITTING",
			revision: current.committed_proof.revision,
			committed_proof: null,
			review: null,
		}, adapter);
		if (!verified.ok || !sameJson(verified.value.inventory.proof, current.committed_proof)) {
			return failure("invalid_record", "semantic repair decision conflicts with the committed generation");
		}
		const baseRead = await readReviewArtifactAt(paths, current, verified.value.records, adapter);
		if (!baseRead.ok) return baseRead;
		const { bytes: _bytes, ...authority } = baseRead.value;
		if (!semanticRepairDecisionEligible(authority)) {
			return failure("invalid_record", "semantic repair requires a complete provisional schema-2 semantic-review packet");
		}
		if (input.base_review_hash !== authority.review_hash ||
			input.expected_bound_diff_hash !== authority.review.bound_diff_hash) {
			return failure("conflict", "semantic repair decision does not match the exact provisional review packet");
		}
		const payload: Omit<DelegationSemanticRepairDecisionV1, "decision_hash"> = {
			schema_version: 1,
			delegation_id: current.delegation_id,
			contract_hash: current.contract_hash,
			generation: current.generation,
			transaction_revision: 3,
			generation_content_hash: current.committed_proof.content_hash,
			base_review_hash: authority.review_hash,
			expected_bound_diff_hash: authority.review.bound_diff_hash,
			decision: "REPAIR",
			repair_reason: input.repair_reason,
			repair_reason_hash: semanticRepairReasonHash(input.repair_reason),
			reviewer: structuredClone(input.reviewer),
			decided_at: input.now,
		};
		const desired: DelegationSemanticRepairDecisionV1 = {
			...payload,
			decision_hash: semanticRepairDecisionHash(payload),
		};
		if (parseSemanticRepairDecisionForAuthority(desired, authority) === undefined) {
			return failure("invalid_input", "semantic repair decision is invalid or unbound");
		}
		const existing = await readSemanticRepairDecisionAt(paths, authority, adapter);
		if (!existing.ok) return existing;
		if (existing.value !== undefined) {
			const sameRequest = existing.value.base_review_hash === input.base_review_hash &&
				existing.value.expected_bound_diff_hash === input.expected_bound_diff_hash &&
				existing.value.repair_reason === input.repair_reason &&
				existing.value.reviewer.provider === input.reviewer.provider &&
				existing.value.reviewer.model === input.reviewer.model && input.now >= existing.value.decided_at;
			return sameRequest
				? { ok: true, value: existing.value }
				: failure("conflict", "semantic repair decision is immutable");
		}
		return writeSemanticRepairDecisionLocked(paths, authority, desired, adapter);
	});
}

/** Publish one immutable Sol REPAIR decision for an eligible terminal parent. */
export async function publishDelegationTerminalNegativeRepairDecisionV1(
	projectRoot: string,
	input: PublishDelegationTerminalNegativeRepairDecisionV1Input,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationTerminalNegativeRepairDecisionArtifactV1>> {
	if (!validSemanticRepairReason(input.repair_reason) || !validSolIdentity(input.reviewer) || !isCanonicalTime(input.now)) {
		return failure("invalid_input", "terminal-negative repair requires a bounded reason, active Sol reviewer, and canonical time");
	}
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, input.delegation_id, input.now, adapter, async (paths) => {
		const currentResult = await readStateAt(paths.transaction, adapter);
		if (!currentResult.ok) return currentResult;
		const current = currentResult.value;
		if (!isDelegationTerminalNegativeReviewStateCandidateV1(current)
			|| current.generation !== input.expected_generation || current.revision !== input.expected_revision
			|| current.contract_hash !== input.contract_hash || !sameIdentity(current.worker_identity, input.worker_identity)
			|| input.now < current.updated_at) {
			return failure("conflict", "terminal-negative repair CAS, identity, or lifecycle check failed");
		}
		const generation = generationName(current.generation);
		if (generation === undefined) return failure("invalid_record", "terminal-negative repair generation is invalid");
		const verified = await verifyGenerationDirectory(join(paths.generations, generation), {
			...current, status: "COMMITTING", revision: current.committed_proof!.revision, committed_proof: null, review: null,
		}, adapter);
		if (!verified.ok || !sameJson(verified.value.inventory.proof, current.committed_proof)) {
			return failure("invalid_record", "terminal-negative repair conflicts with the committed generation");
		}
		if (!isDelegationTerminalNegativeReviewEligibleFromCommittedV1(current, verified.value.records)) {
			return failure("invalid_record", "terminal-negative repair has no strictly attributed committed scope");
		}
		const baseRead = await readReviewArtifactAt(paths, current, verified.value.records, adapter);
		if (!baseRead.ok) return baseRead;
		const { bytes: _bytes, ...base } = baseRead.value;
		const authority = { ...base, state: current, finalized: false } as DelegationTerminalNegativeReviewAuthorityV1;
		if (!terminalNegativeDecisionEligible(authority)) {
			return failure("invalid_record", "terminal-negative repair requires a complete PASS provisional schema-2 packet");
		}
		if (input.base_review_hash !== authority.review_hash
			|| input.expected_bound_diff_hash !== authority.review.bound_diff_hash) {
			return failure("conflict", "terminal-negative repair does not match the exact provisional packet");
		}
		for (const ambiguousPath of [paths.semanticRepair, paths.semanticMigration]) {
			try {
				await adapter.inspect(ambiguousPath);
				return failure("invalid_record", "terminal-negative repair conflicts with an ordinary semantic sidecar");
			} catch (error) {
				if (!isErrno(error, "ENOENT")) return failure("storage_failure", "terminal-negative sidecar inspection failed");
			}
		}
		const decisionPayload: Omit<DelegationSemanticRepairDecisionV1, "decision_hash"> = {
			schema_version: 1,
			delegation_id: current.delegation_id,
			contract_hash: current.contract_hash,
			generation: current.generation,
			transaction_revision: 3,
			generation_content_hash: current.committed_proof!.content_hash,
			base_review_hash: authority.review_hash,
			expected_bound_diff_hash: authority.review.bound_diff_hash,
			decision: "REPAIR",
			repair_reason: input.repair_reason,
			repair_reason_hash: semanticRepairReasonHash(input.repair_reason),
			reviewer: structuredClone(input.reviewer),
			decided_at: input.now,
		};
		const decision: DelegationSemanticRepairDecisionV1 = {
			...decisionPayload,
			decision_hash: semanticRepairDecisionHash(decisionPayload),
		};
		const artifactPayload: Omit<DelegationTerminalNegativeRepairDecisionArtifactV1, "artifact_hash"> = {
			schema_version: 1,
			kind: "delegation-terminal-negative-repair-decision-v1",
			delegation_id: current.delegation_id,
			contract_hash: current.contract_hash,
			generation: current.generation,
			transaction_revision: 3,
			terminal_status: current.status,
			parent_state_hash: canonicalHash(current),
			generation_content_hash: current.committed_proof!.content_hash,
			base_review_hash: authority.review_hash,
			expected_bound_diff_hash: authority.review.bound_diff_hash,
			failure_facts_hash: terminalNegativeFailureFactsHash(current),
			decision,
		};
		const desired: DelegationTerminalNegativeRepairDecisionArtifactV1 = {
			...artifactPayload,
			artifact_hash: canonicalHash(artifactPayload),
		};
		if (parseTerminalNegativeRepairArtifactForAuthority(desired, authority) === undefined) {
			return failure("invalid_input", "terminal-negative repair decision is invalid or unbound");
		}
		const existing = await readTerminalNegativeRepairArtifactAt(paths, authority, adapter);
		if (!existing.ok) return existing;
		if (existing.value !== undefined) {
			const sameRequest = existing.value.base_review_hash === input.base_review_hash
				&& existing.value.expected_bound_diff_hash === input.expected_bound_diff_hash
				&& existing.value.decision.repair_reason === input.repair_reason
				&& existing.value.decision.reviewer.provider === input.reviewer.provider
				&& existing.value.decision.reviewer.model === input.reviewer.model
				&& input.now >= existing.value.decision.decided_at;
			return sameRequest ? { ok: true, value: existing.value } : failure("conflict", "terminal-negative repair decision is immutable");
		}
		return writeTerminalNegativeRepairArtifactLocked(paths, authority, desired, adapter);
	});
}

/**
 * Publish the bounded Sol presentation that precedes semantic migration
 * acceptance. Historical review and transaction bytes remain immutable.
 */
export async function publishDelegationSemanticMigrationPresentationV1(
	projectRoot: string,
	input: PublishDelegationSemanticMigrationPresentationV1Input,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationSemanticMigrationV1>> {
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, input.delegation_id, input.now, adapter, async (paths) => {
		const current = await readStateAt(paths.transaction, adapter);
		if (!current.ok) return current;
		const authority = await readHistoricalSemanticMigrationAuthorityLocked(paths, current.value, adapter);
		if (!authority.ok) return authority;
		if (input.contract_hash !== authority.value.state.contract_hash ||
			!sameIdentity(input.worker_identity, authority.value.state.worker_identity) ||
			input.expected_generation !== authority.value.state.generation || input.expected_revision !== 4 ||
			input.base_transaction_revision !== 4 ||
			input.base_review_hash !== authority.value.review_hash ||
			input.expected_bound_diff_hash !== authority.value.review.bound_diff_hash) {
			return failure("conflict", "semantic migration presentation binding does not match finalized authority");
		}
		const desired: DelegationSemanticMigrationPresentedV1 = {
			schema_version: 1,
			delegation_id: authority.value.state.delegation_id,
			task_kind: "implementation",
			contract_hash: input.contract_hash,
			generation: input.expected_generation,
			base_transaction_revision: 4,
			base_review_hash: input.base_review_hash,
			expected_bound_diff_hash: input.expected_bound_diff_hash,
			migration_projection: structuredClone(input.migration_projection),
			presented_at: input.now,
			presenter: structuredClone(input.presenter),
			status: "PRESENTED",
		};
		if (parseSemanticMigrationForAuthority(desired, authority.value) === undefined) {
			return failure("invalid_input", "semantic migration presentation is invalid or unbound");
		}
		const existing = await readSemanticMigrationAt(paths, authority.value, adapter);
		if (!existing.ok) return existing;
		if (existing.value !== undefined) {
			if (existing.value.status === "ACCEPTED") {
				return failure("conflict", "accepted semantic migration is immutable");
			}
			if (sameJson(existing.value, desired)) return { ok: true, value: existing.value };
			// PRESENTED is non-authoritative evidence. A later complete call may
			// atomically replace it after workspace drift; ACCEPTED never may.
		}
		return writeSemanticMigrationLocked(paths, authority.value, desired, adapter);
	});
}

/** Strict PRESENTED -> ACCEPTED transition; an ACCEPTED record is never overwritten. */
export async function acceptDelegationSemanticMigrationV1(
	projectRoot: string,
	input: AcceptDelegationSemanticMigrationV1Input,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationSemanticMigrationV1>> {
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, input.delegation_id, input.now, adapter, async (paths) => {
		const current = await readStateAt(paths.transaction, adapter);
		if (!current.ok) return current;
		const authority = await readHistoricalSemanticMigrationAuthorityLocked(paths, current.value, adapter);
		if (!authority.ok) return authority;
		if (input.contract_hash !== authority.value.state.contract_hash ||
			!sameIdentity(input.worker_identity, authority.value.state.worker_identity) ||
			input.expected_generation !== authority.value.state.generation || input.expected_revision !== 4 ||
			input.base_transaction_revision !== 4 ||
			input.base_review_hash !== authority.value.review_hash ||
			input.expected_bound_diff_hash !== authority.value.review.bound_diff_hash ||
			input.expected_migration_binding_hash !== input.migration_projection.migration_binding_hash) {
			return failure("conflict", "semantic migration acceptance binding does not match finalized authority");
		}
		const existing = await readSemanticMigrationAt(paths, authority.value, adapter);
		if (!existing.ok) return existing;
		if (existing.value === undefined) {
			return failure("conflict", "semantic migration must be presented before acceptance");
		}
		const baseMatches = existing.value.contract_hash === input.contract_hash &&
			existing.value.generation === input.expected_generation && existing.value.base_transaction_revision === 4 &&
			existing.value.base_review_hash === input.base_review_hash &&
			existing.value.expected_bound_diff_hash === input.expected_bound_diff_hash &&
			sameJson(existing.value.migration_projection, input.migration_projection);
		if (!baseMatches) return failure("conflict", "semantic migration acceptance cannot replace the presented projection");
		const desired: DelegationSemanticMigrationAcceptedV1 = {
			...structuredClone(existing.value),
			status: "ACCEPTED",
			acceptance: {
				decision: "ACCEPT",
				expected_bound_diff_hash: input.expected_bound_diff_hash,
				expected_migration_binding_hash: input.expected_migration_binding_hash,
				reviewer: structuredClone(input.reviewer),
				accepted_at: input.now,
			},
		};
		if (parseSemanticMigrationForAuthority(desired, authority.value) === undefined) {
			return failure("invalid_input", "semantic migration acceptance is invalid or unbound");
		}
		if (existing.value.status === "ACCEPTED") {
			return sameJson(existing.value, desired)
				? { ok: true, value: existing.value }
				: failure("conflict", "accepted semantic migration is immutable");
		}
		return writeSemanticMigrationLocked(paths, authority.value, desired, adapter);
	});
}

export async function publishHistoricalSemanticMigrationPresentationV2(
	projectRoot: string,
	input: PublishHistoricalSemanticMigrationPresentationV2Input,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<HistoricalSemanticMigrationRecordV2>> {
	if (input.expected_revision !== 4) {
		return failure("conflict", "historical semantic migration requires transaction revision 4");
	}
	return publishDelegationSemanticMigrationPresentationV1(projectRoot, {
		delegation_id: input.delegation_id,
		contract_hash: input.contract_hash,
		worker_identity: structuredClone(input.worker_identity),
		expected_generation: input.expected_generation,
		expected_revision: 4,
		base_transaction_revision: 4,
		base_review_hash: input.base_review_hash,
		expected_bound_diff_hash: input.expected_bound_diff_hash,
		migration_projection: structuredClone(input.projection),
		presenter: structuredClone(input.presenter),
		now: input.now,
	}, options);
}

export async function publishHistoricalSemanticMigrationAcceptanceV2(
	projectRoot: string,
	input: PublishHistoricalSemanticMigrationAcceptanceV2Input,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<HistoricalSemanticMigrationRecordV2>> {
	if (input.expected_revision !== 4) {
		return failure("conflict", "historical semantic migration requires transaction revision 4");
	}
	return acceptDelegationSemanticMigrationV1(projectRoot, {
		delegation_id: input.delegation_id,
		contract_hash: input.contract_hash,
		worker_identity: structuredClone(input.worker_identity),
		expected_generation: input.expected_generation,
		expected_revision: 4,
		base_transaction_revision: 4,
		base_review_hash: input.base_review_hash,
		expected_bound_diff_hash: input.expected_bound_diff_hash,
		expected_migration_binding_hash: input.expected_migration_binding_hash,
		migration_projection: structuredClone(input.projection),
		reviewer: structuredClone(input.reviewer),
		now: input.now,
	}, options);
}

/** Embedded strict acceptance, true zero delta, or an exact accepted migration. */
export function hasDelegationSemanticReviewAuthorityV2(authority: DelegationReviewAuthorityV2): boolean {
	const evidenceAccepted = authority.semantic_evidence_v2 !== undefined
		&& parseSemanticReviewEvidenceV2ForAuthority(authority.semantic_evidence_v2, authority)?.final_decision === "ACCEPT";
	return authority.finalized && authority.state.status === "REVIEWED" && (evidenceAccepted || isStrictSemanticAcceptedOrZeroDelta(authority.review) ||
		(authority.semantic_migration !== undefined &&
			parseSemanticMigrationForAuthority(authority.semantic_migration, authority)?.status === "ACCEPTED"));
}

export const isDelegationReviewAuthoritySemanticallyAccepted = hasDelegationSemanticReviewAuthorityV2;

/** Exact immutable REPAIR provenance only; deliberately never semantic review/Gate authority. */
export function hasDelegationSemanticRepairAuthorityV2(authority: DelegationReviewAuthorityV2): boolean {
	const evidenceRepair = authority.semantic_evidence_v2 !== undefined
		&& parseSemanticReviewEvidenceV2ForAuthority(authority.semantic_evidence_v2, authority)?.final_decision === "REPAIR";
	return authority.semantic_repair !== undefined && parseSemanticRepairDecisionForAuthority(authority.semantic_repair, authority) !== undefined
		&& (authority.semantic_evidence_v2 === undefined || evidenceRepair);
}

export function hasDelegationTerminalNegativeSemanticRepairAuthorityV1(
	authority: DelegationTerminalNegativeReviewAuthorityV1,
): boolean {
	return authority.terminal_negative_repair !== undefined &&
		parseTerminalNegativeRepairArtifactForAuthority(authority.terminal_negative_repair, authority) !== undefined;
}

/** Persist a terminal-negative packet without changing its terminal state. */
export async function persistDelegationTerminalNegativeReviewProvisionalV1(
	projectRoot: string,
	input: PublishDelegationReviewV2Input,
	options?: DelegationTransactionStorageOptions,
): Promise<DelegationTransactionStorageResult<DelegationTerminalNegativeReviewAuthorityV1>> {
	const adapter = adapterOf(options);
	return withDelegationLock(projectRoot, input.delegation_id, input.now, adapter, async (paths) => {
		const currentResult = await readStateAt(paths.transaction, adapter);
		if (!currentResult.ok) return currentResult;
		const current = currentResult.value;
		if (!isDelegationTerminalNegativeReviewStateCandidateV1(current) || current.generation !== input.expected_generation
			|| current.revision !== input.expected_revision || current.contract_hash !== input.contract_hash
			|| !sameIdentity(current.worker_identity, input.worker_identity) || input.now !== input.artifact.reviewed_at) {
			return failure("conflict", "terminal-negative provisional review CAS, identity, or lifecycle check failed");
		}
		const artifact = parseReviewArtifactForState(input.artifact, current);
		if (artifact === undefined || artifact.review.schema_version !== 2
			|| artifact.review.semantic_review !== "required" || artifact.review.semantic_acceptance !== undefined) {
			return failure("invalid_input", "terminal-negative review requires a schema-2 REPAIR-only provisional packet");
		}
		const generation = generationName(current.generation);
		if (generation === undefined) return failure("invalid_record", "terminal-negative review generation is invalid");
		const verified = await verifyGenerationDirectory(join(paths.generations, generation), {
			...current, status: "COMMITTING", revision: current.committed_proof!.revision, committed_proof: null, review: null,
		}, adapter);
		if (!verified.ok || !sameJson(verified.value.inventory.proof, current.committed_proof)
			|| !reviewArtifactBindsGeneration(artifact, verified.value.records, current)) {
			return failure("invalid_record", "terminal-negative provisional review conflicts with the committed generation");
		}
		if (!isDelegationTerminalNegativeReviewEligibleFromCommittedV1(current, verified.value.records)) {
			return failure("invalid_record", "terminal-negative provisional review has no strictly attributed committed scope");
		}
		for (const frozenPath of [paths.semanticRepair, paths.semanticMigration, paths.terminalNegativeRepair]) {
			try {
				await adapter.inspect(frozenPath);
				return failure("conflict", "an immutable semantic sidecar freezes the terminal-negative review packet");
			} catch (error) {
				if (!isErrno(error, "ENOENT")) return failure("storage_failure", "terminal-negative sidecar inspection failed");
			}
		}
		const written = await writeReviewArtifactLocked(paths, current, verified.value.records, artifact, adapter);
		if (!written.ok) return written;
		const { bytes: _bytes, ...authority } = written.value;
		return { ok: true, value: { ...authority, state: current, finalized: false } as DelegationTerminalNegativeReviewAuthorityV1 };
	});
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
			if (artifact.review.semantic_review === "accepted" || artifact.review.semantic_acceptance !== undefined) {
				return failure("invalid_input", "provisional review cannot self-publish semantic acceptance");
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
		const repair = await readSemanticRepairBeforeReviewMutation(paths, current, verified.value.records, adapter);
		if (!repair.ok) return repair;
		if (repair.value !== undefined) {
			return failure("conflict", "semantic repair decision freezes the provisional review packet");
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
			!isStrictSemanticAcceptedOrZeroDelta(parsedArtifact.review)) {
			return failure("invalid_input", "only a complete untruncated scope/integrity PASS packet may finalize a delegation");
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
		const repair = await readSemanticRepairBeforeReviewMutation(paths, current, verified.value.records, adapter);
		if (!repair.ok) return repair;
		if (repair.value !== undefined) {
			return failure("conflict", "semantic repair decision forbids later semantic ACCEPT publication");
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
