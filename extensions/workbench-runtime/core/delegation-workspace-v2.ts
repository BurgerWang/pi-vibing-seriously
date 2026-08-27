/**
 * Guard-native delegation-v2 workspace facts.
 *
 * This module is deliberately free of Git execution.  It projects the one
 * before guard and one after guard already captured by the ChangeSet
 * lifecycle into the GitFacts-compatible shape consumed by the runtime and
 * immutable records.  The binding hash is the guard hash; content identities
 * are the full streaming identities already paid for by the write journal and
 * ChangeSet finalizer, never a second scan of unrelated dirty paths.
 */

import type {
	FinalizedDelegationChangeSetLifecycleV2,
	PreparedDelegationChangeSetLifecycleV2,
} from "./delegation-change-set-lifecycle.ts";
import { validateChangeSet } from "./change-set.ts";
import { validateDelegationCommandProvenance } from "./delegation-command-effect-provenance.ts";
import type { GitFacts } from "./delegation-ledger.ts";
import { validateWorkspaceGuard, type WorkspaceGuardRecord } from "./workspace-guard.ts";
import { validateWorkerWriteJournalRecord } from "./write-journal.ts";

export const DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2 = "workspace_guard_v2" as const;

export interface DelegationWorkspaceGitFactsV2 extends GitFacts {
	diffIdentityKind: typeof DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2;
	/** Guard binding hash.  This is intentionally not the legacy diff hash. */
	diffHash: string;
}

export interface DelegationWorkspaceAfterFactsV2 extends DelegationWorkspaceGitFactsV2 {
	/**
	 * Byte-sorted union of attributed worker paths, workspace drift and
	 * conflict paths.  It is broader than changedPaths so terminal unsafe
	 * outcomes can never masquerade as an exact zero source delta.
	 */
	changedSinceBefore: string[];
}

export type DelegationWorkspaceV2ErrorCode = "invalid_prepared" | "invalid_finalized";

export interface DelegationWorkspaceV2Error {
	code: DelegationWorkspaceV2ErrorCode;
	message: string;
}

export type DerivePreparedDelegationWorkspaceBeforeV2Result =
	| { ok: true; value: Readonly<DelegationWorkspaceGitFactsV2> }
	| { ok: false; error: Readonly<DelegationWorkspaceV2Error> };

export interface FinalizedDelegationWorkspaceFactsV2 {
	before: Readonly<DelegationWorkspaceGitFactsV2>;
	after: Readonly<DelegationWorkspaceAfterFactsV2>;
}

export type DeriveFinalizedDelegationWorkspaceFactsV2Result =
	| { ok: true; value: Readonly<FinalizedDelegationWorkspaceFactsV2> }
	| { ok: false; error: Readonly<DelegationWorkspaceV2Error> };

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function error(code: DelegationWorkspaceV2ErrorCode): Readonly<DelegationWorkspaceV2Error> {
	return Object.freeze({
		code,
		message: code === "invalid_prepared"
			? "delegation workspace prepared authority is invalid"
			: "delegation workspace finalized authority is invalid",
	});
}

function guardProjection(
	guard: Readonly<WorkspaceGuardRecord>,
	changedPaths: readonly string[],
	pathDigests: Readonly<Record<string, string>>,
): Readonly<DelegationWorkspaceGitFactsV2> {
	return Object.freeze({
		diffIdentityKind: DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2,
		diffHash: guard.workspace_guard_hash,
		gitHead: guard.git_head,
		gitDirty: guard.entries.length > 0,
		changedPaths: Object.freeze([...changedPaths]) as unknown as string[],
		// Git status remains a projection of the real guard only. In
		// particular, a Git-ignored command output can be in effective_paths
		// and pathDigests without being forged into `??` here.
		pathStatuses: Object.freeze(Object.fromEntries(guard.entries.map((entry) => [entry.path, entry.status]))),
		pathDigests: Object.freeze({ ...pathDigests }),
	});
}

