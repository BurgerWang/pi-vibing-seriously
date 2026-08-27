/**
 * Immutable non-acceptance receipts for abandoned delegation authority.
 *
 * A blocker closure applies only to a readable, inactive transaction whose
 * exact worker/repair paths are clean in the current Git status. Unrelated
 * user changes are deliberately preserved. An authority quarantine applies
 * only to an unreadable v2 envelope, binds its complete bounded inventory,
 * and refuses any envelope with an execution owner or transaction lock.
 * Neither receipt changes Git or grants review/acceptance authority.
 */

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { canonicalHash } from "../cache/canonical-hash.ts";
import { validateChangeSet, type ChangeSetRecord } from "./change-set.ts";
import { readDelegationCommittedGenerationV2 } from "./delegation-transaction-storage.ts";
import {
	DELEGATION_TRANSACTION_HASH_RE,
	DELEGATION_TRANSACTION_ID_RE,
	exactDelegationRepairAllowedPathsV1,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";
import { validateWorkspaceGuard, type WorkspaceGuardRecord } from "./workspace-guard.ts";
import {
	captureStreamingIdentities,
	type StreamingPathIdentity,
} from "./streaming-identity.ts";
import {
	readWorkerWriteJournal,
	validateWorkerWriteJournalRecord,
	type WorkerWriteJournalRecord,
} from "./write-journal.ts";
import {
	isRecoverableUnpublishedPathAuthorityCandidateV1,
	readRecoverableUnpublishedPathAuthorityV1,
} from "./recoverable-unpublished-path-authority.ts";

const BLOCKER_DIR_NAME = "blocker-closures-v2";
const QUARANTINE_DIR_NAME = "delegation-authority-quarantine-v1";
const RECEIPT_MAX_BYTES = 256 * 1024;
const INVENTORY_MAX_ENTRIES = 512;
const INVENTORY_MAX_FILE_BYTES = 4 * 1024 * 1024;
const INVENTORY_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/u;
const HEAD_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/u;
const BOOTSTRAP_ACTIVE_NAMES = new Set(["execution-owner.json", "transaction.lock"]);

export interface DelegationInactiveBlockerClosureV2 {
	schema_version: 2;
	kind: "inactive-delegation-blocker-closure-v2";
	delegation_id: string;
	contract_hash: string;
	generation: number;
	transaction_revision: number;
	transaction_status: DelegationTransactionRecord["status"];
	transaction_hash: string;
	relevant_paths: string[];
	relevant_paths_hash: string;
	observed_git_head: string;
	observed_workspace_guard_hash: string;
	relevant_clean_guard_hash: string;
	closed_by: { provider: "openai" | "openai-codex"; model: "gpt-5.6-sol" };
	closed_at: string;
	closure_hash: string;
}

interface DelegationAuthorityInventoryEntryV1 {
	path: string;
	kind: "file" | "directory";
	byte_size: number;
	content_hash: string | null;
}

export interface DelegationAuthorityQuarantineV1 {
	schema_version: 1;
	kind: "delegation-authority-quarantine-v1";
	delegation_id: string;
	issue_code: string;
	inventory_hash: string;
	inventory_entry_count: number;
	inventory_total_bytes: number;
	quarantined_by: { provider: "openai" | "openai-codex"; model: "gpt-5.6-sol" };
	quarantined_at: string;
	quarantine_hash: string;
}

export type DelegationAuthorityClosureResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: { code: "invalid_input" | "invalid_record" | "not_found" | "not_recoverable" | "conflict" | "storage_failure" } };

interface DelegationAuthorityInventoryV1 {
	entries: DelegationAuthorityInventoryEntryV1[];
	inventory_hash: string;
	total_bytes: number;
}

const BLOCKER_FIELDS = [
	"schema_version", "kind", "delegation_id", "contract_hash", "generation", "transaction_revision",
	"transaction_status", "transaction_hash", "relevant_paths", "relevant_paths_hash", "observed_git_head",
	"observed_workspace_guard_hash", "relevant_clean_guard_hash", "closed_by", "closed_at", "closure_hash",
] as const;

