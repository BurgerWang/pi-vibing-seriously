/**
 * Fail-closed relevance migration for upgrade-era schema-2 review records.
 *
 * This collector is deliberately separate from normal ChangeSet relevance:
 * only an immutable mechanical FINAL may use it, and only when a descendant
 * HEAD did nothing beyond materialising the already-recorded worker bytes.
 */

import { canonicalHash } from "../cache/canonical-hash.ts";
import type { ExecFn } from "./config.ts";
import { computeHistoricalSemanticMigrationBindingHashV2 } from "./delegation-transaction-storage.ts";
import {
	isScopeIntegrityPacketComplete,
	type ReviewRecord,
} from "./diff-review.ts";
import {
	REVIEW_RELEVANCE_KIND_V2,
	validateReviewRelevanceProjectionV2,
} from "./review-relevance-v2.ts";
import {
	captureStreamingIdentities,
	isStrictStreamingIdentityPath,
	type StreamingPathIdentity,
} from "./streaming-identity.ts";
import {
	collectWorkspaceGuard,
	validateWorkspaceGuard,
	type WorkspaceGuardEntry,
	type WorkspaceGuardRecord,
} from "./workspace-guard.ts";

export const HISTORICAL_SEMANTIC_MIGRATION_KIND = "historical-semantic-migration-v1" as const;

export interface HistoricalSemanticMigrationProjection {
	schema_version: 1;
	kind: typeof HISTORICAL_SEMANTIC_MIGRATION_KIND;
	old_git_head: string;
	candidate_git_head: string;
	head_delta_paths: string[];
	head_delta_hash: string;
	closed_content_hash: string;
	baseline_guard_hash: string;
	migration_binding_hash: string;
}

export type HistoricalSemanticMigrationErrorCode =
	| "invalid_input"
	| "packet_incomplete"
	| "head_unavailable"
	| "head_not_descendant"
	| "head_delta_invalid"
	| "head_delta_out_of_scope"
	| "worker_not_clean"
	| "baseline_conflict"
	| "identity_unavailable"
	| "content_conflict";

export type HistoricalSemanticMigrationResult =
	| { ok: true; projection: HistoricalSemanticMigrationProjection }
	| { ok: false; code: HistoricalSemanticMigrationErrorCode; path?: string };

export interface CollectHistoricalSemanticMigrationInput {
	projectRoot: string;
	delegationId: string;
	contractHash: string;
	baseReviewHash: string;
	review: ReviewRecord;
	afterGuard: WorkspaceGuardRecord;
	exec: ExecFn;
}

interface RawHeadDeltaEntry {
	path: string;
	old_mode: string;
	new_mode: string;
	old_oid: string;
	new_oid: string;
	status: "A" | "D" | "M";
}

interface ContentIdentity {
	path: string;
	kind: "file" | "missing";
	byte_size?: number;
	sha256?: string;
}

const HASH_RE = /^[0-9a-f]{64}$/u;
const HEAD_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

