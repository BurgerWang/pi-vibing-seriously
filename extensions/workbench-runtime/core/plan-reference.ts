/**
 * Optional plan traceability bound into the existing delegation-v2 contract.
 *
 * A plan reference never grants acceptance. It only identifies one durable
 * plan snapshot and maps stable criterion ids to Gate ids that a later formal
 * invocation must cover. Gate outcomes remain the sole machine verdicts.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";
import { types as utilTypes } from "node:util";

import { canonicalHash } from "../cache/canonical-hash.ts";
import { realpathContained } from "./path-guard.ts";

export const PLAN_REFERENCE_SCHEMA = "workbench-plan-ref-v1" as const;
export const PLAN_REFERENCE_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "BLOCKED", "EVIDENCED"] as const;
export const MAX_PLAN_CRITERIA = 20;
export const MAX_PLAN_CHECK_REFS = 20;
export const MAX_PLAN_EVIDENCE_REFS = 20;
export const MAX_PLAN_FILE_BYTES = 1024 * 1024;

export type PlanReferenceStatus = typeof PLAN_REFERENCE_STATUSES[number];

export interface PlanCriterionReference {
	id: string;
	gate_id: string;
	check_ids: string[];
	evidence_paths: string[];
}

export interface PlanReferenceV1 {
	schema: typeof PLAN_REFERENCE_SCHEMA;
	plan_id: string;
	version: string;
	plan_path: string;
	plan_sha256: string;
	candidate: string;
	status: PlanReferenceStatus;
	criteria: PlanCriterionReference[];
	next_action: string;
}

export interface PlanGateCoverage {
	requiredGateIds: string[];
	missingGateIds: string[];
	nonPassGateIds: string[];
	covered: boolean;
}

export type CurrentPlanReferenceErrorCode =
	| "invalid_reference"
	| "invalid_project_root"
	| "unsafe_path"
	| "unavailable"
	| "not_regular_file"
	| "too_large"
	| "changed_during_read"
	| "digest_mismatch";

export type CurrentPlanReferenceResult =
	| { ok: true; value: PlanReferenceV1 }
	| { ok: false; error: { code: CurrentPlanReferenceErrorCode; message: string } };

const PLAN_KEYS = [
	"schema", "plan_id", "version", "plan_path", "plan_sha256", "candidate", "status", "criteria", "next_action",
] as const;
const CRITERION_KEYS = ["id", "gate_id", "check_ids", "evidence_paths"] as const;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GATE_ID_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
	try {
		if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return undefined;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const names = Object.keys(descriptors);
		if (names.length !== keys.length || names.some((name) => !keys.includes(name))) return undefined;
		const output: Record<string, unknown> = Object.create(null);
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return undefined;
			output[key] = descriptor.value;
		}
		return output;
	} catch {
		return undefined;
	}
}

function boundedText(value: unknown, max: number): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= max
		&& value === value.trim()
		&& !value.includes("\0")
		&& !/[\u0001-\u001f\u007f]/u.test(value);
}

function strictRelativePath(value: unknown): value is string {
	if (!boundedText(value, 400) || isAbsolute(value) || value.includes("\\")) return false;
	const normalized = posix.normalize(value);
	return normalized === value && normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
}

function sortedUnique(values: readonly string[]): boolean {
	return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function parseStringList(value: unknown, maxItems: number, itemPattern?: RegExp): string[] | undefined {
	if (!Array.isArray(value) || value.length > maxItems) return undefined;
	if (!value.every((item) => boundedText(item, 200) && (itemPattern === undefined || itemPattern.test(item)))) return undefined;
	const output = [...value] as string[];
	return sortedUnique(output) ? output : undefined;
}

function parseCriterion(value: unknown): PlanCriterionReference | undefined {
	const record = exactRecord(value, CRITERION_KEYS);
	if (!record
		|| typeof record.id !== "string" || !ID_RE.test(record.id)
		|| typeof record.gate_id !== "string" || record.gate_id === "UNMAPPED" || !GATE_ID_RE.test(record.gate_id)) return undefined;
	const checkIds = parseStringList(record.check_ids, MAX_PLAN_CHECK_REFS, ID_RE);
	if (!checkIds || !Array.isArray(record.evidence_paths) || record.evidence_paths.length > MAX_PLAN_EVIDENCE_REFS) return undefined;
	const evidencePaths = record.evidence_paths as unknown[];
	if (!evidencePaths.every(strictRelativePath)) return undefined;
	const fixedEvidence = [...evidencePaths] as string[];
	if (!sortedUnique(fixedEvidence)) return undefined;
	return Object.freeze({
		id: record.id,
		gate_id: record.gate_id,
		check_ids: Object.freeze(checkIds) as unknown as string[],
		evidence_paths: Object.freeze(fixedEvidence) as unknown as string[],
	});
}

/** Strict canonical parser for persisted/bound plan references. */
export function parsePlanReference(value: unknown): PlanReferenceV1 | undefined {
	const record = exactRecord(value, PLAN_KEYS);
	if (!record
		|| record.schema !== PLAN_REFERENCE_SCHEMA
		|| typeof record.plan_id !== "string" || !ID_RE.test(record.plan_id)
		|| !boundedText(record.version, 64)
		|| !strictRelativePath(record.plan_path)
		|| typeof record.plan_sha256 !== "string" || !SHA256_RE.test(record.plan_sha256)
		|| !boundedText(record.candidate, 128)
		|| !PLAN_REFERENCE_STATUSES.includes(record.status as PlanReferenceStatus)
		|| !Array.isArray(record.criteria)
		|| record.criteria.length === 0
		|| record.criteria.length > MAX_PLAN_CRITERIA
		|| !boundedText(record.next_action, 500)) return undefined;
	const criteria = record.criteria.map(parseCriterion);
	if (criteria.some((criterion) => criterion === undefined)) return undefined;
	const fixedCriteria = criteria as PlanCriterionReference[];
	if (!sortedUnique(fixedCriteria.map((criterion) => criterion.id))) return undefined;
	return Object.freeze({
		schema: PLAN_REFERENCE_SCHEMA,
		plan_id: record.plan_id,
		version: record.version,
		plan_path: record.plan_path,
		plan_sha256: record.plan_sha256,
		candidate: record.candidate,
		status: record.status as PlanReferenceStatus,
		criteria: Object.freeze(fixedCriteria) as unknown as PlanCriterionReference[],
		next_action: record.next_action,
	});
}

