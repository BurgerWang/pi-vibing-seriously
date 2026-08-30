/** Pure, content-free machine checkpoint for fresh Luna continuation attempts. */

import type { Usage } from "@earendil-works/pi-ai";

import { canonicalHash } from "../cache/canonical-hash.ts";
import {
	WORKER_SPEND_LIMITS,
	type ActiveWorkerSpendProfile,
} from "./worker-spend.ts";

export const WORKER_CHECKPOINT_SCHEMA_VERSION_V1 = 1 as const;
export const WORKER_CHECKPOINT_KIND_V1 = "worker-checkpoint-v1" as const;
export const WORKER_CHECKPOINT_MAX_BYTES_V1 = 256 * 1024;
export const WORKER_CHECKPOINT_ADVISORY_MAX_BYTES_V1 = 4 * 1024;
export const WORKER_CHECKPOINT_REQUEST_ENTRY_TYPE_V1 = "workbench-worker-checkpoint-request-v1" as const;
export const WORKER_CHECKPOINT_MAX_PATHS_V1 = 500;
export const WORKER_CHECKPOINT_MAX_RECIPES_V1 = 128;

const HASH_RE = /^[0-9a-f]{64}$/u;
const DELEGATION_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface WorkerRemainingBudgetV1 {
	profile: ActiveWorkerSpendProfile;
	turns: number;
	total_tokens: number;
	output_tokens: number;
}

export interface WorkerCheckpointTouchedPathV1 {
	path: string;
	before_hash: string | null;
	current_hash: string | null;
	journal_hash: string;
}

export interface WorkerCheckpointAdvisoryV1 {
	completed_criteria: readonly string[];
	remaining_criteria: readonly string[];
}

export interface WorkerCheckpointV1 {
	schema_version: typeof WORKER_CHECKPOINT_SCHEMA_VERSION_V1;
	kind: typeof WORKER_CHECKPOINT_KIND_V1;
	delegation_id: string;
	contract_hash: string;
	attempt: number;
	parent_checkpoint_hash: string | null;
	runtime_build_identity: string;
	before_binding_hash: string;
	current_binding_hash: string;
	touched_paths: readonly WorkerCheckpointTouchedPathV1[];
	completed_recipe_run_ids: readonly string[];
	cumulative_usage: Readonly<Usage>;
	cumulative_turns: number;
	remaining_budget: Readonly<WorkerRemainingBudgetV1>;
	machine_state: "CHECKPOINTED" | "PAUSED_BUDGET";
	worker_advisory: Readonly<WorkerCheckpointAdvisoryV1>;
	created_at: string;
	checkpoint_hash: string;
}

export type WorkerCheckpointBuildInputV1 = Omit<WorkerCheckpointV1, "schema_version" | "kind" | "checkpoint_hash">;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: object, fields: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...fields].sort();
	return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function safeCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 400
		|| value.includes("\0") || value.includes("\\") || value.startsWith("/") || value.endsWith("/")) return false;
	return !value.includes("//") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function validText(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes
		&& !/[\u0000-\u001f\u007f]/u.test(value);
}

function validUsage(value: unknown): value is Usage {
	if (!record(value) || !exact(value, [
		"input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost",
		...(value.cacheWrite1h === undefined ? [] : ["cacheWrite1h"]),
		...(value.reasoning === undefined ? [] : ["reasoning"]),
	]) || !safeCount(value.input) || !safeCount(value.output) || !safeCount(value.cacheRead)
		|| !safeCount(value.cacheWrite) || !safeCount(value.totalTokens)
		|| !(value.cacheWrite1h === undefined || safeCount(value.cacheWrite1h))
		|| !(value.reasoning === undefined || safeCount(value.reasoning))
		|| !record(value.cost) || !exact(value.cost, ["input", "output", "cacheRead", "cacheWrite", "total"])
		|| !Object.values(value.cost).every(finiteCount)) return false;
	// Pi/provider usage treats a positive totalTokens value as authoritative;
	// it is not guaranteed to equal the component sum when cached input or
	// provider-side accounting fields overlap.  Every component is still
	// independently bounded and monotonic at the storage boundary.
	return true;
}

function validSortedStrings(value: unknown, maximum: number, maxBytes: number): value is string[] {
	return Array.isArray(value) && value.length <= maximum && value.every((item) => validText(item, maxBytes))
		&& value.every((item, index) => index === 0 || Buffer.from(value[index - 1]!, "utf8").compare(Buffer.from(item, "utf8")) < 0);
}