const QUARANTINE_FIELDS = [
	"schema_version", "kind", "delegation_id", "issue_code", "inventory_hash", "inventory_entry_count",
	"inventory_total_bytes", "quarantined_by", "quarantined_at", "quarantine_hash",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function isCanonicalTime(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 20 || value.length > 64 || !value.endsWith("Z")) return false;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validSol(value: unknown): value is DelegationInactiveBlockerClosureV2["closed_by"] {
	return isRecord(value) && Object.keys(value).length === 2 &&
		(value.provider === "openai" || value.provider === "openai-codex") && value.model === "gpt-5.6-sol";
}

function encode(value: unknown): Buffer | undefined {
	const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
	return bytes.length <= RECEIPT_MAX_BYTES ? bytes : undefined;
}

async function readBoundedFile(path: string, maximum: number): Promise<Buffer> {
	const before = await lstat(path, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink() || before.size < 0n || before.size > BigInt(maximum)) {
		throw new Error("unsafe bounded authority file");
	}
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
			throw new Error("authority file identity changed");
		}
		const bytes = Buffer.alloc(Number(opened.size));
		let offset = 0;
		while (offset < bytes.length) {
			const result = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (result.bytesRead <= 0) throw new Error("short authority file read");
			offset += result.bytesRead;
		}
		const after = await handle.stat({ bigint: true });
		if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
			after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
			throw new Error("authority file changed during read");
		}
		return bytes;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function publishNoClobber(path: string, bytes: Buffer, prefix: string): Promise<"published" | "exists" | "failed"> {
	const directory = dirname(path);
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const stat = await lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return "failed";
	} catch {
		return "failed";
	}
	const temp = join(directory, `.${prefix}.${randomBytes(16).toString("hex")}.tmp`);
	try {
		const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
		try {
			await link(temp, path);
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
			return "exists";
		}
		const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
		try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
		return "published";
	} catch {
		return "failed";
	} finally {
		await unlink(temp).catch(() => undefined);
	}
}

function blockerPath(projectRoot: string, delegationId: string, transactionHash: string): string | undefined {
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId) || !DELEGATION_TRANSACTION_HASH_RE.test(transactionHash)) return undefined;
	return join(resolve(projectRoot), CONFIG_DIR_NAME, "workbench", "delegations", delegationId, "v2", BLOCKER_DIR_NAME, `${transactionHash}.json`);
}

function quarantinePath(projectRoot: string, delegationId: string, inventoryHash: string): string | undefined {
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId) || !HASH_RE.test(inventoryHash)) return undefined;
	return join(resolve(projectRoot), CONFIG_DIR_NAME, "workbench", QUARANTINE_DIR_NAME, delegationId, `${inventoryHash}.json`);
}

function v2Path(projectRoot: string, delegationId: string): string | undefined {
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId)) return undefined;
	return join(resolve(projectRoot), CONFIG_DIR_NAME, "workbench", "delegations", delegationId, "v2");
}

/** Exact paths whose uncommitted worker/repair delta must have been discarded. */
export function inactiveBlockerRelevantPathsV2(transaction: DelegationTransactionRecord): string[] | undefined {
	const paths = new Set<string>([
		...(transaction.terminal_outcome?.changed_paths ?? []),
		...(transaction.repair_lineage?.carried_paths ?? []),
	]);
	if (paths.size === 0) {
		const outcome = transaction.terminal_outcome;
		// A committed, complete ChangeSet can prove that the exact worker delta
		// is empty. Directory-shaped allowed_paths are permission, not evidence;
		// workspace drift remains unrelated, while attribution conflicts do not.
		const committedZeroDelta = transaction.committed_proof !== null && outcome !== null &&
			outcome.terminal_facts_complete && outcome.scope_complete &&
			outcome.change_set_status !== "CONFLICT" && outcome.changed_paths.length === 0 &&
			(transaction.task_kind !== "implementation" || outcome.delta_hash !== null);
		if (committedZeroDelta) return [];
	}
	if (paths.size === 0) {
		const exact = exactDelegationRepairAllowedPathsV1(transaction.allowed_paths);
		if (exact !== undefined) for (const path of exact) paths.add(path);
	}
	const sorted = [...paths].sort(byteCompare);
	return sorted.length > 0 && sorted.length <= 500 ? sorted : undefined;
}

