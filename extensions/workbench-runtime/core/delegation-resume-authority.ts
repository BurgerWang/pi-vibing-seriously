/** Durable and legacy recovery authority for a checkpointed delegation. */

import { randomBytes } from "node:crypto";
import { open, mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { canonicalHash } from "../cache/canonical-hash.ts";
import {
	validateBudgetContinuationAuthorizationV1,
	type BudgetContinuationAuthorizationV1,
} from "./budget-continuation-authorization.ts";
import {
	bindDelegationBoundedTaskContractV2,
	normalizeDelegationBoundedTaskContractV2,
	type DelegationBoundedTaskContractBindingV2,
} from "./delegation-transaction-artifacts.ts";
import {
	recoverPreparedDelegationChangeSetLifecycleV2,
	validatePreparedDelegationChangeSetLifecycleV2,
	type PreparedDelegationChangeSetLifecycleV2,
} from "./delegation-change-set-lifecycle.ts";
import type { ExecFn } from "./config.ts";
import {
	isStrictRetryableCheckpointRepairRecoveryV2,
	readDelegationExecutionOwnerV2,
	readStrictRetryableRawRepairEvidenceV1,
} from "./delegation-execution-owner.ts";
import {
	admitProjectDelegationPathLaneV1,
} from "./delegation-path-lane-admission.ts";
import {
	DELEGATION_PATH_LANE_REQUEST_KIND_V1,
	DELEGATION_PATH_LANE_SCHEMA_VERSION_V1,
	decideDelegationPathLaneV1,
} from "./delegation-path-lane.ts";
import {
	persistRecoveryRequiredDelegationTransaction,
	readDelegationTransactionV2,
	readDelegationWorkerCheckpointV1,
} from "./delegation-transaction-storage.ts";
import {
	BUDGET_PAUSED_RECOVERY_REASON_V2,
	DELEGATION_TRANSACTION_ID_RE,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";
import {
	validateWorkerCheckpointBudgetContinuationV1,
	validateWorkerCheckpointContinuationV1,
	workerCheckpointBudgetContinuationCapsuleV1,
	workerCheckpointContinuationCapsuleV1,
	type WorkerCheckpointV1,
} from "./worker-checkpoint.ts";
import { readWorkerWriteJournal } from "./write-journal.ts";
import { resolveWorkerTaskKind } from "./worker-policy.ts";

export const DELEGATION_RESUME_AUTHORITY_SCHEMA_VERSION_V1 = 1 as const;
export const DELEGATION_RESUME_AUTHORITY_KIND_V1 = "delegation-resume-authority-v1" as const;
export const DELEGATION_RESUME_AUTHORITY_MAX_BYTES_V1 = 2 * 1024 * 1024;
const LEGACY_SESSION_SCAN_MAX_FILES_V1 = 128;
const LEGACY_SESSION_SCAN_MAX_FILE_BYTES_V1 = 8 * 1024 * 1024;
const LEGACY_SESSION_SCAN_MAX_TOTAL_BYTES_V1 = 32 * 1024 * 1024;
const LEGACY_SESSION_SCAN_MAX_LINE_BYTES_V1 = 2 * 1024 * 1024;

export interface DelegationResumeAuthorityRecordV1 {
	readonly schema_version: typeof DELEGATION_RESUME_AUTHORITY_SCHEMA_VERSION_V1;
	readonly kind: typeof DELEGATION_RESUME_AUTHORITY_KIND_V1;
	readonly delegation_id: string;
	readonly contract: Readonly<DelegationBoundedTaskContractBindingV2>;
	readonly prepared: Readonly<PreparedDelegationChangeSetLifecycleV2>;
	readonly authority_hash: string;
}

export interface CheckpointResumeExecutionAuthorityV1 {
	readonly schema_version: 1;
	readonly kind: "checkpoint-resume-execution-authority-v1";
	readonly delegation_id: string;
	readonly contract: Readonly<DelegationBoundedTaskContractBindingV2>;
	readonly transaction: Readonly<DelegationTransactionRecord>;
	readonly checkpoint: Readonly<WorkerCheckpointV1>;
	readonly prepared: Readonly<PreparedDelegationChangeSetLifecycleV2>;
	readonly raw_evidence_hash: string;
	readonly path_lane_authority_hash: string;
	readonly resume_record_hash: string | null;
	/** Present only for a user-authorized fresh bounded spend epoch. */
	readonly budget_continuation?: Readonly<BudgetContinuationAuthorizationV1>;
	readonly authority_hash: string;
}

type ReadResumeAuthorityResultV1 =
	| { ok: true; value: Readonly<DelegationResumeAuthorityRecordV1> | undefined }
	| { ok: false; code: "INVALID_RECORD" | "STORAGE_FAILURE" };

type CollectCheckpointResumeAuthorityResultV1 =
	| { ok: true; value: Readonly<CheckpointResumeExecutionAuthorityV1> }
	| { ok: false; code: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...fields].sort();
	return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function resumeRoot(projectRoot: string, delegationId: string): string | undefined {
	if (typeof projectRoot !== "string" || projectRoot.length === 0 || resolve(projectRoot) !== projectRoot) return undefined;
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId)) return undefined;
	return join(projectRoot, CONFIG_DIR_NAME, "workbench", "delegations", delegationId);
}

