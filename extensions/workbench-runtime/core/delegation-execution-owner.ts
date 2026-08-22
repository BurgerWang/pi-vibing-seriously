/**
 * Durable execution ownership and conservative post-restart recovery.
 *
 * The transaction lock protects one storage mutation only. This independent
 * owner record spans the worker lifetime so a later runtime can distinguish a
 * live execution from a process that disappeared during a reboot or crash.
 */

import { readFile } from "node:fs/promises";
import { uptime } from "node:os";
import { dirname, join, resolve } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	createNodeDelegationTransactionStorageAdapter,
	persistAbortedDelegationTransaction,
	type DelegationTransactionStorageAdapter,
	type DelegationTransactionStorageOptions,
} from "./delegation-transaction-storage.ts";
import {
	DELEGATION_TRANSACTION_HASH_RE,
	DELEGATION_TRANSACTION_ID_RE,
	type DelegationTransactionRecord,
	type DelegationWorkerIdentity,
} from "./delegation-transaction.ts";
import { readWorkerWriteJournal, type WorkerWriteJournalRecord } from "./write-journal.ts";

export const DELEGATION_EXECUTION_OWNER_FILE_V2 = "execution-owner.json" as const;
export const DELEGATION_EXECUTION_OWNER_SCHEMA_VERSION_V2 = 1 as const;
export const DELEGATION_EXECUTION_OWNER_MAX_BYTES_V2 = 4_096 as const;
export const INTERRUPTED_BEFORE_WORKER_WRITE_REASON_V2 =
	"runtime interrupted before any worker write; execution owner is no longer live" as const;

const OWNER_FIELDS = [
	"schema_version", "delegation_id", "contract_hash", "worker_identity",
	"process_id", "process_start_ticks", "boot_id", "runtime_started_at", "created_at", "token",
] as const;
const IDENTITY_FIELDS = ["provider", "model", "worker_id"] as const;
const TOKEN_RE = /^[a-f0-9]{32}$/;
const BOOT_ID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const LEGACY_REBOOT_MARGIN_MS = 2_000;

export interface DelegationExecutionBootFactsV2 {
	boot_id: string | null;
	system_boot_time_ms: number | null;
	runtime_started_at: string;
	/** Linux /proc field 22; null where the platform cannot provide it. */
	process_start_ticks?: string | null;
}

export interface DelegationExecutionOwnerRecordV2 {
	schema_version: typeof DELEGATION_EXECUTION_OWNER_SCHEMA_VERSION_V2;
	delegation_id: string;
	contract_hash: string;
	worker_identity: DelegationWorkerIdentity;
	process_id: number;
	process_start_ticks: string | null;
	boot_id: string | null;
	runtime_started_at: string;
	created_at: string;
	token: string;
}

export interface DelegationExecutionOwnerOptionsV2 {
	storage_options?: DelegationTransactionStorageOptions;
	boot_facts?: DelegationExecutionBootFactsV2;
	read_process_start_ticks?: (processId: number) => Promise<string | null>;
}

export type DelegationExecutionOwnerErrorCodeV2 =
	| "conflict"
	| "invalid_input"
	| "invalid_record"
	| "not_found"
	| "storage_failure";

export type DelegationExecutionOwnerResultV2<T> =
	| { ok: true; value: T }
	| { ok: false; error: { code: DelegationExecutionOwnerErrorCodeV2 } };

export type InterruptedDelegationRecoveryV2 =
	| { status: "not_applicable" | "active" | "unproven"; transaction: DelegationTransactionRecord }
	| {
		status: "blocked";
		transaction: DelegationTransactionRecord;
		code: "invalid_owner" | "invalid_journal" | "nonempty_journal" | "unsafe_artifacts" | "storage_failure" | "abort_conflict";
	}
	| { status: "recovered"; transaction: DelegationTransactionRecord; legacy_reboot_proof: boolean };