function exactAllowedFallbackPathsV2(transaction: DelegationTransactionRecord): string[] | undefined {
	const exact = exactDelegationRepairAllowedPathsV1(transaction.allowed_paths);
	if (exact === undefined) return undefined;
	const paths = new Set<string>([
		...exact,
		...(transaction.repair_lineage?.carried_paths ?? []),
	]);
	const sorted = [...paths].sort(byteCompare);
	return sorted.length > 0 && sorted.length <= 500 ? sorted : undefined;
}

interface ResolvedInactiveBlockerPathsV2 {
	paths: string[];
	journal_before: StreamingPathIdentity[];
}

function journalRelevantPathsV2(
	transaction: DelegationTransactionRecord,
	journal: WorkerWriteJournalRecord,
	changeSet?: ChangeSetRecord,
): ResolvedInactiveBlockerPathsV2 | undefined {
	if (!validateWorkerWriteJournalRecord(journal) || journal.state !== "SEALED" || journal.journal_hash === null ||
		journal.delegation_id !== transaction.delegation_id || journal.contract_hash !== transaction.contract_hash) return undefined;
	const successfulWrites = journal.operations.filter((operation) =>
		operation.status === "completed" && operation.outcome === "succeeded").length;
	if (transaction.terminal_outcome !== null && transaction.terminal_outcome.successful_write_count !== successfulWrites) return undefined;
	const touchedPaths = new Set(journal.operations.map((operation) => operation.path));
	const beforeByPath = new Map<string, StreamingPathIdentity>();
	for (const operation of journal.operations) {
		if (!beforeByPath.has(operation.path)) beforeByPath.set(operation.path, operation.before);
	}
	if (changeSet !== undefined) {
		if (transaction.terminal_outcome === null || !validateChangeSet(changeSet) ||
			changeSet.delegation_id !== transaction.delegation_id ||
			changeSet.contract_hash !== transaction.contract_hash || changeSet.journal_hash !== journal.journal_hash ||
			changeSet.status !== transaction.terminal_outcome.change_set_status ||
			changeSet.counts.touched_paths !== touchedPaths.size ||
			changeSet.worker_delta.some((entry) => !touchedPaths.has(entry.path)) ||
			changeSet.conflicts.some((entry) => !touchedPaths.has(entry.path))) return undefined;
	}
	for (const path of transaction.repair_lineage?.carried_paths ?? []) touchedPaths.add(path);
	const sorted = [...touchedPaths].sort(byteCompare);
	if (sorted.length > 500) return undefined;
	return {
		paths: sorted,
		journal_before: [...beforeByPath.entries()]
			.sort(([left], [right]) => byteCompare(left, right))
			.map(([, identity]) => identity),
	};
}

function evidenceReadFailure(code: string): DelegationAuthorityClosureResult<ResolvedInactiveBlockerPathsV2> {
	return {
		ok: false,
		error: {
			code: code === "storage_failure"
				? "storage_failure"
				: code === "not_found"
					? "not_found"
					: code === "not_recoverable"
						? "not_recoverable"
						: "invalid_record",
		},
	};
}

async function committedJournalRelevantPathsV2(
	projectRoot: string,
	transaction: DelegationTransactionRecord,
): Promise<DelegationAuthorityClosureResult<ResolvedInactiveBlockerPathsV2>> {
	const committed = await readDelegationCommittedGenerationV2(projectRoot, transaction.delegation_id);
	if (!committed.ok) return evidenceReadFailure(committed.error.code);
	if (canonicalHash(committed.value.state) !== canonicalHash(transaction)) {
		return { ok: false, error: { code: "conflict" } };
	}
	const scope = committed.value.records["scope.json"];
	if (!isRecord(scope) || !validateWorkerWriteJournalRecord(scope.write_journal) || !validateChangeSet(scope.change_set)) {
		return { ok: false, error: { code: "invalid_record" } };
	}
	const paths = journalRelevantPathsV2(transaction, scope.write_journal, scope.change_set);
	return paths === undefined
		? { ok: false, error: { code: "invalid_record" } }
		: { ok: true, value: paths };
}