function resumePath(projectRoot: string, delegationId: string): string | undefined {
	const root = resumeRoot(projectRoot, delegationId);
	return root === undefined ? undefined : join(root, "resume-authority-v1.json");
}

function projection(record: Omit<DelegationResumeAuthorityRecordV1, "authority_hash">): unknown {
	return record;
}

function validateResumeAuthorityRecordV1(value: unknown): value is DelegationResumeAuthorityRecordV1 {
	if (!isRecord(value) || !exactFields(value, [
		"schema_version", "kind", "delegation_id", "contract", "prepared", "authority_hash",
	]) || value.schema_version !== DELEGATION_RESUME_AUTHORITY_SCHEMA_VERSION_V1
		|| value.kind !== DELEGATION_RESUME_AUTHORITY_KIND_V1
		|| typeof value.delegation_id !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(value.delegation_id)
		|| !isRecord(value.contract) || !validatePreparedDelegationChangeSetLifecycleV2(value.prepared)
		|| typeof value.authority_hash !== "string") return false;
	const { contract_hash: persistedHash, ...payload } = value.contract;
	const rebound = bindDelegationBoundedTaskContractV2(payload as never);
	if (!rebound.ok || rebound.value.contract_hash !== persistedHash
		|| rebound.value.contract_hash !== value.prepared.contract_hash
		|| value.delegation_id !== value.prepared.delegation_id) return false;
	const { authority_hash: supplied, ...withoutHash } = value as unknown as DelegationResumeAuthorityRecordV1;
	return /^[0-9a-f]{64}$/u.test(supplied) && supplied === canonicalHash(projection(withoutHash));
}