function normalizeStrings(value: unknown, maxItems: number, pattern?: RegExp): string[] | undefined {
	if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => typeof item === "string")) return undefined;
	const output = (value as string[]).map((item) => item.trim()).sort();
	if (!output.every((item) => boundedText(item, 200) && (pattern === undefined || pattern.test(item))) || !sortedUnique(output)) return undefined;
	return output;
}

/** Normalize the public optional tool input once before canonical hashing. */
export function normalizePlanReference(value: unknown): PlanReferenceV1 | undefined {
	if (value === undefined) return undefined;
	const record = exactRecord(value, PLAN_KEYS);
	if (!record || !Array.isArray(record.criteria)) return undefined;
	const criteria: PlanCriterionReference[] = [];
	for (const raw of record.criteria) {
		const criterion = exactRecord(raw, CRITERION_KEYS);
		if (!criterion || typeof criterion.id !== "string" || typeof criterion.gate_id !== "string") return undefined;
		const checkIds = normalizeStrings(criterion.check_ids, MAX_PLAN_CHECK_REFS, ID_RE);
		if (!checkIds || !Array.isArray(criterion.evidence_paths) || criterion.evidence_paths.length > MAX_PLAN_EVIDENCE_REFS) return undefined;
		const evidencePaths = (criterion.evidence_paths as unknown[]).map((item) => typeof item === "string" ? item.trim() : item);
		if (!evidencePaths.every(strictRelativePath)) return undefined;
		const sortedEvidence = [...evidencePaths as string[]].sort();
		if (!sortedUnique(sortedEvidence)) return undefined;
		criteria.push({ id: criterion.id.trim(), gate_id: criterion.gate_id.trim(), check_ids: checkIds, evidence_paths: sortedEvidence });
	}
	criteria.sort((left, right) => left.id.localeCompare(right.id));
	const normalized = {
		schema: record.schema,
		plan_id: typeof record.plan_id === "string" ? record.plan_id.trim() : record.plan_id,
		version: typeof record.version === "string" ? record.version.trim() : record.version,
		plan_path: typeof record.plan_path === "string" ? record.plan_path.trim() : record.plan_path,
		plan_sha256: record.plan_sha256,
		candidate: typeof record.candidate === "string" ? record.candidate.trim() : record.candidate,
		status: record.status,
		criteria,
		next_action: typeof record.next_action === "string" ? record.next_action.trim() : record.next_action,
	};
	return parsePlanReference(normalized);
}

