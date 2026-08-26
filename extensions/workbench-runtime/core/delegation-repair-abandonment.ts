/**
 * Immutable closure for a semantic-repair obligation whose rejected project
 * delta has already been deliberately discarded.
 *
 * This record never mutates Git and never accepts the rejected implementation.
 * It only attests that an approved Sol controller observed one exact unresolved
 * repair tip while the repository was strictly clean.  The old transaction,
 * review and REPAIR decision remain intact for audit.
 */

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { canonicalHash } from "../cache/canonical-hash.ts";
import type { DelegationSemanticRepairDecisionV1 } from "./delegation-transaction-storage.ts";
import {
	DELEGATION_TRANSACTION_HASH_RE,
	DELEGATION_TRANSACTION_ID_RE,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";
import { computeWorkspaceGuardHash, validateWorkspaceGuard, type WorkspaceGuardRecord } from "./workspace-guard.ts";

const RECEIPT_DIR_NAME = "repair-abandonments-v1";
const MAX_BYTES = 16_384;
const HASH_RE = /^[0-9a-f]{64}$/u;
const FIELDS = [
	"schema_version",
	"kind",
	"delegation_id",
	"contract_hash",
	"generation",
	"transaction_revision",
	"transaction_status",
	"root_delegation_id",
	"root_decision_hash",
	"repair_lineage_hash",
	"clean_git_head",
	"clean_workspace_guard_hash",
	"abandoned_by",
	"abandoned_at",
	"abandonment_hash",
] as const;

export interface DelegationCleanRepairAbandonmentV1 {
	schema_version: 1;
	kind: "clean-repair-abandonment-v1";
	delegation_id: string;
	contract_hash: string;
	generation: number;
	transaction_revision: number;
	transaction_status: DelegationTransactionRecord["status"];
	root_delegation_id: string;
	root_decision_hash: string;
	repair_lineage_hash: string | null;
	clean_git_head: string;
	clean_workspace_guard_hash: string;
	abandoned_by: { provider: "openai" | "openai-codex"; model: "gpt-5.6-sol" };
	abandoned_at: string;
	abandonment_hash: string;
}

export type DelegationCleanRepairAbandonmentResultV1<T> =
	| { ok: true; value: T }
	| { ok: false; error: { code: "invalid_input" | "invalid_record" | "conflict" | "storage_failure" } };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>): boolean {
	const keys = Object.keys(value);
	return keys.length === FIELDS.length && FIELDS.every((field) => Object.hasOwn(value, field));
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function isCanonicalTime(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 20 || value.length > 64 || !value.endsWith("Z")) return false;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validSol(value: unknown): value is DelegationCleanRepairAbandonmentV1["abandoned_by"] {
	return isRecord(value) && Object.keys(value).length === 2 &&
		(value.provider === "openai" || value.provider === "openai-codex") && value.model === "gpt-5.6-sol";
}

function rootId(transaction: DelegationTransactionRecord): string {
	return transaction.repair_lineage?.root_delegation_id ?? transaction.delegation_id;
}

function payloadHash(value: Omit<DelegationCleanRepairAbandonmentV1, "abandonment_hash">): string {
	return canonicalHash(value);
}

function normalize(
	value: unknown,
	tip: DelegationTransactionRecord,
	rootDecision: DelegationSemanticRepairDecisionV1,
): DelegationCleanRepairAbandonmentV1 | undefined {
	if (!isRecord(value) || !exactFields(value) || value.schema_version !== 1 ||
		value.kind !== "clean-repair-abandonment-v1" || value.delegation_id !== tip.delegation_id ||
		value.contract_hash !== tip.contract_hash || value.generation !== tip.generation ||
		value.transaction_revision !== tip.revision || value.transaction_status !== tip.status ||
		value.root_delegation_id !== rootId(tip) || value.root_delegation_id !== rootDecision.delegation_id ||
		value.root_decision_hash !== rootDecision.decision_hash ||
		value.repair_lineage_hash !== (tip.repair_lineage?.lineage_hash ?? null) ||
		typeof value.clean_git_head !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(value.clean_git_head) ||
		typeof value.clean_workspace_guard_hash !== "string" || !HASH_RE.test(value.clean_workspace_guard_hash) ||
		value.clean_workspace_guard_hash !== computeWorkspaceGuardHash(value.clean_git_head as string, []) ||
		!validSol(value.abandoned_by) || !isCanonicalTime(value.abandoned_at) ||
		Date.parse(value.abandoned_at) < Date.parse(tip.updated_at) ||
		Date.parse(value.abandoned_at) < Date.parse(rootDecision.decided_at) ||
		typeof value.abandonment_hash !== "string" || !HASH_RE.test(value.abandonment_hash)) return undefined;
	const { abandonment_hash, ...payload } = value;
	if (abandonment_hash !== payloadHash(payload as Omit<DelegationCleanRepairAbandonmentV1, "abandonment_hash">)) return undefined;
	return value as unknown as DelegationCleanRepairAbandonmentV1;
}

function encode(value: DelegationCleanRepairAbandonmentV1): Buffer | undefined {
	const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
	return bytes.length <= MAX_BYTES ? bytes : undefined;
}

function filePath(projectRoot: string, tip: DelegationTransactionRecord): string | undefined {
	const transactionHash = canonicalHash(tip);
	if (!DELEGATION_TRANSACTION_ID_RE.test(tip.delegation_id) || !DELEGATION_TRANSACTION_HASH_RE.test(transactionHash)) return undefined;
	return join(resolve(projectRoot), CONFIG_DIR_NAME, "workbench", "delegations", tip.delegation_id, "v2", RECEIPT_DIR_NAME, `${transactionHash}.json`);
}

async function readBounded(path: string): Promise<Buffer> {
	const before = await lstat(path, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink() || before.size < 0n || before.size > BigInt(MAX_BYTES)) {
		throw new Error("unsafe repair abandonment record");
	}
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
			throw new Error("repair abandonment identity changed");
		}
		const bytes = Buffer.alloc(Number(opened.size));
		let offset = 0;
		while (offset < bytes.length) {
			const result = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (result.bytesRead <= 0) throw new Error("short repair abandonment read");
			offset += result.bytesRead;
		}
		const after = await handle.stat({ bigint: true });
		if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
			after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
			throw new Error("repair abandonment changed during read");
		}
		return bytes;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function readAt(
	path: string,
	tip: DelegationTransactionRecord,
	rootDecision: DelegationSemanticRepairDecisionV1,
): Promise<DelegationCleanRepairAbandonmentResultV1<DelegationCleanRepairAbandonmentV1 | undefined>> {
	try {
		const bytes = await readBounded(path);
		let decoded: unknown;
		try { decoded = JSON.parse(bytes.toString("utf8")); } catch { return { ok: false, error: { code: "invalid_record" } }; }
		const record = normalize(decoded, tip, rootDecision);
		const canonical = record === undefined ? undefined : encode(record);
		return record !== undefined && canonical !== undefined && canonical.equals(bytes)
			? { ok: true, value: record }
			: { ok: false, error: { code: "invalid_record" } };
	} catch (error) {
		return isErrno(error, "ENOENT")
			? { ok: true, value: undefined }
			: { ok: false, error: { code: "storage_failure" } };
	}
}