/** Resolve exact discarded-delta paths from transaction, generation, or sealed journal authority. */
async function resolveInactiveBlockerRelevantPathsV2(
	projectRoot: string,
	transaction: DelegationTransactionRecord,
): Promise<DelegationAuthorityClosureResult<ResolvedInactiveBlockerPathsV2>> {
	if (isRecoverableUnpublishedPathAuthorityCandidateV1(transaction)) {
		const recoverable = await readRecoverableUnpublishedPathAuthorityV1(
			projectRoot,
			transaction.delegation_id,
		);
		if (!recoverable.ok) return evidenceReadFailure(recoverable.error.code);
		if (recoverable.value.transaction_hash !== canonicalHash(transaction)) {
			return { ok: false, error: { code: "conflict" } };
		}
		// Path-local admission may safely use the conservative union even when a
		// command-only path has no durable before identity.  A closure is stronger:
		// every relevant path must be provably restored to its exact pre-worker
		// content, including Git-ignored paths.
		if (!recoverable.value.baseline_complete) {
			return { ok: false, error: { code: "not_recoverable" } };
		}
		return {
			ok: true,
			value: {
				paths: [...recoverable.value.relevant_paths],
				journal_before: [...recoverable.value.journal_before],
			},
		};
	}
	const outcome = transaction.terminal_outcome;
	if (outcome === null || !outcome.terminal_facts_complete || !outcome.scope_complete) {
		if (transaction.committed_proof === null) {
			const journal = await readWorkerWriteJournal({
				project_root: projectRoot,
				delegation_id: transaction.delegation_id,
				contract_hash: transaction.contract_hash,
			});
			if (journal.ok) {
				const evidence = journalRelevantPathsV2(transaction, journal.value);
				if (evidence !== undefined) return { ok: true, value: evidence };
			}
		}
		const fallback = exactAllowedFallbackPathsV2(transaction);
		return fallback === undefined
			? { ok: false, error: { code: "invalid_input" } }
			: { ok: true, value: { paths: fallback, journal_before: [] } };
	}
	if (outcome.change_set_status === "CONFLICT") {
		if (transaction.committed_proof !== null) {
			return committedJournalRelevantPathsV2(projectRoot, transaction);
		}
		const journal = await readWorkerWriteJournal({
			project_root: projectRoot,
			delegation_id: transaction.delegation_id,
			contract_hash: transaction.contract_hash,
		});
		if (journal.ok) {
			const evidence = journalRelevantPathsV2(transaction, journal.value);
			if (evidence !== undefined) return { ok: true, value: evidence };
		}
		const fallback = exactAllowedFallbackPathsV2(transaction);
		if (fallback !== undefined) return { ok: true, value: { paths: fallback, journal_before: [] } };
		return journal.ok
			? { ok: false, error: { code: "invalid_record" } }
			: evidenceReadFailure(journal.error.code);
	}
	const direct = inactiveBlockerRelevantPathsV2(transaction);
	if (direct !== undefined) return { ok: true, value: { paths: direct, journal_before: [] } };
	if (transaction.committed_proof === null && outcome.changed_paths.length === 0) {
		const journal = await readWorkerWriteJournal({
			project_root: projectRoot,
			delegation_id: transaction.delegation_id,
			contract_hash: transaction.contract_hash,
		});
		if (journal.ok) {
			const evidence = journalRelevantPathsV2(transaction, journal.value);
			if (evidence !== undefined) return { ok: true, value: evidence };
		}
	}
	const fallback = exactAllowedFallbackPathsV2(transaction);
	return fallback === undefined
		? { ok: false, error: { code: "invalid_input" } }
		: { ok: true, value: { paths: fallback, journal_before: [] } };
}

function sameContentIdentity(left: StreamingPathIdentity, right: StreamingPathIdentity): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "missing" || right.kind === "missing") return left.kind === right.kind;
	return left.byte_size === right.byte_size && left.sha256 === right.sha256;
}