function completedOperations(
	prepared: Readonly<PreparedDelegationChangeSetLifecycleV2>,
	finalized: Readonly<FinalizedDelegationChangeSetLifecycleV2>,
): boolean {
	return finalized.prepared.delegation_id === prepared.delegation_id
		&& finalized.prepared.contract_hash === prepared.contract_hash
		&& finalized.prepared.before_guard.workspace_guard_hash === prepared.before_guard.workspace_guard_hash
		&& validateWorkerWriteJournalRecord(finalized.sealed_journal)
		&& finalized.sealed_journal.state === "SEALED"
		&& finalized.sealed_journal.delegation_id === prepared.delegation_id
		&& finalized.sealed_journal.contract_hash === prepared.contract_hash
		&& finalized.sealed_journal.operations.every((operation) => operation.status === "completed");
}

/** Derive the one guard-native before binding exposed at PREPARED time. */
export function derivePreparedDelegationWorkspaceBeforeV2(
	prepared: Readonly<PreparedDelegationChangeSetLifecycleV2>,
): DerivePreparedDelegationWorkspaceBeforeV2Result {
	try {
		if (!prepared || !validateWorkspaceGuard(prepared.before_guard)) {
			return { ok: false, error: error("invalid_prepared") };
		}
		const paths = prepared.before_guard.entries.map((entry) => entry.path);
		return { ok: true, value: guardProjection(prepared.before_guard, paths, {}) };
	} catch {
		return { ok: false, error: error("invalid_prepared") };
	}
}

/**
 * Derive final before/after facts without any filesystem or Git read.
 * Only W receives persisted content digests, sourced from the first journal
 * before identity and final ChangeSet after identity respectively.
 */
export function deriveFinalizedDelegationWorkspaceFactsV2(
	finalized: Readonly<FinalizedDelegationChangeSetLifecycleV2>,
): DeriveFinalizedDelegationWorkspaceFactsV2Result {
	try {
		const prepared = finalized?.prepared;
		if (!prepared || !validateWorkspaceGuard(prepared.before_guard)
			|| !validateWorkspaceGuard(finalized.after_guard) || !validateChangeSet(finalized.change_set)
			|| !(finalized.command_provenance === undefined
				|| validateDelegationCommandProvenance(finalized.command_provenance, finalized.change_set))
			|| !completedOperations(prepared, finalized)
			|| finalized.change_set.delegation_id !== prepared.delegation_id
			|| finalized.change_set.contract_hash !== prepared.contract_hash
			|| finalized.change_set.before_workspace_guard_hash !== prepared.before_guard.workspace_guard_hash
			|| finalized.change_set.after_workspace_guard_hash !== finalized.after_guard.workspace_guard_hash) {
			return { ok: false, error: error("invalid_finalized") };
		}

		const workerPaths = finalized.change_set.worker_delta.map((entry) => entry.path);
		const effectivePaths = finalized.command_provenance === undefined
			? [...workerPaths]
			: [...finalized.command_provenance.effective_paths];
		const beforeDigests: Record<string, string> = {};
		for (const entry of finalized.change_set.worker_delta) {
			// ChangeSet already binds each path to the first journal operation.
			// Reading a later file-valued `before` after an initial `missing`
			// would turn an intermediate worker version into false pre-worker
			// authority for newly-created files.
			if (entry.before.kind === "file") beforeDigests[entry.path] = entry.before.sha256;
		}
		const afterDigests: Record<string, string> = {};
		for (const entry of finalized.change_set.worker_delta) {
			if (entry.after.kind === "file") afterDigests[entry.path] = entry.after.sha256;
		}
		for (const entry of finalized.command_provenance?.command_delta ?? []) {
			if (entry.after.kind === "file") afterDigests[entry.path] = entry.after.sha256;
		}
		const changedSinceBefore = [...new Set([
			...effectivePaths,
			...(finalized.command_provenance?.remaining_workspace_drift ?? finalized.change_set.workspace_drift)
				.map((entry) => entry.path),
			...finalized.change_set.conflicts.map((entry) => entry.path),
		])].sort(byteCompare);
		const beforePaths = finalized.prepared.before_guard.entries.map((entry) => entry.path);
		const before = guardProjection(finalized.prepared.before_guard, beforePaths, beforeDigests);
		const afterBase = guardProjection(finalized.after_guard, effectivePaths, afterDigests);
		const after: Readonly<DelegationWorkspaceAfterFactsV2> = Object.freeze({
			...afterBase,
			changedSinceBefore: Object.freeze(changedSinceBefore) as unknown as string[],
		});
		return { ok: true, value: Object.freeze({ before, after }) };
	} catch {
		return { ok: false, error: error("invalid_finalized") };
	}
}