function fail(code: HistoricalSemanticMigrationErrorCode, path?: string): HistoricalSemanticMigrationResult {
	return { ok: false, code, ...(path === undefined ? {} : { path }) };
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function simplifiedIdentity(identity: StreamingPathIdentity): ContentIdentity {
	return identity.kind === "missing"
		? { path: identity.path, kind: "missing" }
		: { path: identity.path, kind: "file", byte_size: identity.byte_size, sha256: identity.sha256 };
}

function sameContent(left: ContentIdentity, right: ContentIdentity): boolean {
	return left.path === right.path && left.kind === right.kind && (left.kind === "missing" || (
		right.kind === "file" && left.byte_size === right.byte_size && left.sha256 === right.sha256
	));
}

function parseRawHeadDelta(value: string): RawHeadDeltaEntry[] | undefined {
	const fields = value.split("\0");
	if (fields.at(-1) === "") fields.pop();
	if (fields.length % 2 !== 0) return undefined;
	const entries: RawHeadDeltaEntry[] = [];
	for (let index = 0; index < fields.length; index += 2) {
		const metadata = fields[index]!;
		const path = fields[index + 1]!;
		const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([ADM])$/u.exec(metadata);
		if (!match || !isStrictStreamingIdentityPath(path)) return undefined;
		const [, oldMode, newMode, oldOid, newOid, status] = match;
		if (status === "M" && oldMode !== newMode) return undefined;
		if (status === "A" && (oldMode !== "000000" || newMode === "000000")) return undefined;
		if (status === "D" && (newMode !== "000000" || oldMode === "000000")) return undefined;
		entries.push({
			path,
			old_mode: oldMode!,
			new_mode: newMode!,
			old_oid: oldOid!,
			new_oid: newOid!,
			status: status as RawHeadDeltaEntry["status"],
		});
	}
	entries.sort((left, right) => byteCompare(left.path, right.path));
	if (entries.some((entry, index) => index > 0 && entries[index - 1]!.path === entry.path)) return undefined;
	return entries;
}

function canonicalBaselineEntries(entries: readonly WorkspaceGuardEntry[], workerPaths: ReadonlySet<string>): WorkspaceGuardEntry[] {
	return entries
		.filter((entry) => !workerPaths.has(entry.path))
		.map((entry) => structuredClone(entry))
		.sort((left, right) => byteCompare(left.path, right.path));
}

function validBaseInput(input: CollectHistoricalSemanticMigrationInput): boolean {
	const projection = input.review.relevance_projection;
	return typeof input.projectRoot === "string" && input.projectRoot.length > 0
		&& typeof input.delegationId === "string" && input.delegationId === input.review.delegation_id
		&& HASH_RE.test(input.contractHash) && HASH_RE.test(input.baseReviewHash)
		&& input.review.schema_version === 2
		&& input.review.diff_identity_kind === REVIEW_RELEVANCE_KIND_V2
		&& input.review.semantic_acceptance === undefined
		&& input.review.semantic_review !== "accepted"
		&& input.review.checked_paths.length > 0
		&& isScopeIntegrityPacketComplete(input.review)
		&& validateReviewRelevanceProjectionV2(projection)
		&& projection.delegation_id === input.delegationId
		&& projection.contract_hash === input.contractHash
		&& validateWorkspaceGuard(input.afterGuard)
		&& projection.git_head !== null;
}

/** Collect the one candidate binding that a second explicit Sol call may accept. */
export async function collectHistoricalSemanticMigration(
	input: CollectHistoricalSemanticMigrationInput,
): Promise<HistoricalSemanticMigrationResult> {
	try {
		if (!validBaseInput(input)) return fail("invalid_input");
		const relevance = input.review.relevance_projection!;
		const oldHead = relevance.git_head!;
		const workerPaths = relevance.entries.filter((entry) => entry.roles.includes("W")).map((entry) => entry.path);
		if (workerPaths.length !== input.review.checked_paths.length ||
			workerPaths.some((path, index) => path !== input.review.checked_paths[index])) return fail("invalid_input");
		const workerSet = new Set(workerPaths);

		const currentGuard = await collectWorkspaceGuard({ project_root: input.projectRoot, exec: input.exec });
		if (!currentGuard.ok || currentGuard.guard.git_head === null || !HEAD_RE.test(currentGuard.guard.git_head)) {
			return fail("head_unavailable");
		}
		const dirtyWorker = currentGuard.guard.entries.find((entry) => workerSet.has(entry.path));
		if (dirtyWorker !== undefined) return fail("worker_not_clean", dirtyWorker.path);
		const currentHead = currentGuard.guard.git_head;
		const ancestor = await input.exec("git", ["merge-base", "--is-ancestor", oldHead, currentHead], { cwd: input.projectRoot });
		if (ancestor.killed || ancestor.code !== 0) return fail(ancestor.code === 1 ? "head_not_descendant" : "head_unavailable");
		const raw = await input.exec("git", [
			"diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "--abbrev=64", `${oldHead}..${currentHead}`, "--",
		], { cwd: input.projectRoot });
		if (raw.killed || raw.code !== 0 || raw.stderr.length > 0) return fail("head_unavailable");
		const headDelta = parseRawHeadDelta(raw.stdout);
		if (headDelta === undefined) return fail("head_delta_invalid");
		const headDeltaPaths = headDelta.map((entry) => entry.path);
		for (const entry of headDelta) {
			if (!workerSet.has(entry.path)) return fail("head_delta_out_of_scope", entry.path);
			const expected = relevance.entries.find((candidate) => candidate.path === entry.path)?.full_identity;
			if (entry.status === "D" ? expected?.kind !== "missing" : expected?.kind !== "file") {
				return fail("head_delta_invalid", entry.path);
			}
		}
		if (headDeltaPaths.length !== workerPaths.length ||
			headDeltaPaths.some((path, index) => path !== workerPaths[index])) {
			const mismatchIndex = headDeltaPaths.findIndex((path, index) => path !== workerPaths[index]);
			return fail("head_delta_invalid", mismatchIndex >= 0
				? headDeltaPaths[mismatchIndex]
				: workerPaths[headDeltaPaths.length]);
		}

		const oldBaseline = canonicalBaselineEntries(input.afterGuard.entries, workerSet);
		const currentBaseline = canonicalBaselineEntries(currentGuard.guard.entries, workerSet);
		const oldBaselineHash = canonicalHash(oldBaseline);
		if (canonicalHash(currentBaseline) !== oldBaselineHash) return fail("baseline_conflict");

		const closedPaths = relevance.entries.map((entry) => entry.path);
		const captured = await captureStreamingIdentities({ project_root: input.projectRoot, paths: closedPaths });
		if (!captured.ok) return fail("identity_unavailable", captured.error.path);
		const currentContent = captured.identities.map(simplifiedIdentity);
		const expectedContent = relevance.entries.map((entry) => simplifiedIdentity(entry.full_identity));
		for (let index = 0; index < expectedContent.length; index += 1) {
			if (!sameContent(expectedContent[index]!, currentContent[index]!)) return fail("content_conflict", expectedContent[index]!.path);
		}

		const headDeltaHash = canonicalHash(headDelta);
		const closedContentHash = canonicalHash(currentContent);
		const projectionCore: Omit<HistoricalSemanticMigrationProjection, "migration_binding_hash"> = {
			schema_version: 1,
			kind: HISTORICAL_SEMANTIC_MIGRATION_KIND,
			old_git_head: oldHead,
			candidate_git_head: currentHead,
			head_delta_paths: headDeltaPaths,
			head_delta_hash: headDeltaHash,
			closed_content_hash: closedContentHash,
			baseline_guard_hash: oldBaselineHash,
		};
		return {
			ok: true,
			projection: {
				...projectionCore,
				migration_binding_hash: computeHistoricalSemanticMigrationBindingHashV2({
					delegation_id: input.delegationId,
					contract_hash: input.contractHash,
					base_review_hash: input.baseReviewHash,
					expected_bound_diff_hash: input.review.bound_diff_hash,
					projection: projectionCore,
				}),
			},
		};
	} catch {
		return fail("invalid_input");
	}
}