async function journalBaselineRestoredV2(
	projectRoot: string,
	baseline: readonly StreamingPathIdentity[],
): Promise<boolean> {
	if (baseline.length === 0) return true;
	const current = await captureStreamingIdentities({
		project_root: projectRoot,
		paths: baseline.map((identity) => identity.path),
	});
	return current.ok && current.identities.length === baseline.length &&
		current.identities.every((identity, index) => sameContentIdentity(identity, baseline[index]!));
}

function isInactiveClosableStatus(transaction: DelegationTransactionRecord): boolean {
	if (["PREPARED", "RUNNING", "COMMITTING", "FINISHED", "REVIEWED"].includes(transaction.status)) return false;
	if (transaction.status === "ABORTED") return transaction.repair_lineage !== undefined;
	return transaction.status === "PENDING_REVIEW" || transaction.status === "FAILED" || transaction.status === "RECOVERY_REQUIRED";
}

function blockerPayloadHash(value: Omit<DelegationInactiveBlockerClosureV2, "closure_hash">): string {
	return canonicalHash(value);
}

function normalizeBlocker(
	value: unknown,
	transaction: DelegationTransactionRecord,
	relevantPaths: readonly string[],
): DelegationInactiveBlockerClosureV2 | undefined {
	if (!isInactiveClosableStatus(transaction) || !isRecord(value) ||
		!exactFields(value, BLOCKER_FIELDS) || value.schema_version !== 2 ||
		value.kind !== "inactive-delegation-blocker-closure-v2" || value.delegation_id !== transaction.delegation_id ||
		value.contract_hash !== transaction.contract_hash || value.generation !== transaction.generation ||
		value.transaction_revision !== transaction.revision || value.transaction_status !== transaction.status ||
		value.transaction_hash !== canonicalHash(transaction) || !Array.isArray(value.relevant_paths) ||
		value.relevant_paths.length !== relevantPaths.length ||
		!value.relevant_paths.every((path, index) => path === relevantPaths[index]) ||
		value.relevant_paths_hash !== canonicalHash(relevantPaths) || typeof value.observed_git_head !== "string" ||
		!HEAD_RE.test(value.observed_git_head) || typeof value.observed_workspace_guard_hash !== "string" ||
		!HASH_RE.test(value.observed_workspace_guard_hash) || typeof value.relevant_clean_guard_hash !== "string" ||
		value.relevant_clean_guard_hash !== canonicalHash({
			schema_version: 1,
			kind: "delegation-relevant-clean-guard-v1",
			git_head: value.observed_git_head,
			relevant_paths: relevantPaths,
			dirty_entries: [],
		}) || !validSol(value.closed_by) || !isCanonicalTime(value.closed_at) ||
		Date.parse(value.closed_at) < Date.parse(transaction.updated_at) || typeof value.closure_hash !== "string" ||
		!HASH_RE.test(value.closure_hash)) return undefined;
	const { closure_hash, ...payload } = value;
	if (closure_hash !== blockerPayloadHash(payload as Omit<DelegationInactiveBlockerClosureV2, "closure_hash">)) return undefined;
	return value as unknown as DelegationInactiveBlockerClosureV2;
}

/** Strict optional read. A valid receipt closes no code and only this transaction blocker. */
export async function readDelegationInactiveBlockerClosureV2(
	projectRoot: string,
	transaction: DelegationTransactionRecord,
): Promise<DelegationAuthorityClosureResult<DelegationInactiveBlockerClosureV2 | undefined>> {
	const path = blockerPath(projectRoot, transaction.delegation_id, canonicalHash(transaction));
	if (path === undefined) return { ok: false, error: { code: "invalid_input" } };
	try {
		const bytes = await readBoundedFile(path, RECEIPT_MAX_BYTES);
		let decoded: unknown;
		try { decoded = JSON.parse(bytes.toString("utf8")); } catch { return { ok: false, error: { code: "invalid_record" } }; }
		// A proof-null artifact failure must never accept the older changed-paths
		// projection, which omitted journal-only/ignored paths and before identities.
		const legacyPaths = isRecoverableUnpublishedPathAuthorityCandidateV1(transaction)
			? undefined
			: inactiveBlockerRelevantPathsV2(transaction);
		let record = legacyPaths === undefined ? undefined : normalizeBlocker(decoded, transaction, legacyPaths);
		if (record === undefined) {
			const resolved = await resolveInactiveBlockerRelevantPathsV2(projectRoot, transaction);
			if (!resolved.ok) return resolved;
			record = normalizeBlocker(decoded, transaction, resolved.value.paths);
		}
		const canonical = record === undefined ? undefined : encode(record);
		return record !== undefined && canonical !== undefined && canonical.equals(bytes)
			? { ok: true, value: record }
			: { ok: false, error: { code: "invalid_record" } };
	} catch (error) {
		return isErrno(error, "ENOENT") ? { ok: true, value: undefined } : { ok: false, error: { code: "storage_failure" } };
	}
}

