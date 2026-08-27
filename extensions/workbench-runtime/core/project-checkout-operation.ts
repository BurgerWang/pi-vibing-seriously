/**
 * One shared-checkout writer lane for every Workbench mutation.
 *
 * The durable exclusion primitive intentionally remains the historical
 * `.pi/workbench/delegation-start.lock`.  There is exactly one fixed lock per
 * checkout; this module adds operation identity, exact-token reentrancy and a
 * process-global lifecycle registry without creating a second authority.
 *
 * The registry lives behind Symbol.for so an extension /reload observes the
 * still-active operation instead of losing the only same-process liveness
 * fact.  The durable lock remains authoritative across processes.  A token is
 * reentrant only when it byte-matches the currently published lock owner.
 */

import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	acquireProjectDelegationStartLockV1,
	inspectProjectDelegationStartLockV1,
	releaseProjectDelegationStartLockV1,
	type ProjectDelegationStartLockLeaseV1,
	type ProjectDelegationStartLockOptionsV1,
} from "./delegation-start-lock.ts";

export const WORKBENCH_CHECKOUT_OPERATION_TOKEN_ENV =
	"PI_WORKBENCH_CHECKOUT_OPERATION_TOKEN" as const;

export type ProjectCheckoutOperationKindV1 = "delegation" | "tool" | "command";
export type ProjectCheckoutOperationSettlementV1 = "generic_release" | "delegation_cas";

export interface AcquireProjectCheckoutOperationInputV1 {
	project_root: string;
	operation_kind: ProjectCheckoutOperationKindV1;
	operation_id: string;
	now: string;
	/** Delegations retain their existing durable identifier. */
	delegation_id?: string;
	/** Exact published owner token inherited by a nested/worker operation. */
	reentrant_token?: string;
}

export interface ProjectCheckoutOperationLeaseV1 {
	schema_version: 1;
	project_root: string;
	operation_kind: ProjectCheckoutOperationKindV1;
	operation_id: string;
	delegation_id: string;
	token: string;
	mode: "exclusive" | "reentrant";
	start_lock_lease: ProjectDelegationStartLockLeaseV1;
}

export interface ProjectCheckoutOperationOptionsV1 extends ProjectDelegationStartLockOptionsV1 {
	/** Bounded dependency seams used by controller unit tests. */
	acquire_start_lock?: typeof acquireProjectDelegationStartLockV1;
	inspect_start_lock?: typeof inspectProjectDelegationStartLockV1;
	release_start_lock?: typeof releaseProjectDelegationStartLockV1;
}

export type ProjectCheckoutOperationResultV1<T> =
	| { ok: true; value: T }
	| {
		ok: false;
		error: {
			code: "conflict" | "invalid_input" | "invalid_record" | "storage_failure";
			message: string;
		};
	};

export type ProjectCheckoutOperationRunResultV1<T> =
	| { ok: false; error: Extract<ProjectCheckoutOperationResultV1<never>, { ok: false }>["error"] }
	| { ok: true; value: T; release: "released" | "recovery_required" };

interface ProcessOperationRecordV1 {
	readonly project_root: string;
	readonly operation_kind: ProjectCheckoutOperationKindV1;
	readonly operation_id: string;
	readonly delegation_id: string;
	readonly token: string;
	readonly start_lock_lease: ProjectDelegationStartLockLeaseV1;
	settled: boolean;
	settlement: ProjectCheckoutOperationSettlementV1 | null;
	borrowers: number;
}

interface ProcessOperationRegistryV1 {
	readonly records: Map<string, ProcessOperationRecordV1>;
}

const REGISTRY_SYMBOL = Symbol.for("pi.workbench.project-checkout-operation-registry.v1");
const TOKEN_RE = /^[a-f0-9]{32}$/u;
const OPERATION_ID_RE = /^[^\u0000-\u001f\u007f]{1,256}$/u;

function registry(): ProcessOperationRegistryV1 {
	const host = globalThis as typeof globalThis & { [REGISTRY_SYMBOL]?: ProcessOperationRegistryV1 };
	if (host[REGISTRY_SYMBOL] === undefined) {
		host[REGISTRY_SYMBOL] = { records: new Map() };
	}
	return host[REGISTRY_SYMBOL];
}

function failure<T>(
	code: Extract<ProjectCheckoutOperationResultV1<T>, { ok: false }>['error']['code'],
	message: string,
): ProjectCheckoutOperationResultV1<T> {
	return { ok: false, error: { code, message } };
}

