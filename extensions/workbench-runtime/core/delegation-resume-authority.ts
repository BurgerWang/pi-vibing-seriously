/** Durable and legacy recovery authority for a checkpointed delegation. */

import { randomBytes } from "node:crypto";
import { open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { canonicalHash } from "../cache/canonical-hash.ts";
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
	readDelegationTransactionV2,
	readDelegationWorkerCheckpointV1,
} from "./delegation-transaction-storage.ts";
import {
	DELEGATION_TRANSACTION_ID_RE,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";
import {
	validateWorkerCheckpointContinuationV1,
	workerCheckpointContinuationCapsuleV1,
	type WorkerCheckpointV1,
} from "./worker-checkpoint.ts";
import { resolveWorkerTaskKind } from "./worker-policy.ts";

export const DELEGATION_RESUME_AUTHORITY_SCHEMA_VERSION_V1 = 1 as const;
export const DELEGATION_RESUME_AUTHORITY_KIND_V1 = "delegation-resume-authority-v1" as const;
export const DELEGATION_RESUME_AUTHORITY_MAX_BYTES_V1 = 2 * 1024 * 1024;

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
	transaction: Readonly<DelegationTransactionRecord>,
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

/** Collect one hash-bound resume command and reject every concurrent blocker. */
export async function collectCheckpointResumeExecutionAuthorityV1(input: Readonly<{
	project_root: string;
	delegation_id: string;
	exec: ExecFn;
	session_entries?: readonly unknown[];
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
	if (checkpoint === undefined || checkpoint.machine_state !== "CHECKPOINTED") {
		return { ok: false, code: transaction.repair_lineage === undefined
			? "CHECKPOINT_UNAVAILABLE"
			: "CHECKPOINT_SUCCESSOR_REQUIRED" };
	}
	const persisted = await readDelegationResumeAuthorityV1(input.project_root, input.delegation_id);
	if (!persisted.ok) return { ok: false, code: `RESUME_${persisted.code}` };
	const contract = persisted.value?.contract
		?? recoverDelegationContractFromSessionEntriesV1(input.session_entries ?? [], transaction);
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
	if (prepared === undefined || prepared.before_guard.workspace_guard_hash !== checkpoint.before_binding_hash
		|| contract.contract_hash !== transaction.contract_hash
		|| workerCheckpointContinuationCapsuleV1(checkpoint) === undefined
		|| !validateWorkerCheckpointContinuationV1(checkpoint, {
			delegation_id: transaction.delegation_id,
			contract_hash: transaction.contract_hash,
			runtime_build_identity: checkpoint.runtime_build_identity,
			expected_attempt: checkpoint.attempt,
			parent_checkpoint_hash: checkpoint.parent_checkpoint_hash,
			before_binding_hash: prepared.before_guard.workspace_guard_hash,
			current_binding_hash: checkpoint.current_binding_hash,
			allowed_paths: transaction.allowed_paths,
			active_attempt: false,
		})) return { ok: false, code: "CHECKPOINT_BINDING_CHANGED" };
	const lane = await admitProjectDelegationPathLaneV1({
		project_root: input.project_root,
		allowed_paths: transaction.allowed_paths,
	});
	if (!lane.ordinary_blocker_ids.includes(transaction.delegation_id)) {
		return { ok: false, code: "PROJECT_AUTHORITY_CHANGED" };
	}
	const otherBlockers = lane.blockers.filter((blocker) => blocker.delegation_id !== transaction.delegation_id);
	const withoutSelf = decideDelegationPathLaneV1({
		schema_version: DELEGATION_PATH_LANE_SCHEMA_VERSION_V1,
		kind: DELEGATION_PATH_LANE_REQUEST_KIND_V1,
		allowed_paths: transaction.allowed_paths,
		blockers: otherBlockers,
	});
	if (withoutSelf.decision !== "ALLOW") return { ok: false, code: "OTHER_PATH_AUTHORITY_BLOCKS" };
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
		resume_record_hash: persisted.value?.authority_hash ?? null,
	};
	return {
		ok: true,
		value: Object.freeze({ ...withoutHash, authority_hash: canonicalHash(withoutHash) }),
	};
}