/** Publish one no-clobber, relevant-scope clean closure for an inactive blocker. */
export async function publishDelegationInactiveBlockerClosureV2(input: {
	project_root: string;
	transaction: DelegationTransactionRecord;
	workspace_guard: WorkspaceGuardRecord;
	closed_by: DelegationInactiveBlockerClosureV2["closed_by"];
	now: string;
}): Promise<DelegationAuthorityClosureResult<DelegationInactiveBlockerClosureV2>> {
	const path = blockerPath(input.project_root, input.transaction.delegation_id, canonicalHash(input.transaction));
	if (path === undefined || !isInactiveClosableStatus(input.transaction) ||
		!validateWorkspaceGuard(input.workspace_guard) || input.workspace_guard.git_head === null ||
		!validSol(input.closed_by) || !isCanonicalTime(input.now)) {
		return { ok: false, error: { code: "invalid_input" } };
	}
	const existing = await readDelegationInactiveBlockerClosureV2(input.project_root, input.transaction);
	if (!existing.ok) return existing;
	if (existing.value !== undefined) return { ok: true, value: existing.value };
	const resolved = await resolveInactiveBlockerRelevantPathsV2(input.project_root, input.transaction);
	if (!resolved.ok) return resolved;
	const relevantPaths = resolved.value.paths;
	const relevant = new Set(relevantPaths);
	if (input.workspace_guard.entries.some((entry) => relevant.has(entry.path))) {
		return { ok: false, error: { code: "not_recoverable" } };
	}
	if (!await journalBaselineRestoredV2(input.project_root, resolved.value.journal_before)) {
		return { ok: false, error: { code: "not_recoverable" } };
	}
	const payload: Omit<DelegationInactiveBlockerClosureV2, "closure_hash"> = {
		schema_version: 2,
		kind: "inactive-delegation-blocker-closure-v2",
		delegation_id: input.transaction.delegation_id,
		contract_hash: input.transaction.contract_hash,
		generation: input.transaction.generation,
		transaction_revision: input.transaction.revision,
		transaction_status: input.transaction.status,
		transaction_hash: canonicalHash(input.transaction),
		relevant_paths: relevantPaths,
		relevant_paths_hash: canonicalHash(relevantPaths),
		observed_git_head: input.workspace_guard.git_head,
		observed_workspace_guard_hash: input.workspace_guard.workspace_guard_hash,
		relevant_clean_guard_hash: canonicalHash({
			schema_version: 1,
			kind: "delegation-relevant-clean-guard-v1",
			git_head: input.workspace_guard.git_head,
			relevant_paths: relevantPaths,
			dirty_entries: [],
		}),
		closed_by: { ...input.closed_by },
		closed_at: input.now,
	};
	const desired: DelegationInactiveBlockerClosureV2 = { ...payload, closure_hash: blockerPayloadHash(payload) };
	if (normalizeBlocker(desired, input.transaction, relevantPaths) === undefined) return { ok: false, error: { code: "invalid_input" } };
	const bytes = encode(desired);
	if (bytes === undefined) return { ok: false, error: { code: "invalid_input" } };
	const published = await publishNoClobber(path, bytes, "blocker-closure");
	if (published === "failed") return { ok: false, error: { code: "storage_failure" } };
	const final = await readDelegationInactiveBlockerClosureV2(input.project_root, input.transaction);
	if (!final.ok || final.value === undefined) return final.ok
		? { ok: false, error: { code: "storage_failure" } }
		: final;
	return final.value.closure_hash === desired.closure_hash
		? { ok: true, value: final.value }
		: { ok: false, error: { code: "conflict" } };
}