function adapterOf(options?: DelegationExecutionOwnerOptionsV2): DelegationTransactionStorageAdapter {
	return options?.storage_options?.adapter ?? createNodeDelegationTransactionStorageAdapter();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length && actual.every((field, index) => field === wanted[index]);
}

function isCanonicalTime(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sameIdentity(left: DelegationWorkerIdentity, right: DelegationWorkerIdentity): boolean {
	return left.provider === right.provider && left.model === right.model && left.worker_id === right.worker_id;
}

function parseOwner(value: unknown, transaction: DelegationTransactionRecord): DelegationExecutionOwnerRecordV2 | undefined {
	if (!isRecord(value) || !exactFields(value, OWNER_FIELDS) || !isRecord(value.worker_identity)
		|| !exactFields(value.worker_identity, IDENTITY_FIELDS)) return undefined;
	if (value.schema_version !== DELEGATION_EXECUTION_OWNER_SCHEMA_VERSION_V2
		|| value.delegation_id !== transaction.delegation_id
		|| value.contract_hash !== transaction.contract_hash
		|| !Number.isSafeInteger(value.process_id) || Number(value.process_id) <= 0
		|| !(value.process_start_ticks === null
			|| (typeof value.process_start_ticks === "string" && /^(0|[1-9]\d*)$/.test(value.process_start_ticks)))
		|| !(value.boot_id === null || (typeof value.boot_id === "string" && BOOT_ID_RE.test(value.boot_id)))
		|| !isCanonicalTime(value.runtime_started_at) || !isCanonicalTime(value.created_at)
		|| typeof value.token !== "string" || !TOKEN_RE.test(value.token)) return undefined;
	const identity = value.worker_identity as unknown as DelegationWorkerIdentity;
	if (!sameIdentity(identity, transaction.worker_identity)) return undefined;
	return value as unknown as DelegationExecutionOwnerRecordV2;
}

function ownerPath(projectRoot: string, delegationId: string): string | undefined {
	if (!DELEGATION_TRANSACTION_ID_RE.test(delegationId)) return undefined;
	return join(resolve(projectRoot), CONFIG_DIR_NAME, "workbench", "delegations", delegationId, "v2",
		DELEGATION_EXECUTION_OWNER_FILE_V2);
}

function v2Path(projectRoot: string, delegationId: string): string | undefined {
	const owner = ownerPath(projectRoot, delegationId);
	return owner === undefined ? undefined : dirname(owner);
}

function canonicalBytes(value: DelegationExecutionOwnerRecordV2): Uint8Array {
	return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function defaultBootFacts(): Promise<DelegationExecutionBootFactsV2> {
	let bootId: string | null = null;
	try {
		const value = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().toLowerCase();
		if (BOOT_ID_RE.test(value)) bootId = value;
	} catch {
		// Non-Linux runtimes retain PID liveness and omit cross-boot identity.
	}
	const now = Date.now();
	const systemUptime = uptime();
	const processStarted = now - (process.uptime() * 1_000);
	return {
		boot_id: bootId,
		system_boot_time_ms: Number.isFinite(systemUptime) && systemUptime >= 0 ? now - (systemUptime * 1_000) : null,
		runtime_started_at: new Date(Math.max(0, processStarted)).toISOString(),
		process_start_ticks: await readProcessStartTicks(process.pid),
	};
}

async function readProcessStartTicks(processId: number): Promise<string | null> {
	if (!Number.isSafeInteger(processId) || processId <= 0) return null;
	try {
		const raw = await readFile(`/proc/${processId}/stat`, "utf8");
		const end = raw.lastIndexOf(")");
		if (end < 0) return null;
		const fields = raw.slice(end + 1).trim().split(/\s+/);
		const startTicks = fields[19];
		return startTicks !== undefined && /^(0|[1-9]\d*)$/.test(startTicks) ? startTicks : null;
	} catch {
		return null;
	}
}

async function bootFacts(options?: DelegationExecutionOwnerOptionsV2): Promise<DelegationExecutionBootFactsV2> {
	return options?.boot_facts ?? defaultBootFacts();
}

export async function readDelegationExecutionOwnerV2(
	projectRoot: string,
	transaction: DelegationTransactionRecord,
	options?: DelegationExecutionOwnerOptionsV2,
): Promise<DelegationExecutionOwnerResultV2<DelegationExecutionOwnerRecordV2>> {
	const path = ownerPath(projectRoot, transaction.delegation_id);
	if (path === undefined) return { ok: false, error: { code: "invalid_input" } };
	const adapter = adapterOf(options);
	try {
		const stat = await adapter.inspect(path);
		if (stat.kind !== "file" || stat.size > DELEGATION_EXECUTION_OWNER_MAX_BYTES_V2) {
			return { ok: false, error: { code: "invalid_record" } };
		}
		const bytes = await adapter.readBounded(path, DELEGATION_EXECUTION_OWNER_MAX_BYTES_V2);
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			return { ok: false, error: { code: "invalid_record" } };
		}
		const parsed = parseOwner(value, transaction);
		if (parsed === undefined || !bytesEqual(bytes, canonicalBytes(parsed))) {
			return { ok: false, error: { code: "invalid_record" } };
		}
		return { ok: true, value: parsed };
	} catch (error) {
		return {
			ok: false,
			error: { code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "storage_failure" },
		};
	}
}

/** Publish one exclusive owner before RUNNING is made durable. */
export async function claimDelegationExecutionOwnerV2(
	projectRoot: string,
	transaction: DelegationTransactionRecord,
	createdAt: string,
	options?: DelegationExecutionOwnerOptionsV2,
): Promise<DelegationExecutionOwnerResultV2<DelegationExecutionOwnerRecordV2>> {
	const path = ownerPath(projectRoot, transaction.delegation_id);
	if (path === undefined || transaction.status !== "PREPARED" || !isCanonicalTime(createdAt)) {
		return { ok: false, error: { code: "invalid_input" } };
	}
	const adapter = adapterOf(options);
	const facts = await bootFacts(options);
	const token = adapter.randomToken();
	if (!TOKEN_RE.test(token) || !isCanonicalTime(facts.runtime_started_at)
		|| !(facts.boot_id === null || BOOT_ID_RE.test(facts.boot_id))) {
		return { ok: false, error: { code: "invalid_input" } };
	}
	const processStartTicks = facts.process_start_ticks === undefined
		? await (options?.read_process_start_ticks ?? readProcessStartTicks)(adapter.processId)
		: facts.process_start_ticks;
	if (!(processStartTicks === null || /^(0|[1-9]\d*)$/.test(processStartTicks))) {
		return { ok: false, error: { code: "invalid_input" } };
	}
	const record: DelegationExecutionOwnerRecordV2 = {
		schema_version: DELEGATION_EXECUTION_OWNER_SCHEMA_VERSION_V2,
		delegation_id: transaction.delegation_id,
		contract_hash: transaction.contract_hash,
		worker_identity: { ...transaction.worker_identity },
		process_id: adapter.processId,
		process_start_ticks: processStartTicks,
		boot_id: facts.boot_id,
		runtime_started_at: facts.runtime_started_at,
		created_at: createdAt,
		token,
	};
	try {
		await adapter.write(path, canonicalBytes(record), true);
	} catch (error) {
		return {
			ok: false,
			error: { code: (error as NodeJS.ErrnoException).code === "EEXIST" ? "conflict" : "storage_failure" },
		};
	}
	const verified = await readDelegationExecutionOwnerV2(projectRoot, transaction, options);
	if (!verified.ok) return verified;
	return sameIdentity(verified.value.worker_identity, record.worker_identity) && verified.value.token === token
		? verified
		: { ok: false, error: { code: "invalid_record" } };
}

/** Remove only the owner with the exact token; never unlink foreign evidence. */
export async function releaseDelegationExecutionOwnerV2(
	projectRoot: string,
	transaction: DelegationTransactionRecord,
	token: string,
	options?: DelegationExecutionOwnerOptionsV2,
): Promise<DelegationExecutionOwnerResultV2<null>> {
	if (!TOKEN_RE.test(token)) return { ok: false, error: { code: "invalid_input" } };
	const current = await readDelegationExecutionOwnerV2(projectRoot, transaction, options);
	if (!current.ok) return current.error.code === "not_found" ? { ok: true, value: null } : current;
	if (current.value.token !== token) return { ok: false, error: { code: "conflict" } };
	const path = ownerPath(projectRoot, transaction.delegation_id)!;
	try {
		await adapterOf(options).removeFile(path);
		return { ok: true, value: null };
	} catch (error) {
		return {
			ok: false,
			error: { code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "storage_failure" },
		};
	}
}

function pristineJournal(journal: WorkerWriteJournalRecord): boolean {
	return journal.state === "OPEN" && journal.revision === 0 && journal.journal_hash === null
		&& journal.operations.length === 0
		&& journal.meter.paths_attempted === 0
		&& journal.meter.paths_completed === 0
		&& journal.meter.bytes_read === 0;
}

async function safeIncompleteInventory(
	projectRoot: string,
	delegationId: string,
	ownerPresent: boolean,
	journalPresent: boolean,
	adapter: DelegationTransactionStorageAdapter,
): Promise<"safe" | "unsafe" | "storage_failure"> {
	const path = v2Path(projectRoot, delegationId);
	if (path === undefined) return "unsafe";
	try {
		const stat = await adapter.inspect(path);
		if (stat.kind !== "directory") return "unsafe";
		const entries = await adapter.list(path);
		const allowed = new Map<string, "file">([
			["transaction.json", "file"],
			...(journalPresent ? [["write-journal.json", "file"] as const] : []),
			...(ownerPresent ? [[DELEGATION_EXECUTION_OWNER_FILE_V2, "file"] as const] : []),
		]);
		if (entries.length !== allowed.size) return "unsafe";
		return entries.every((entry) => allowed.get(entry.name) === entry.kind) ? "safe" : "unsafe";
	} catch {
		return "storage_failure";
	}
}

async function legacyRebootProof(
	projectRoot: string,
	transaction: DelegationTransactionRecord,
	facts: DelegationExecutionBootFactsV2,
	adapter: DelegationTransactionStorageAdapter,
): Promise<boolean> {
	if (facts.system_boot_time_ms === null || !Number.isFinite(facts.system_boot_time_ms)) return false;
	const updatedAt = Date.parse(transaction.updated_at);
	if (!Number.isFinite(updatedAt) || updatedAt + LEGACY_REBOOT_MARGIN_MS >= facts.system_boot_time_ms) return false;
	const base = v2Path(projectRoot, transaction.delegation_id)!;
	try {
		for (const name of ["transaction.json", "write-journal.json"] as const) {
			if (name === "write-journal.json" && transaction.status === "PREPARED") {
				try {
					const stat = await adapter.inspect(join(base, name));
					if (stat.kind !== "file" || stat.mtime_ms === undefined || !Number.isFinite(stat.mtime_ms)
						|| stat.mtime_ms + LEGACY_REBOOT_MARGIN_MS >= facts.system_boot_time_ms) return false;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					return false;
				}
				continue;
			}
			const stat = await adapter.inspect(join(base, name));
			if (stat.kind !== "file" || stat.mtime_ms === undefined || !Number.isFinite(stat.mtime_ms)
				|| stat.mtime_ms + LEGACY_REBOOT_MARGIN_MS >= facts.system_boot_time_ms) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Recover exactly one provably orphaned PREPARED/RUNNING transaction.
 * Only an empty OPEN journal and an artifact-free v2 directory may become
 * ABORTED. Any write evidence, COMMITTING state, or malformed evidence remains
 * blocking and is never silently cleared.
 */
export async function recoverInterruptedDelegationV2(input: {
	project_root: string;
	transaction: DelegationTransactionRecord;
	now: string;
	options?: DelegationExecutionOwnerOptionsV2;
}): Promise<InterruptedDelegationRecoveryV2> {
	const transaction = input.transaction;
	if (transaction.status !== "PREPARED" && transaction.status !== "RUNNING") {
		return { status: "not_applicable", transaction };
	}
	const adapter = adapterOf(input.options);
	const owner = await readDelegationExecutionOwnerV2(input.project_root, transaction, input.options);
	let legacyProof = false;
	if (owner.ok) {
		const facts = await bootFacts(input.options);
		const differentBoot = owner.value.boot_id !== null && facts.boot_id !== null
			&& owner.value.boot_id !== facts.boot_id;
		let sameProcess = adapter.isProcessAlive(owner.value.process_id);
		if (!differentBoot && sameProcess && owner.value.process_start_ticks !== null) {
			const currentStart = await (input.options?.read_process_start_ticks ?? readProcessStartTicks)(owner.value.process_id);
			// An unreadable start identity remains conservatively active; a
			// different identity proves PID reuse and therefore an orphan.
			if (currentStart !== null && currentStart !== owner.value.process_start_ticks) sameProcess = false;
		}
		if (!differentBoot && sameProcess) {
			return { status: "active", transaction };
		}
	} else if (owner.error.code === "not_found") {
		legacyProof = await legacyRebootProof(input.project_root, transaction, await bootFacts(input.options), adapter);
		if (!legacyProof) return { status: "unproven", transaction };
	} else {
		return {
			status: "blocked",
			transaction,
			code: owner.error.code === "storage_failure" ? "storage_failure" : "invalid_owner",
		};
	}

	const journal = await readWorkerWriteJournal({
		project_root: input.project_root,
		delegation_id: transaction.delegation_id,
		contract_hash: transaction.contract_hash,
	});
	const journalMissingBeforeLaunch = !journal.ok && journal.error.code === "not_found"
		&& transaction.status === "PREPARED" && (owner.ok || legacyProof);
	if (!journal.ok && !journalMissingBeforeLaunch) {
		return {
			status: "blocked",
			transaction,
			code: journal.error.code === "storage_failure" ? "storage_failure" : "invalid_journal",
		};
	}
	if (journal.ok && !pristineJournal(journal.value)) {
		return { status: "blocked", transaction, code: "nonempty_journal" };
	}
	const inventory = await safeIncompleteInventory(
		input.project_root,
		transaction.delegation_id,
		owner.ok,
		journal.ok,
		adapter,
	);
	if (inventory !== "safe") {
		return {
			status: "blocked",
			transaction,
			code: inventory === "storage_failure" ? "storage_failure" : "unsafe_artifacts",
		};
	}
	const aborted = await persistAbortedDelegationTransaction(input.project_root, {
		delegation_id: transaction.delegation_id,
		contract_hash: transaction.contract_hash,
		worker_identity: transaction.worker_identity,
		expected_generation: transaction.generation,
		expected_revision: transaction.revision,
		now: input.now,
		reason: INTERRUPTED_BEFORE_WORKER_WRITE_REASON_V2,
	}, input.options?.storage_options).catch(() => undefined);
	if (aborted === undefined || !aborted.ok) {
		return { status: "blocked", transaction, code: "abort_conflict" };
	}
	if (owner.ok) {
		await releaseDelegationExecutionOwnerV2(
			input.project_root,
			aborted.value,
			owner.value.token,
			input.options,
		).catch(() => undefined);
	}
	return { status: "recovered", transaction: aborted.value, legacy_reboot_proof: legacyProof };
}