function canonicalTime(value: string): boolean {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function syntheticDelegationId(input: AcquireProjectCheckoutOperationInputV1): string | undefined {
	if (!canonicalTime(input.now)) return undefined;
	const date = new Date(input.now);
	const compactDate = [
		date.getUTCFullYear().toString().padStart(4, "0"),
		(date.getUTCMonth() + 1).toString().padStart(2, "0"),
		date.getUTCDate().toString().padStart(2, "0"),
	].join("");
	const compactTime = [
		date.getUTCHours().toString().padStart(2, "0"),
		date.getUTCMinutes().toString().padStart(2, "0"),
		date.getUTCSeconds().toString().padStart(2, "0"),
	].join("");
	const suffix = createHash("sha256")
		.update(`${input.operation_kind}\0${input.operation_id}\0${input.now}`, "utf8")
		.digest("hex")
		.slice(0, 4);
	return `${compactDate}-${compactTime}-${suffix}`;
}

function sameStartLock(
	left: ProjectDelegationStartLockLeaseV1,
	right: ProjectDelegationStartLockLeaseV1,
): boolean {
	return left.project_root === right.project_root
		&& left.delegation_id === right.delegation_id
		&& left.token === right.token
		&& left.process_id === right.process_id
		&& left.process_start_ticks === right.process_start_ticks
		&& left.boot_id === right.boot_id
		&& left.acquired_at === right.acquired_at;
}

function leaseFrom(
	input: AcquireProjectCheckoutOperationInputV1,
	startLock: ProjectDelegationStartLockLeaseV1,
	mode: ProjectCheckoutOperationLeaseV1["mode"],
): ProjectCheckoutOperationLeaseV1 {
	return {
		schema_version: 1,
		project_root: startLock.project_root,
		operation_kind: input.operation_kind,
		operation_id: input.operation_id,
		delegation_id: startLock.delegation_id,
		token: startLock.token,
		mode,
		start_lock_lease: startLock,
	};
}

function exclusiveLeaseFromRecord(record: ProcessOperationRecordV1): ProjectCheckoutOperationLeaseV1 {
	return {
		schema_version: 1,
		project_root: record.project_root,
		operation_kind: record.operation_kind,
		operation_id: record.operation_id,
		delegation_id: record.delegation_id,
		token: record.token,
		mode: "exclusive",
		start_lock_lease: record.start_lock_lease,
	};
}

async function canonicalProjectRoot(projectRoot: string): Promise<string | undefined> {
	try {
		return await realpath(resolve(projectRoot));
	} catch {
		return undefined;
	}
}

/**
 * Recover only an exact process-settled generic-release record. A settled
 * delegation-CAS record is reported without mutation so its transaction-aware
 * reconciler can run next. No TTL, PID guess, or synthetic delegation lookup
 * can remove an operation.
 */
export async function recoverSettledGenericProjectCheckoutOperationV1(
	projectRoot: string,
	options: ProjectCheckoutOperationOptionsV1 = {},
): Promise<ProjectCheckoutOperationResultV1<"absent" | "recovered" | "delegation_cas_pending">> {
	const canonicalRoot = await canonicalProjectRoot(projectRoot);
	if (canonicalRoot === undefined) return failure("invalid_input", "checkout project root cannot be canonicalized");
	const records = registry().records;
	const current = records.get(canonicalRoot);
	if (current === undefined) return { ok: true, value: "absent" };
	if (current.settled && current.settlement === "delegation_cas" && current.borrowers === 0) {
		return { ok: true, value: "delegation_cas_pending" };
	}
	if (!current.settled || current.settlement !== "generic_release" || current.borrowers !== 0) {
		return failure("conflict", "checkout command/tool operation has not settled exactly");
	}
	const inspected = await (options.inspect_start_lock ?? inspectProjectDelegationStartLockV1)(canonicalRoot, options);
	if (!inspected.ok) return failure(inspected.error.code, inspected.error.message);
	if (inspected.value.status === "absent") {
		// A prior release may have crossed the unlink/dir-fsync boundary before
		// reporting failure. Exact durable absence permits dropping only this
		// already-settled process record; a concurrently acquired owner would have
		// been observed instead and remains untouched.
		if (records.get(canonicalRoot) !== current || !current.settled || current.borrowers !== 0) {
			return failure("conflict", "settled checkout registry changed during exact recovery");
		}
		records.delete(canonicalRoot);
		return { ok: true, value: "recovered" };
	}
	if (!sameStartLock(current.start_lock_lease, inspected.value.lease)) {
		return failure("conflict", "settled checkout registry token conflicts with the fixed owner");
	}
	const released = await releaseProjectCheckoutOperationV1(exclusiveLeaseFromRecord(current), options);
	return released.ok ? { ok: true, value: "recovered" } : released;
}

/**
 * Acquire the checkout writer lane, or borrow it with the exact durable token.
 * A same-PID record alone never grants reentrancy; the fixed lock is re-read.
 */
export async function acquireProjectCheckoutOperationV1(
	input: AcquireProjectCheckoutOperationInputV1,
	options: ProjectCheckoutOperationOptionsV1 = {},
): Promise<ProjectCheckoutOperationResultV1<ProjectCheckoutOperationLeaseV1>> {
	if (!OPERATION_ID_RE.test(input.operation_id) || !canonicalTime(input.now)
		|| !["delegation", "tool", "command"].includes(input.operation_kind)) {
		return failure("invalid_input", "checkout operation identity is invalid");
	}
	if (input.reentrant_token !== undefined) {
		if (!TOKEN_RE.test(input.reentrant_token)) {
			return failure("invalid_input", "checkout reentrant token is invalid");
		}
		const inspected = await (options.inspect_start_lock ?? inspectProjectDelegationStartLockV1)(input.project_root, options);
		if (!inspected.ok) return failure(inspected.error.code, inspected.error.message);
		if (inspected.value.status !== "live" || inspected.value.lease.token !== input.reentrant_token
			|| (input.delegation_id !== undefined
				&& inspected.value.lease.delegation_id !== input.delegation_id)) {
			return failure("conflict", "checkout reentrant token does not identify the live fixed owner");
		}
		const existing = registry().records.get(inspected.value.lease.project_root);
		if (existing !== undefined) {
			if (existing.token !== input.reentrant_token) {
				return failure("conflict", "checkout process registry conflicts with the reentrant fixed owner");
			}
			if (existing.settled) return failure("conflict", "checkout operation already settled before reentrant acquisition");
			existing.borrowers += 1;
		}
		return { ok: true, value: leaseFrom(input, inspected.value.lease, "reentrant") };
	}

	const recovered = await recoverSettledGenericProjectCheckoutOperationV1(input.project_root, options);
	if (!recovered.ok) return recovered;
	if (recovered.value === "delegation_cas_pending") {
		return failure("conflict", "checkout delegation awaits transaction-aware recovery");
	}

	const delegationId = input.delegation_id ?? syntheticDelegationId(input);
	if (delegationId === undefined) return failure("invalid_input", "checkout operation time is invalid");
	const acquired = await (options.acquire_start_lock ?? acquireProjectDelegationStartLockV1)({
		project_root: input.project_root,
		delegation_id: delegationId,
		now: input.now,
	}, options);
	if (!acquired.ok) return failure(acquired.error.code, acquired.error.message);
	const lease = leaseFrom(input, acquired.value, "exclusive");
	const records = registry().records;
	const prior = records.get(lease.project_root);
	if (prior !== undefined) {
		await (options.release_start_lock ?? releaseProjectDelegationStartLockV1)(acquired.value, options).catch(() => undefined);
		return failure("conflict", "process registry already contains a checkout operation");
	}
	records.set(lease.project_root, {
		project_root: lease.project_root,
		operation_kind: lease.operation_kind,
		operation_id: lease.operation_id,
		delegation_id: lease.delegation_id,
		token: lease.token,
		start_lock_lease: lease.start_lock_lease,
		settled: false,
		settlement: null,
		borrowers: 0,
	});
	return { ok: true, value: lease };
}

/** Mark an exclusive operation's child/controller work as definitely settled. */
export function markProjectCheckoutOperationSettledV1(
	lease: ProjectCheckoutOperationLeaseV1,
	settlement: ProjectCheckoutOperationSettlementV1 =
		lease.operation_kind === "delegation" ? "delegation_cas" : "generic_release",
): boolean {
	const current = registry().records.get(lease.project_root);
	if (lease.mode !== "exclusive" || current === undefined || current.token !== lease.token
		|| !sameStartLock(current.start_lock_lease, lease.start_lock_lease)) return false;
	if (current.settled && current.settlement !== settlement) return false;
	current.settled = true;
	current.settlement = settlement;
	return true;
}

/** Exact process-global settlement evidence used only for same-PID recovery. */
export function inspectProcessCheckoutOperationV1(
	projectRoot: string,
	token: string,
): "absent" | "active" | "settled" | "conflict" {
	const current = registry().records.get(projectRoot);
	if (current === undefined) return "absent";
	if (current.token !== token) return "conflict";
	return current.settled ? "settled" : "active";
}

/** Exact process-only recovery disposition; never inferred from a PID or tool name. */
export function inspectProcessCheckoutOperationSettlementV1(
	projectRoot: string,
	token: string,
): ProjectCheckoutOperationSettlementV1 | "absent" | "active" | "conflict" {
	const current = registry().records.get(projectRoot);
	if (current === undefined) return "absent";
	if (current.token !== token) return "conflict";
	return current.settled ? current.settlement ?? "conflict" : "active";
}

/** Exact settled delegation lease for strict project-authority reconciliation. */
export function settledProjectCheckoutOperationLeaseV1(
	projectRoot: string,
	delegationId: string,
): ProjectCheckoutOperationLeaseV1 | undefined {
	const current = registry().records.get(projectRoot);
	if (current === undefined || !current.settled || current.settlement !== "delegation_cas" || current.borrowers !== 0
		|| current.operation_kind !== "delegation" || current.delegation_id !== delegationId) return undefined;
	return {
		schema_version: 1,
		project_root: current.project_root,
		operation_kind: current.operation_kind,
		operation_id: current.operation_id,
		delegation_id: current.delegation_id,
		token: current.token,
		mode: "exclusive",
		start_lock_lease: current.start_lock_lease,
	};
}

/** Release only the exact durable token; nested borrowers never unlink it. */
export async function releaseProjectCheckoutOperationV1(
	lease: ProjectCheckoutOperationLeaseV1,
	options: ProjectCheckoutOperationOptionsV1 = {},
): Promise<ProjectCheckoutOperationResultV1<null>> {
	const records = registry().records;
	const current = records.get(lease.project_root);
	if (lease.mode === "reentrant") {
		if (current !== undefined && current.token === lease.token && current.borrowers > 0) current.borrowers -= 1;
		return { ok: true, value: null };
	}
	if (current === undefined || current.token !== lease.token
		|| !sameStartLock(current.start_lock_lease, lease.start_lock_lease)) {
		return failure("conflict", "checkout operation registry token changed before release");
	}
	if (current.borrowers !== 0) {
		return failure("conflict", "checkout operation still has active same-process borrowers");
	}
	const released = await (options.release_start_lock ?? releaseProjectDelegationStartLockV1)(lease.start_lock_lease, options);
	if (!released.ok) return failure(released.error.code, released.error.message);
	records.delete(lease.project_root);
	return { ok: true, value: null };
}

/** Execute one command-side mutation under the fixed checkout lane. */
export async function runProjectCheckoutOperationV1<T>(
	input: AcquireProjectCheckoutOperationInputV1,
	operation: (lease: ProjectCheckoutOperationLeaseV1) => Promise<T>,
	options: ProjectCheckoutOperationOptionsV1 = {},
): Promise<ProjectCheckoutOperationRunResultV1<T>> {
	const acquired = await acquireProjectCheckoutOperationV1(input, options);
	if (!acquired.ok) return acquired;
	let value: T;
	try {
		value = await operation(acquired.value);
	} catch (error) {
		// The awaited command callback has settled. Cleanup failure never masks
		// the command's original exception, but the exact registry/lock remains
		// available for recovery when release cannot be proven.
		markProjectCheckoutOperationSettledV1(acquired.value);
		await releaseProjectCheckoutOperationV1(acquired.value, options).catch(() => undefined);
		throw error;
	}
	markProjectCheckoutOperationSettledV1(acquired.value);
	const released = await releaseProjectCheckoutOperationV1(acquired.value, options).catch(() => undefined);
	return {
		ok: true,
		value,
		release: released?.ok === true ? "released" : "recovery_required",
	};
}

/**
 * Forget a settled record only after another strict routine released the same
 * fixed token (for example delegation CAS recovery).
 */
export function forgetRecoveredProjectCheckoutOperationV1(
	projectRoot: string,
	token: string,
): boolean {
	const records = registry().records;
	const current = records.get(projectRoot);
	if (current === undefined) return true;
	if (current.token !== token || !current.settled || current.settlement !== "delegation_cas"
		|| current.borrowers !== 0) return false;
	records.delete(projectRoot);
	return true;
}

/** Exact-token availability check with no storage mutation. */
export async function projectCheckoutOperationBlockReasonV1(input: {
	project_root: string;
	reentrant_token?: string;
	delegation_id?: string;
}, options: ProjectDelegationStartLockOptionsV1 = {}): Promise<string | undefined> {
	const inspected = await inspectProjectDelegationStartLockV1(input.project_root, options);
	if (!inspected.ok) {
		// A never-initialized checkout has no fixed owner yet.  The acquiring
		// mutation still performs the strict canonical-layout checks before it
		// can write anything.
		try {
			await lstat(join(resolve(input.project_root), CONFIG_DIR_NAME, "workbench", "delegation-start.lock"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		}
		return `checkout writer lane unavailable: ${inspected.error.code}`;
	}
	if (inspected.value.status === "absent") return undefined;
	if (inspected.value.status !== "live") return "checkout writer lane has a dead owner pending exact recovery";
	if (input.reentrant_token !== undefined && TOKEN_RE.test(input.reentrant_token)
		&& inspected.value.lease.token === input.reentrant_token
		&& (input.delegation_id === undefined || inspected.value.lease.delegation_id === input.delegation_id)) {
		return undefined;
	}
	return `checkout writer lane is active for ${inspected.value.owner.delegation_id}`;
}

/** Test-only isolation seam; never call from production recovery. */
export function resetProjectCheckoutOperationRegistryForTestV1(): void {
	registry().records.clear();
}