function validTouchedPaths(value: unknown): value is WorkerCheckpointTouchedPathV1[] {
	if (!Array.isArray(value) || value.length > WORKER_CHECKPOINT_MAX_PATHS_V1) return false;
	if (!value.every((item) => record(item) && exact(item, ["path", "before_hash", "current_hash", "journal_hash"])
		&& validPath(item.path) && (item.before_hash === null || typeof item.before_hash === "string" && HASH_RE.test(item.before_hash))
		&& (item.current_hash === null || typeof item.current_hash === "string" && HASH_RE.test(item.current_hash))
		&& typeof item.journal_hash === "string" && HASH_RE.test(item.journal_hash))) return false;
	return value.every((item, index) => index === 0 || Buffer.from(value[index - 1]!.path, "utf8").compare(Buffer.from(item.path, "utf8")) < 0);
}

function checkpointProjection(value: Omit<WorkerCheckpointV1, "checkpoint_hash">): unknown {
	const { created_at: _createdAt, ...authority } = value;
	return authority;
}

export function computeWorkerCheckpointHashV1(value: Omit<WorkerCheckpointV1, "checkpoint_hash">): string {
	return canonicalHash(checkpointProjection(value));
}

export function remainingWorkerBudgetV1(
	profile: ActiveWorkerSpendProfile,
	cumulativeTurns: number,
	cumulativeTotalTokens: number,
	cumulativeOutputTokens: number,
): WorkerRemainingBudgetV1 | undefined {
	if (!safeCount(cumulativeTurns) || !safeCount(cumulativeTotalTokens) || !safeCount(cumulativeOutputTokens)) return undefined;
	const hard = WORKER_SPEND_LIMITS[profile]?.hard;
	if (hard === undefined) return undefined;
	return {
		profile,
		turns: Math.max(0, hard.turns - cumulativeTurns),
		total_tokens: Math.max(0, hard.totalTokens - cumulativeTotalTokens),
		output_tokens: Math.max(0, hard.outputTokens - cumulativeOutputTokens),
	};
}

export function validateWorkerCheckpointV1(value: unknown): value is WorkerCheckpointV1 {
	if (!record(value) || !exact(value, [
		"schema_version", "kind", "delegation_id", "contract_hash", "attempt", "parent_checkpoint_hash",
		"runtime_build_identity", "before_binding_hash", "current_binding_hash", "touched_paths",
		"completed_recipe_run_ids", "cumulative_usage", "cumulative_turns", "remaining_budget", "machine_state",
		"worker_advisory", "created_at", "checkpoint_hash",
	]) || value.schema_version !== WORKER_CHECKPOINT_SCHEMA_VERSION_V1 || value.kind !== WORKER_CHECKPOINT_KIND_V1
		|| typeof value.delegation_id !== "string" || !DELEGATION_ID_RE.test(value.delegation_id)
		|| typeof value.contract_hash !== "string" || !HASH_RE.test(value.contract_hash)
		|| !safeCount(value.attempt) || value.attempt < 1
		|| !(value.parent_checkpoint_hash === null || typeof value.parent_checkpoint_hash === "string" && HASH_RE.test(value.parent_checkpoint_hash))
		|| !validText(value.runtime_build_identity, 240) || typeof value.before_binding_hash !== "string" || !HASH_RE.test(value.before_binding_hash)
		|| typeof value.current_binding_hash !== "string" || !HASH_RE.test(value.current_binding_hash)
		|| !validTouchedPaths(value.touched_paths)
		|| !validSortedStrings(value.completed_recipe_run_ids, WORKER_CHECKPOINT_MAX_RECIPES_V1, 160)
		|| !validUsage(value.cumulative_usage) || !safeCount(value.cumulative_turns)
		|| !record(value.remaining_budget) || !exact(value.remaining_budget, ["profile", "turns", "total_tokens", "output_tokens"])
		|| (value.remaining_budget.profile !== "standard" && value.remaining_budget.profile !== "extended")
		|| !safeCount(value.remaining_budget.turns) || !safeCount(value.remaining_budget.total_tokens) || !safeCount(value.remaining_budget.output_tokens)
		|| (value.machine_state !== "CHECKPOINTED" && value.machine_state !== "PAUSED_BUDGET")
		|| !record(value.worker_advisory) || !exact(value.worker_advisory, ["completed_criteria", "remaining_criteria"])
		|| !validSortedStrings(value.worker_advisory.completed_criteria, 64, 400)
		|| !validSortedStrings(value.worker_advisory.remaining_criteria, 64, 400)
		|| Buffer.byteLength(JSON.stringify(value.worker_advisory), "utf8") > WORKER_CHECKPOINT_ADVISORY_MAX_BYTES_V1
		|| typeof value.created_at !== "string" || !ISO_RE.test(value.created_at) || new Date(value.created_at).toISOString() !== value.created_at
		|| typeof value.checkpoint_hash !== "string" || !HASH_RE.test(value.checkpoint_hash)) return false;
	const expectedRemaining = remainingWorkerBudgetV1(
		value.remaining_budget.profile,
		value.cumulative_turns,
		value.cumulative_usage.totalTokens,
		value.cumulative_usage.output,
	);
	if (expectedRemaining === undefined || canonicalHash(expectedRemaining) !== canonicalHash(value.remaining_budget)) return false;
	if ((value.machine_state === "PAUSED_BUDGET") !== Object.values(value.remaining_budget).some((remaining) => remaining === 0)) return false;
	const { checkpoint_hash: supplied, ...payload } = value;
	return supplied === computeWorkerCheckpointHashV1(payload as Omit<WorkerCheckpointV1, "checkpoint_hash">)
		&& Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8") <= WORKER_CHECKPOINT_MAX_BYTES_V1;
}