/** Privacy-safe identity copied into validation Gate state. */
export function planReferenceHash(value: unknown): string | null {
	const parsed = parsePlanReference(value);
	return parsed ? canonicalHash(parsed) : null;
}

export function requiredPlanGateIds(value: unknown): string[] {
	const parsed = parsePlanReference(value);
	return parsed ? [...new Set(parsed.criteria.map((criterion) => criterion.gate_id))].sort() : [];
}

function currentPlanFailure(code: CurrentPlanReferenceErrorCode, message: string): CurrentPlanReferenceResult {
	return { ok: false, error: { code, message } };
}

/**
 * Bind a public plan reference to the current project bytes before delegation.
 *
 * The strict relative path is resolved through the existing realpath
 * containment guard. The opened regular file is read through a fixed byte
 * ceiling, then both its stat identity and containment are checked again.
 * This is traceability only: success cannot grant a Gate result or review.
 */
export async function verifyCurrentPlanReference(
	projectRoot: string,
	value: unknown,
): Promise<CurrentPlanReferenceResult> {
	const parsed = parsePlanReference(value);
	if (parsed === undefined) return currentPlanFailure("invalid_reference", "plan_ref is not a strict workbench-plan-ref-v1 value");
	if (typeof projectRoot !== "string" || projectRoot.length === 0 || projectRoot !== projectRoot.trim() ||
		!isAbsolute(projectRoot) || projectRoot.includes("\0")) {
		return currentPlanFailure("invalid_project_root", "project root is not an absolute normalized path");
	}
	let contained: string | undefined;
	try {
		contained = await realpathContained(projectRoot, parsed.plan_path);
	} catch {
		return currentPlanFailure("unavailable", "plan_ref path could not be resolved");
	}
	if (contained === undefined) return currentPlanFailure("unsafe_path", "plan_ref path escapes the project realpath boundary");

	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(contained, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		const before = await handle.stat({ bigint: true });
		if (!before.isFile()) return currentPlanFailure("not_regular_file", "plan_ref path is not a regular file");
		if (before.size > BigInt(MAX_PLAN_FILE_BYTES)) {
			return currentPlanFailure("too_large", "plan_ref file exceeds the fixed byte bound");
		}

		const bytes = Buffer.allocUnsafe(MAX_PLAN_FILE_BYTES + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const read = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (read.bytesRead === 0) break;
			offset += read.bytesRead;
		}
		if (offset > MAX_PLAN_FILE_BYTES) {
			return currentPlanFailure("too_large", "plan_ref file exceeds the fixed byte bound");
		}

		const after = await handle.stat({ bigint: true });
		const containedAfter = await realpathContained(projectRoot, parsed.plan_path);
		if (containedAfter !== contained || before.dev !== after.dev || before.ino !== after.ino ||
			before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
			BigInt(offset) !== after.size) {
			return currentPlanFailure("changed_during_read", "plan_ref file changed while its current bytes were being bound");
		}
		const digest = createHash("sha256").update(bytes.subarray(0, offset)).digest("hex");
		if (digest !== parsed.plan_sha256) {
			return currentPlanFailure("digest_mismatch", "plan_ref sha256 does not match the current project file bytes");
		}
		return { ok: true, value: parsed };
	} catch {
		return currentPlanFailure("unavailable", "plan_ref file could not be read safely");
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/** Necessary coverage only; it never upgrades any Gate outcome. */
export function evaluatePlanGateCoverage(
	value: unknown,
	gateStatuses: Readonly<Record<string, string>>,
): PlanGateCoverage {
	const requiredGateIds = requiredPlanGateIds(value);
	const missingGateIds = requiredGateIds.filter((gateId) => !Object.prototype.hasOwnProperty.call(gateStatuses, gateId));
	const nonPassGateIds = requiredGateIds.filter((gateId) =>
		Object.prototype.hasOwnProperty.call(gateStatuses, gateId) && gateStatuses[gateId] !== "PASS");
	return Object.freeze({
		requiredGateIds,
		missingGateIds,
		nonPassGateIds,
		covered: requiredGateIds.length > 0 && missingGateIds.length === 0 && nonPassGateIds.length === 0,
	});
}