async function collectAuthorityInventoryV1(projectRoot: string, delegationId: string): Promise<DelegationAuthorityClosureResult<DelegationAuthorityInventoryV1>> {
	const root = v2Path(projectRoot, delegationId);
	if (root === undefined) return { ok: false, error: { code: "invalid_input" } };
	const entries: DelegationAuthorityInventoryEntryV1[] = [];
	let totalBytes = 0;
	const walk = async (directory: string, relative: string): Promise<void> => {
		const stat = await lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe authority directory");
		const children = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
		children.sort((left, right) => byteCompare(left.name, right.name));
		for (const child of children) {
			if (entries.length >= INVENTORY_MAX_ENTRIES || child.isSymbolicLink() || child.name.includes("/") || child.name.includes("\0")) {
				throw new Error("unsafe authority inventory");
			}
			const childRelative = relative.length === 0 ? child.name : posix.join(relative, child.name);
			const childPath = join(directory, child.name);
			if (BOOTSTRAP_ACTIVE_NAMES.has(childRelative)) throw new Error("authority may still be active");
			if (child.isDirectory()) {
				entries.push({ path: childRelative, kind: "directory", byte_size: 0, content_hash: null });
				await walk(childPath, childRelative);
				continue;
			}
			if (!child.isFile()) throw new Error("unsafe authority entry");
			const bytes = await readBoundedFile(childPath, INVENTORY_MAX_FILE_BYTES);
			totalBytes += bytes.length;
			if (totalBytes > INVENTORY_MAX_TOTAL_BYTES) throw new Error("authority inventory is too large");
			entries.push({
				path: childRelative,
				kind: "file",
				byte_size: bytes.length,
				content_hash: createHash("sha256").update(bytes).digest("hex"),
			});
		}
	};
	try {
		await walk(root, "");
		return {
			ok: true,
			value: {
				entries,
				inventory_hash: canonicalHash({ schema_version: 1, kind: "delegation-authority-inventory-v1", entries }),
				total_bytes: totalBytes,
			},
		};
	} catch (error) {
		return isErrno(error, "ENOENT")
			? { ok: false, error: { code: "not_found" } }
			: { ok: false, error: { code: "not_recoverable" } };
	}
}

function quarantinePayloadHash(value: Omit<DelegationAuthorityQuarantineV1, "quarantine_hash">): string {
	return canonicalHash(value);
}

function normalizeQuarantine(value: unknown, delegationId: string): DelegationAuthorityQuarantineV1 | undefined {
	if (!isRecord(value) || !exactFields(value, QUARANTINE_FIELDS) || value.schema_version !== 1 ||
		value.kind !== "delegation-authority-quarantine-v1" || value.delegation_id !== delegationId ||
		typeof value.issue_code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(value.issue_code) ||
		typeof value.inventory_hash !== "string" || !HASH_RE.test(value.inventory_hash) ||
		!Number.isSafeInteger(value.inventory_entry_count) || Number(value.inventory_entry_count) < 0 ||
		Number(value.inventory_entry_count) > INVENTORY_MAX_ENTRIES || !Number.isSafeInteger(value.inventory_total_bytes) ||
		Number(value.inventory_total_bytes) < 0 || Number(value.inventory_total_bytes) > INVENTORY_MAX_TOTAL_BYTES ||
		!validSol(value.quarantined_by) || !isCanonicalTime(value.quarantined_at) ||
		typeof value.quarantine_hash !== "string" || !HASH_RE.test(value.quarantine_hash)) return undefined;
	const { quarantine_hash, ...payload } = value;
	if (quarantine_hash !== quarantinePayloadHash(payload as Omit<DelegationAuthorityQuarantineV1, "quarantine_hash">)) return undefined;
	return value as unknown as DelegationAuthorityQuarantineV1;
}