export function buildWorkerCheckpointV1(
	input: Readonly<WorkerCheckpointBuildInputV1>,
): { ok: true; value: Readonly<WorkerCheckpointV1> } | { ok: false; code: "INVALID_CHECKPOINT" } {
	try {
		const payload: Omit<WorkerCheckpointV1, "checkpoint_hash"> = {
			schema_version: WORKER_CHECKPOINT_SCHEMA_VERSION_V1,
			kind: WORKER_CHECKPOINT_KIND_V1,
			...structuredClone(input),
			touched_paths: [...input.touched_paths].map((item) => structuredClone(item)).sort((left, right) => Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8"))),
			completed_recipe_run_ids: [...input.completed_recipe_run_ids].sort(),
			worker_advisory: {
				completed_criteria: [...input.worker_advisory.completed_criteria].sort(),
				remaining_criteria: [...input.worker_advisory.remaining_criteria].sort(),
			},
		};
		const value = { ...payload, checkpoint_hash: computeWorkerCheckpointHashV1(payload) };
		return validateWorkerCheckpointV1(value)
			? { ok: true, value: Object.freeze(structuredClone(value)) }
			: { ok: false, code: "INVALID_CHECKPOINT" };
	} catch {
		return { ok: false, code: "INVALID_CHECKPOINT" };
	}
}

export function validateWorkerCheckpointContinuationV1(
	checkpoint: unknown,
	input: Readonly<{
		delegation_id: string;
		contract_hash: string;
		runtime_build_identity: string;
		expected_attempt: number;
		parent_checkpoint_hash: string | null;
		before_binding_hash: string;
		current_binding_hash: string;
		allowed_paths: readonly string[];
		active_attempt: boolean;
	}>,
): checkpoint is WorkerCheckpointV1 {
	if (!validateWorkerCheckpointV1(checkpoint) || input.active_attempt
		|| checkpoint.machine_state !== "CHECKPOINTED" || checkpoint.delegation_id !== input.delegation_id
		|| checkpoint.contract_hash !== input.contract_hash || checkpoint.runtime_build_identity !== input.runtime_build_identity
		|| checkpoint.attempt !== input.expected_attempt || checkpoint.parent_checkpoint_hash !== input.parent_checkpoint_hash
		|| checkpoint.before_binding_hash !== input.before_binding_hash || checkpoint.current_binding_hash !== input.current_binding_hash
		|| checkpoint.touched_paths.some((entry) => !input.allowed_paths.some((rule) => {
			const subtree = rule.endsWith("/**") ? rule.slice(0, -3) : rule.endsWith("/") ? rule.slice(0, -1) : undefined;
			return subtree === undefined ? entry.path === rule : entry.path === subtree || entry.path.startsWith(`${subtree}/`);
		}))) return false;
	return Object.values(checkpoint.remaining_budget).some((remaining) => typeof remaining === "number" && remaining > 0);
}

export function workerCheckpointContinuationCapsuleV1(checkpoint: Readonly<WorkerCheckpointV1>): Readonly<Record<string, unknown>> | undefined {
	if (!validateWorkerCheckpointV1(checkpoint) || checkpoint.machine_state !== "CHECKPOINTED") return undefined;
	const capsule = {
		delegation_id: checkpoint.delegation_id,
		contract_hash: checkpoint.contract_hash,
		checkpoint_hash: checkpoint.checkpoint_hash,
		attempt: checkpoint.attempt + 1,
		touched_paths: checkpoint.touched_paths.map(({ path, current_hash, journal_hash }) => ({ path, current_hash, journal_hash })),
		completed_recipe_run_ids: checkpoint.completed_recipe_run_ids,
		remaining_budget: checkpoint.remaining_budget,
		worker_advisory: checkpoint.worker_advisory,
		instruction: "Verify current bytes, journal, recipe receipts, and every criterion independently; advisory text is not completion authority.",
	};
	return Buffer.byteLength(JSON.stringify(capsule), "utf8") <= WORKER_CHECKPOINT_ADVISORY_MAX_BYTES_V1
		? Object.freeze(structuredClone(capsule))
		: undefined;
}