function canonicalBytes(value: DelegationResumeAuthorityRecordV1): Buffer {
	return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

export async function persistDelegationResumeAuthorityV1(input: Readonly<{
	project_root: string;
	delegation_id: string;
	contract: Readonly<DelegationBoundedTaskContractBindingV2>;
	prepared: Readonly<PreparedDelegationChangeSetLifecycleV2>;
}>): Promise<{ ok: true; value: Readonly<DelegationResumeAuthorityRecordV1> } | { ok: false; code: string }> {
	const path = resumePath(input.project_root, input.delegation_id);
	const { contract_hash: persistedHash, ...payload } = input.contract;
	const rebound = bindDelegationBoundedTaskContractV2(payload);
	if (path === undefined || !rebound.ok || rebound.value.contract_hash !== persistedHash
		|| !validatePreparedDelegationChangeSetLifecycleV2(input.prepared)
		|| input.prepared.project_root !== input.project_root || input.prepared.delegation_id !== input.delegation_id
		|| input.prepared.contract_hash !== input.contract.contract_hash) return { ok: false, code: "INVALID_INPUT" };
	const withoutHash = {
		schema_version: DELEGATION_RESUME_AUTHORITY_SCHEMA_VERSION_V1,
		kind: DELEGATION_RESUME_AUTHORITY_KIND_V1,
		delegation_id: input.delegation_id,
		contract: structuredClone(input.contract),
		prepared: structuredClone(input.prepared),
	};
	const record: DelegationResumeAuthorityRecordV1 = {
		...withoutHash,
		authority_hash: canonicalHash(projection(withoutHash)),
	};
	if (!validateResumeAuthorityRecordV1(record)) return { ok: false, code: "INVALID_INPUT" };
	const bytes = canonicalBytes(record);
	if (bytes.length > DELEGATION_RESUME_AUTHORITY_MAX_BYTES_V1) return { ok: false, code: "LIMIT_EXCEEDED" };
	const existing = await readDelegationResumeAuthorityV1(input.project_root, input.delegation_id);
	if (existing.ok && existing.value !== undefined) {
		return existing.value.authority_hash === record.authority_hash
			? { ok: true, value: existing.value }
			: { ok: false, code: "CONFLICT" };
	}
	// A corrupt or unreadable durable record is evidence, not an empty slot.
	// Never replace it implicitly: recovery must remain fail-closed until the
	// exact storage problem is inspected and resolved under explicit authority.
	if (!existing.ok) return { ok: false, code: existing.code };
	const root = resumeRoot(input.project_root, input.delegation_id)!;
	const temp = `${path}.tmp.${randomBytes(16).toString("hex")}`;
	let handle;
	try {
		await mkdir(root, { recursive: true, mode: 0o700 });
		handle = await open(temp, "wx", 0o600);
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temp, path);
		const readback = await readDelegationResumeAuthorityV1(input.project_root, input.delegation_id);
		return readback.ok && readback.value?.authority_hash === record.authority_hash
			? { ok: true, value: readback.value }
			: { ok: false, code: "READBACK_FAILED" };
	} catch {
		await handle?.close().catch(() => undefined);
		await unlink(temp).catch(() => undefined);
		return { ok: false, code: "STORAGE_FAILURE" };
	}
}

export async function readDelegationResumeAuthorityV1(
	projectRoot: string,
	delegationId: string,
): Promise<ReadResumeAuthorityResultV1> {
	const path = resumePath(projectRoot, delegationId);
	if (path === undefined) return { ok: false, code: "INVALID_RECORD" };
	try {
		const bytes = await readFile(path);
		if (bytes.length > DELEGATION_RESUME_AUTHORITY_MAX_BYTES_V1) return { ok: false, code: "INVALID_RECORD" };
		const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		if (!validateResumeAuthorityRecordV1(value) || !bytes.equals(canonicalBytes(value))) {
			return { ok: false, code: "INVALID_RECORD" };
		}
		return { ok: true, value: Object.freeze(structuredClone(value)) };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { ok: true, value: undefined }
			: { ok: false, code: "STORAGE_FAILURE" };
	}
}

/** Recover a legacy contract only when its normalized hash matches durable state. */
export function recoverDelegationContractFromSessionEntriesV1(
	entries: readonly unknown[],
	transaction: Readonly<Pick<DelegationTransactionRecord, "contract_hash" | "task_kind" | "allowed_paths">>,
): Readonly<DelegationBoundedTaskContractBindingV2> | undefined {
	const matches = new Map<string, DelegationBoundedTaskContractBindingV2>();
	for (const entry of entries.slice(-20_000)) {
		if (!isRecord(entry) || !isRecord(entry.message) || entry.message.role !== "assistant"
			|| !Array.isArray(entry.message.content)) continue;
		for (const item of entry.message.content) {
			if (!isRecord(item) || item.type !== "toolCall" || item.name !== "workbench_delegate_worker"
				|| !isRecord(item.arguments)) continue;
			const taskKind = resolveWorkerTaskKind(item.arguments.task_kind);
			if (!taskKind.ok) continue;
			const normalized = normalizeDelegationBoundedTaskContractV2({
				...item.arguments,
				task_kind: taskKind.taskKind,
			});
			if (!normalized.ok || normalized.value.contract_hash !== transaction.contract_hash
				|| normalized.value.task_kind !== transaction.task_kind
				|| canonicalHash(normalized.value.allowed_paths) !== canonicalHash(transaction.allowed_paths)) continue;
			matches.set(canonicalHash(normalized.value), normalized.value);
		}
	}
	return matches.size === 1 ? Object.freeze(structuredClone([...matches.values()][0]!)) : undefined;
}

/**
 * Bounded legacy migration only: recover one exact hash-matching contract from
 * sibling Pi session files, then discard every raw session entry immediately.
 */