/** Strict optional read. Absence is successful and never closes authority. */
export async function readDelegationCleanRepairAbandonmentV1(
	projectRoot: string,
	tip: DelegationTransactionRecord,
	rootDecision: DelegationSemanticRepairDecisionV1,
): Promise<DelegationCleanRepairAbandonmentResultV1<DelegationCleanRepairAbandonmentV1 | undefined>> {
	const path = filePath(projectRoot, tip);
	return path === undefined ? { ok: false, error: { code: "invalid_input" } } : readAt(path, tip, rootDecision);
}

/**
 * Publish one no-clobber clean-state closure. The caller must hold the project
 * delegation start lock; this layer still revalidates every bound input.
 */
export async function publishDelegationCleanRepairAbandonmentV1(input: {
	project_root: string;
	tip: DelegationTransactionRecord;
	root_decision: DelegationSemanticRepairDecisionV1;
	clean_guard: WorkspaceGuardRecord;
	abandoned_by: DelegationCleanRepairAbandonmentV1["abandoned_by"];
	now: string;
}): Promise<DelegationCleanRepairAbandonmentResultV1<DelegationCleanRepairAbandonmentV1>> {
	const path = filePath(input.project_root, input.tip);
	if (path === undefined || !validateWorkspaceGuard(input.clean_guard) || input.clean_guard.entries.length !== 0 ||
		input.clean_guard.git_head === null || !validSol(input.abandoned_by) || !isCanonicalTime(input.now) ||
		rootId(input.tip) !== input.root_decision.delegation_id ||
		(input.tip.repair_lineage !== undefined && input.tip.repair_lineage.root_decision_hash !== input.root_decision.decision_hash) ||
		(input.tip.repair_lineage === undefined && input.tip.delegation_id !== input.root_decision.delegation_id) ||
		!DELEGATION_TRANSACTION_HASH_RE.test(input.root_decision.decision_hash)) {
		return { ok: false, error: { code: "invalid_input" } };
	}
	const payload: Omit<DelegationCleanRepairAbandonmentV1, "abandonment_hash"> = {
		schema_version: 1,
		kind: "clean-repair-abandonment-v1",
		delegation_id: input.tip.delegation_id,
		contract_hash: input.tip.contract_hash,
		generation: input.tip.generation,
		transaction_revision: input.tip.revision,
		transaction_status: input.tip.status,
		root_delegation_id: rootId(input.tip),
		root_decision_hash: input.root_decision.decision_hash,
		repair_lineage_hash: input.tip.repair_lineage?.lineage_hash ?? null,
		clean_git_head: input.clean_guard.git_head,
		clean_workspace_guard_hash: input.clean_guard.workspace_guard_hash,
		abandoned_by: { ...input.abandoned_by },
		abandoned_at: input.now,
	};
	const desired: DelegationCleanRepairAbandonmentV1 = { ...payload, abandonment_hash: payloadHash(payload) };
	if (normalize(desired, input.tip, input.root_decision) === undefined) {
		return { ok: false, error: { code: "invalid_input" } };
	}
	const bytes = encode(desired);
	if (bytes === undefined) return { ok: false, error: { code: "invalid_input" } };

	const existing = await readAt(path, input.tip, input.root_decision);
	if (!existing.ok) return existing;
	if (existing.value !== undefined) return { ok: true, value: existing.value };

	const directory = dirname(path);
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const directoryStat = await lstat(directory);
		if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
			return { ok: false, error: { code: "invalid_record" } };
		}
	} catch {
		return { ok: false, error: { code: "storage_failure" } };
	}
	const temp = join(directory, `.repair-abandonment.${randomBytes(16).toString("hex")}.tmp`);
	try {
		const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
		try {
			await link(temp, path);
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
		}
		const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
		try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
	} catch {
		return { ok: false, error: { code: "storage_failure" } };
	} finally {
		await unlink(temp).catch(() => undefined);
	}
	const final = await readAt(path, input.tip, input.root_decision);
	if (!final.ok || final.value === undefined) return final.ok
		? { ok: false, error: { code: "storage_failure" } }
		: final;
	return final.value.abandonment_hash === desired.abandonment_hash
		? { ok: true, value: final.value }
		: { ok: false, error: { code: "conflict" } };
}
