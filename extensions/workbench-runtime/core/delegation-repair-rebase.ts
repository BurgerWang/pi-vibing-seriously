/**
 * Strict terminal-repair rebinding.
 *
 * A failed repair has no accepted source authority to preserve. Its current
 * binding can nevertheless change when Git visibility changes (for example,
 * an already-carried generated artifact becomes untracked). Requiring the
 * failed packet's exact relevance hash forever makes that lineage impossible
 * to recover. This module admits a narrower continuation authority: unchanged
 * HEAD, a non-empty current delta wholly contained by the immutable carried
 * path set, and no unmerged Git status. The resulting snapshot is hash-bound
 * and must be collected again immediately before launch.
 *
 * This authority never applies to PENDING_REVIEW semantic REPAIR decisions;
 * those still require their exact reviewed binding.
 */

import { canonicalHash } from "../cache/canonical-hash.ts";
import type { ExecFn } from "./config.ts";
import type { DelegationCommittedGenerationV2 } from "./delegation-transaction-storage.ts";
import {
	parseDelegationRepairLineageV1,
} from "./delegation-transaction.ts";
import {
	collectWorkspaceGuard,
	validateWorkspaceGuard,
	type WorkspaceGuardRecord,
} from "./workspace-guard.ts";

export const TERMINAL_REPAIR_REBASE_KIND_V1 = "terminal-repair-rebase-v1" as const;

export type TerminalRepairRebaseErrorCodeV1 =
	| "not_terminal_lineage"
	| "invalid_committed_after"
	| "workspace_unavailable"
	| "head_changed"
	| "clean_workspace"
	| "unmerged_path"
	| "path_outside_lineage";

export interface TerminalRepairRebaseAuthorityV1 {
	readonly schema_version: 1;
	readonly kind: typeof TERMINAL_REPAIR_REBASE_KIND_V1;
	readonly delegation_id: string;
	readonly contract_hash: string;
	readonly generation_content_hash: string;
	readonly lineage_hash: string;
	readonly git_head: string;
	readonly relevant_paths: readonly string[];
	readonly workspace_guard_hash: string;
	readonly rebase_hash: string;
}

export type CollectTerminalRepairRebaseResultV1 =
	| { readonly ok: true; readonly value: Readonly<TerminalRepairRebaseAuthorityV1> }
	| { readonly ok: false; readonly code: TerminalRepairRebaseErrorCodeV1; readonly path?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function afterGuard(committed: DelegationCommittedGenerationV2): WorkspaceGuardRecord | undefined {
	const after = committed.records["after.json"];
	if (!isRecord(after) || !validateWorkspaceGuard(after.workspace_guard)) return undefined;
	return after.workspace_guard;
}

function isUnmergedStatus(status: string): boolean {
	return status === "DD" || status === "AU" || status === "UD" || status === "UA" ||
		status === "DU" || status === "AA" || status === "UU";
}

function projection(input: {
	committed: DelegationCommittedGenerationV2;
	guard: WorkspaceGuardRecord;
}): Omit<TerminalRepairRebaseAuthorityV1, "rebase_hash"> {
	const lineage = input.committed.state.repair_lineage!;
	return {
		schema_version: 1,
		kind: TERMINAL_REPAIR_REBASE_KIND_V1,
		delegation_id: input.committed.state.delegation_id,
		contract_hash: input.committed.state.contract_hash,
		generation_content_hash: input.committed.proof.content_hash,
		lineage_hash: lineage.lineage_hash,
		git_head: input.guard.git_head!,
		relevant_paths: input.guard.entries.map((entry) => entry.path).sort(byteCompare),
		workspace_guard_hash: input.guard.workspace_guard_hash,
	};
}

/** Collect one read-only, hash-bound continuation snapshot for a failed repair. */
export async function collectTerminalRepairRebaseAuthorityV1(input: {
	projectRoot: string;
	committed: DelegationCommittedGenerationV2;
	exec: ExecFn;
}): Promise<CollectTerminalRepairRebaseResultV1> {
	const state = input.committed.state;
	if ((state.status !== "FAILED" && state.status !== "RECOVERY_REQUIRED") ||
		state.repair_lineage === undefined) {
		return { ok: false, code: "not_terminal_lineage" };
	}
	const lineage = parseDelegationRepairLineageV1(state.repair_lineage);
	if (lineage === undefined) return { ok: false, code: "not_terminal_lineage" };
	const sealedAfter = afterGuard(input.committed);
	if (sealedAfter?.git_head === null || sealedAfter === undefined) {
		return { ok: false, code: "invalid_committed_after" };
	}
	const current = await collectWorkspaceGuard({ project_root: input.projectRoot, exec: input.exec });
	if (!current.ok || current.guard.git_head === null) return { ok: false, code: "workspace_unavailable" };
	if (current.guard.git_head !== sealedAfter.git_head) return { ok: false, code: "head_changed" };
	if (current.guard.entries.length === 0) return { ok: false, code: "clean_workspace" };
	const carried = new Set(lineage.carried_paths);
	for (const entry of current.guard.entries) {
		if (isUnmergedStatus(entry.status)) return { ok: false, code: "unmerged_path", path: entry.path };
		if (!carried.has(entry.path)) return { ok: false, code: "path_outside_lineage", path: entry.path };
	}
	const withoutHash = projection({ committed: input.committed, guard: current.guard });
	return {
		ok: true,
		value: Object.freeze({ ...withoutHash, rebase_hash: canonicalHash(withoutHash) }),
	};
}