export async function recoverDelegationContractFromSessionDirectoryV1(
	sessionDir: string,
	delegationId: string,
	transaction: Readonly<Pick<DelegationTransactionRecord, "contract_hash" | "task_kind" | "allowed_paths">>,
): Promise<Readonly<DelegationBoundedTaskContractBindingV2> | undefined> {
	if (typeof sessionDir !== "string" || resolve(sessionDir) !== sessionDir
		|| !DELEGATION_TRANSACTION_ID_RE.test(delegationId)) return undefined;
	try {
		const candidates = (await readdir(sessionDir, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.sort((left, right) => Buffer.from(right.name).compare(Buffer.from(left.name)))
			.slice(0, LEGACY_SESSION_SCAN_MAX_FILES_V1);
		const matchingEntries: unknown[] = [];
		let totalBytes = 0;
		for (const candidate of candidates) {
			const handle = await open(join(sessionDir, candidate.name), "r");
			try {
				const facts = await handle.stat();
				if (!facts.isFile() || facts.size > LEGACY_SESSION_SCAN_MAX_FILE_BYTES_V1
					|| totalBytes + facts.size > LEGACY_SESSION_SCAN_MAX_TOTAL_BYTES_V1) continue;
				totalBytes += facts.size;
				const bytes = await handle.readFile();
				if (bytes.length !== facts.size) return undefined;
				const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				if (!text.includes(delegationId)) continue;
				for (const line of text.split("\n")) {
					if (!line.includes("workbench_delegate_worker")) continue;
					if (Buffer.byteLength(line, "utf8") > LEGACY_SESSION_SCAN_MAX_LINE_BYTES_V1) return undefined;
					matchingEntries.push(JSON.parse(line));
				}
			} finally {
				await handle.close();
			}
		}
		return recoverDelegationContractFromSessionEntriesV1(matchingEntries, transaction);
	} catch {
		return undefined;
	}
}

/** Collect one hash-bound resume command and reject every concurrent blocker. */
export async function collectCheckpointResumeExecutionAuthorityV1(input: Readonly<{
	project_root: string;
	delegation_id: string;
	exec: ExecFn;
	session_entries?: readonly unknown[];
	session_dir?: string;
	budget_continuation?: Readonly<BudgetContinuationAuthorizationV1>;
}>): Promise<CollectCheckpointResumeAuthorityResultV1> {
	const transactionRead = await readDelegationTransactionV2(input.project_root, input.delegation_id);
	if (!transactionRead.ok) return { ok: false, code: `TRANSACTION_${transactionRead.error.code.toUpperCase()}` };
	const transaction = transactionRead.value;
	if (!await isStrictRetryableCheckpointRepairRecoveryV2(input.project_root, transaction)) {
		return { ok: false, code: "CHECKPOINT_NOT_RETRYABLE" };
	}
	const evidence = await readStrictRetryableRawRepairEvidenceV1(input.project_root, transaction);
	if (!evidence.ok || evidence.value.retry_kind !== "CHECKPOINT_RECOVERY") {
		return { ok: false, code: evidence.ok ? "CHECKPOINT_NOT_RETRYABLE" : evidence.code };
	}
	const checkpointRead = await readDelegationWorkerCheckpointV1(input.project_root, input.delegation_id);
	const checkpoint = checkpointRead.ok ? checkpointRead.value : undefined;
	const budgetContinuation = input.budget_continuation;
	if (budgetContinuation !== undefined && (!validateBudgetContinuationAuthorizationV1(budgetContinuation)
		|| budgetContinuation.delegation_id !== input.delegation_id
		|| budgetContinuation.target_profile !== "extended")) {
		return { ok: false, code: "BUDGET_AUTHORIZATION_INVALID" };
	}
	if (checkpoint === undefined || budgetContinuation === undefined && checkpoint.machine_state !== "CHECKPOINTED"
		|| budgetContinuation !== undefined && checkpoint.machine_state !== "PAUSED_BUDGET") {
		return { ok: false, code: transaction.repair_lineage === undefined
			? "CHECKPOINT_UNAVAILABLE"
			: "CHECKPOINT_SUCCESSOR_REQUIRED" };
	}
	const persisted = await readDelegationResumeAuthorityV1(input.project_root, input.delegation_id);
	if (!persisted.ok) return { ok: false, code: `RESUME_${persisted.code}` };
	const contract = persisted.value?.contract
		?? recoverDelegationContractFromSessionEntriesV1(input.session_entries ?? [], transaction)
		?? (input.session_dir === undefined ? undefined : await recoverDelegationContractFromSessionDirectoryV1(
			input.session_dir,
			input.delegation_id,
			transaction,
		));
	if (contract === undefined) return { ok: false, code: "CONTRACT_UNAVAILABLE" };
	let prepared = persisted.value?.prepared;
	if (prepared === undefined) {
		const recovered = await recoverPreparedDelegationChangeSetLifecycleV2({
			project_root: input.project_root,
			delegation_id: input.delegation_id,
			contract_hash: transaction.contract_hash,
			dependency_paths: transaction.repair_lineage?.carried_paths ?? [],
			checkpoint,
			exec: input.exec,
		});
		if (!recovered.ok) return { ok: false, code: recovered.code };
		prepared = recovered.value;
	}
	let resumeRecordHash = persisted.value?.authority_hash ?? null;
	if (persisted.value === undefined) {
		const migrated = await persistDelegationResumeAuthorityV1({
			project_root: input.project_root,
			delegation_id: input.delegation_id,
			contract,
			prepared,
		});
		if (!migrated.ok) return { ok: false, code: `RESUME_MIGRATION_${migrated.code}` };
		resumeRecordHash = migrated.value.authority_hash;
	}
	const checkpointValid = budgetContinuation === undefined
		? validateWorkerCheckpointContinuationV1(checkpoint, {
			delegation_id: transaction.delegation_id,
			contract_hash: transaction.contract_hash,
			runtime_build_identity: checkpoint.runtime_build_identity,
			expected_attempt: checkpoint.attempt,
			parent_checkpoint_hash: checkpoint.parent_checkpoint_hash,
			before_binding_hash: prepared?.before_guard.workspace_guard_hash ?? "",
			current_binding_hash: checkpoint.current_binding_hash,
			allowed_paths: transaction.allowed_paths,
			active_attempt: false,
		})
		: validateWorkerCheckpointBudgetContinuationV1(checkpoint, {
			delegation_id: transaction.delegation_id,
			contract_hash: transaction.contract_hash,
			checkpoint_hash: budgetContinuation.checkpoint_hash,
			before_binding_hash: prepared?.before_guard.workspace_guard_hash ?? "",
			current_binding_hash: checkpoint.current_binding_hash,
			allowed_paths: transaction.allowed_paths,
		});
	const continuationCapsule = budgetContinuation === undefined
		? workerCheckpointContinuationCapsuleV1(checkpoint)
		: workerCheckpointBudgetContinuationCapsuleV1(checkpoint);
	if (prepared === undefined || prepared.before_guard.workspace_guard_hash !== checkpoint.before_binding_hash
		|| contract.contract_hash !== transaction.contract_hash
		|| continuationCapsule === undefined || !checkpointValid) return { ok: false, code: "CHECKPOINT_BINDING_CHANGED" };
	const repairTipResume = transaction.repair_lineage !== undefined;
	const lane = await admitProjectDelegationPathLaneV1({
		project_root: input.project_root,
		allowed_paths: transaction.allowed_paths,
		...(repairTipResume ? { repair_tip_exclusion_id: transaction.delegation_id } : {}),
	});
	const exactCurrentTarget = repairTipResume
		? lane.repair_tip_exclusion_id === transaction.delegation_id &&
			lane.repair_tip_ids.includes(transaction.delegation_id) &&
			!lane.ordinary_blocker_ids.includes(transaction.delegation_id)
		: lane.ordinary_blocker_ids.includes(transaction.delegation_id);
	if (!exactCurrentTarget) {
		return { ok: false, code: "PROJECT_AUTHORITY_CHANGED" };
	}
	const otherAuthorityDecision = repairTipResume
		? lane.decision
		: decideDelegationPathLaneV1({
			schema_version: DELEGATION_PATH_LANE_SCHEMA_VERSION_V1,
			kind: DELEGATION_PATH_LANE_REQUEST_KIND_V1,
			allowed_paths: transaction.allowed_paths,
			blockers: lane.blockers.filter((blocker) => blocker.delegation_id !== transaction.delegation_id),
		});
	if (otherAuthorityDecision.decision !== "ALLOW") return { ok: false, code: "OTHER_PATH_AUTHORITY_BLOCKS" };
	const withoutHash = {
		schema_version: 1 as const,
		kind: "checkpoint-resume-execution-authority-v1" as const,
		delegation_id: transaction.delegation_id,
		contract: structuredClone(contract),
		transaction: structuredClone(transaction),
		checkpoint: structuredClone(checkpoint),
		prepared: structuredClone(prepared),
		raw_evidence_hash: evidence.value.evidence_hash,
		path_lane_authority_hash: lane.authority_hash,
		resume_record_hash: resumeRecordHash,
		...(budgetContinuation === undefined ? {} : { budget_continuation: structuredClone(budgetContinuation) }),
	};
	return {
		ok: true,
		value: Object.freeze({ ...withoutHash, authority_hash: canonicalHash(withoutHash) }),
	};
}

/**
 * Upgrade a legacy PAUSED_BUDGET/RUNNING record into the same strict recovery
 * state now written by fixed runtimes. No semantic contract or project bytes
 * are changed, and a live execution owner always blocks the migration.
 */
export async function preparePausedBudgetContinuationV1(input: Readonly<{
	project_root: string;
	delegation_id: string;
	authorization: Readonly<BudgetContinuationAuthorizationV1>;
}>): Promise<{ ok: true } | { ok: false; code: string }> {
	if (!validateBudgetContinuationAuthorizationV1(input.authorization)
		|| input.authorization.delegation_id !== input.delegation_id) return { ok: false, code: "BUDGET_AUTHORIZATION_INVALID" };
	const transactionRead = await readDelegationTransactionV2(input.project_root, input.delegation_id);
	const checkpointRead = await readDelegationWorkerCheckpointV1(input.project_root, input.delegation_id);
	if (!transactionRead.ok || !checkpointRead.ok || checkpointRead.value === undefined) {
		return { ok: false, code: "CHECKPOINT_UNAVAILABLE" };
	}
	const transaction = transactionRead.value;
	const checkpoint = checkpointRead.value;
	if (checkpoint.machine_state !== "PAUSED_BUDGET" || checkpoint.checkpoint_hash !== input.authorization.checkpoint_hash
		|| checkpoint.remaining_budget.profile !== "standard" || checkpoint.budget_promotion !== undefined
		|| input.authorization.target_profile !== "extended"
		|| checkpoint.delegation_id !== transaction.delegation_id || checkpoint.contract_hash !== transaction.contract_hash) {
		return { ok: false, code: "BUDGET_AUTHORIZATION_STALE" };
	}
	if (transaction.status === "RECOVERY_REQUIRED") {
		return transaction.recovery_reason === BUDGET_PAUSED_RECOVERY_REASON_V2
			? { ok: true }
			: { ok: false, code: "RECOVERY_REASON_CONFLICT" };
	}
	if (transaction.status !== "RUNNING") return { ok: false, code: "TRANSACTION_NOT_PAUSED" };
	const owner = await readDelegationExecutionOwnerV2(input.project_root, transaction);
	if (owner.ok || owner.error.code !== "not_found") return { ok: false, code: "EXECUTION_OWNER_NOT_RELEASED" };
	const journal = await readWorkerWriteJournal({
		project_root: input.project_root,
		delegation_id: transaction.delegation_id,
		contract_hash: transaction.contract_hash,
	});
	if (!journal.ok || journal.value.state !== "OPEN" || journal.value.journal_hash !== null
		|| journal.value.operations.some((operation) => operation.status !== "completed")) {
		return { ok: false, code: "CHECKPOINT_JOURNAL_INVALID" };
	}
	const migrated = await persistRecoveryRequiredDelegationTransaction(input.project_root, {
		delegation_id: transaction.delegation_id,
		contract_hash: transaction.contract_hash,
		worker_identity: transaction.worker_identity,
		expected_generation: transaction.generation,
		expected_revision: transaction.revision,
		now: new Date().toISOString(),
		reason: BUDGET_PAUSED_RECOVERY_REASON_V2,
	});
	return migrated.ok ? { ok: true } : { ok: false, code: `TRANSACTION_${migrated.error.code.toUpperCase()}` };
}