/** Read and revalidate an optional quarantine against the envelope's current bytes. */
export async function readDelegationAuthorityQuarantineV1(
	projectRoot: string,
	delegationId: string,
): Promise<DelegationAuthorityClosureResult<DelegationAuthorityQuarantineV1 | undefined>> {
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId)) return { ok: false, error: { code: "invalid_input" } };
	const inventory = await collectAuthorityInventoryV1(projectRoot, delegationId);
	if (!inventory.ok) return inventory.error.code === "not_found"
		? { ok: true, value: undefined }
		: inventory;
	const path = quarantinePath(projectRoot, delegationId, inventory.value.inventory_hash);
	if (path === undefined) return { ok: false, error: { code: "invalid_input" } };
	let bytes: Buffer;
	try {
		bytes = await readBoundedFile(path, RECEIPT_MAX_BYTES);
	} catch (error) {
		return isErrno(error, "ENOENT") ? { ok: true, value: undefined } : { ok: false, error: { code: "storage_failure" } };
	}
	let decoded: unknown;
	try { decoded = JSON.parse(bytes.toString("utf8")); } catch { return { ok: false, error: { code: "invalid_record" } }; }
	const record = normalizeQuarantine(decoded, delegationId);
	const canonical = record === undefined ? undefined : encode(record);
	if (record === undefined || canonical === undefined || !canonical.equals(bytes)) return { ok: false, error: { code: "invalid_record" } };
	if (inventory.value.inventory_hash !== record.inventory_hash ||
		inventory.value.entries.length !== record.inventory_entry_count || inventory.value.total_bytes !== record.inventory_total_bytes) {
		return { ok: false, error: { code: "invalid_record" } };
	}
	return { ok: true, value: record };
}

/** Publish an immutable quarantine for one stable, ownerless unreadable v2 envelope. */
export async function publishDelegationAuthorityQuarantineV1(input: {
	project_root: string;
	delegation_id: string;
	issue_code: string;
	quarantined_by: DelegationAuthorityQuarantineV1["quarantined_by"];
	now: string;
}): Promise<DelegationAuthorityClosureResult<DelegationAuthorityQuarantineV1>> {
	if (!DELEGATION_TRANSACTION_ID_RE.test(input.delegation_id) || !/^[a-z][a-z0-9_]{0,63}$/u.test(input.issue_code) ||
		!validSol(input.quarantined_by) || !isCanonicalTime(input.now)) {
		return { ok: false, error: { code: "invalid_input" } };
	}
	const inventory = await collectAuthorityInventoryV1(input.project_root, input.delegation_id);
	if (!inventory.ok) return inventory;
	const path = quarantinePath(input.project_root, input.delegation_id, inventory.value.inventory_hash);
	if (path === undefined) return { ok: false, error: { code: "invalid_input" } };
	const payload: Omit<DelegationAuthorityQuarantineV1, "quarantine_hash"> = {
		schema_version: 1,
		kind: "delegation-authority-quarantine-v1",
		delegation_id: input.delegation_id,
		issue_code: input.issue_code,
		inventory_hash: inventory.value.inventory_hash,
		inventory_entry_count: inventory.value.entries.length,
		inventory_total_bytes: inventory.value.total_bytes,
		quarantined_by: { ...input.quarantined_by },
		quarantined_at: input.now,
	};
	const desired: DelegationAuthorityQuarantineV1 = { ...payload, quarantine_hash: quarantinePayloadHash(payload) };
	const bytes = encode(desired);
	if (bytes === undefined || normalizeQuarantine(desired, input.delegation_id) === undefined) {
		return { ok: false, error: { code: "invalid_input" } };
	}
	const existing = await readDelegationAuthorityQuarantineV1(input.project_root, input.delegation_id);
	if (!existing.ok) return existing;
	if (existing.value !== undefined) return { ok: true, value: existing.value };
	const published = await publishNoClobber(path, bytes, "authority-quarantine");
	if (published === "failed") return { ok: false, error: { code: "storage_failure" } };
	const final = await readDelegationAuthorityQuarantineV1(input.project_root, input.delegation_id);
	if (!final.ok || final.value === undefined) return final.ok
		? { ok: false, error: { code: "storage_failure" } }
		: final;
	return final.value.quarantine_hash === desired.quarantine_hash
		? { ok: true, value: final.value }
		: { ok: false, error: { code: "conflict" } };
}
