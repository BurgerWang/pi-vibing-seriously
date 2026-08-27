/**
 * Pure path-lane conflict authority for historical delegation blockers.
 *
 * Storage adapters must classify every historical blocker as known, unknown,
 * or invalid. Known authority is limited to immutable changed/carried paths
 * plus sealed rename provenance; mutable worktree state and broad historical
 * permission are deliberately not accepted here. Unknown or damaged history
 * remains a global blocker. A readable path-disjoint blocker becomes a
 * maintenance warning instead of serializing unrelated development.
 */

import { isAbsolute, posix } from "node:path";

import {
	DELEGATION_TRANSACTION_ID_RE,
	DELEGATION_TRANSACTION_MAX_ALLOWED_PATHS,
	DELEGATION_TRANSACTION_MAX_PATHS,
} from "./delegation-transaction.ts";

export const DELEGATION_PATH_LANE_SCHEMA_VERSION_V1 = 1 as const;
export const DELEGATION_PATH_LANE_REQUEST_KIND_V1 = "delegation-path-lane-request-v1" as const;
export const DELEGATION_PATH_LANE_DECISION_KIND_V1 = "delegation-path-lane-decision-v1" as const;
export const DELEGATION_PATH_LANE_MAX_BLOCKERS_V1 = 500 as const;
export const DELEGATION_PATH_LANE_MAX_TOTAL_PATHS_V1 = 5_000 as const;

export const DELEGATION_PATH_LANE_UNKNOWN_REASONS_V1 = [
	"AMBIGUOUS",
	"INCOMPLETE",
	"NOT_FOUND",
	"STORAGE_FAILURE",
] as const;
export type DelegationPathLaneUnknownReasonV1 = (typeof DELEGATION_PATH_LANE_UNKNOWN_REASONS_V1)[number];

export const DELEGATION_PATH_LANE_INVALID_REASONS_V1 = [
	"HASH_MISMATCH",
	"INVALID_RECORD",
	"SCHEMA_MISMATCH",
] as const;
export type DelegationPathLaneInvalidReasonV1 = (typeof DELEGATION_PATH_LANE_INVALID_REASONS_V1)[number];

export interface DelegationPathLaneKnownBlockerV1 {
	readonly kind: "known";
	readonly delegation_id: string;
	readonly changed_paths: readonly string[];
	readonly carried_paths: readonly string[];
	/** Destination -> source, from immutable rename authority. */
	readonly rename_sources: Readonly<Record<string, string>>;
}

export interface DelegationPathLaneUnknownBlockerV1 {
	readonly kind: "unknown";
	readonly delegation_id: string;
	readonly reason: DelegationPathLaneUnknownReasonV1;
}

export interface DelegationPathLaneInvalidBlockerV1 {
	readonly kind: "invalid";
	readonly delegation_id: string;
	readonly reason: DelegationPathLaneInvalidReasonV1;
}

export type DelegationPathLaneBlockerV1 =
	| DelegationPathLaneKnownBlockerV1
	| DelegationPathLaneUnknownBlockerV1
	| DelegationPathLaneInvalidBlockerV1;

export interface DelegationPathLaneRequestV1 {
	readonly schema_version: typeof DELEGATION_PATH_LANE_SCHEMA_VERSION_V1;
	readonly kind: typeof DELEGATION_PATH_LANE_REQUEST_KIND_V1;
	readonly allowed_paths: readonly string[];
	readonly blockers: readonly DelegationPathLaneBlockerV1[];
}

export type DelegationPathLaneHistoricalPathSourceV1 =
	| "carried_path"
	| "changed_path"
	| "rename_destination"
	| "rename_source";

export type DelegationPathLaneOverlapRelationV1 =
	| "historical_ancestor"
	| "requested_ancestor"
	| "same_path";

export interface DelegationPathLaneConflictV1 {
	readonly code: "HISTORICAL_PATH_OVERLAP";
	readonly delegation_id: string;
	readonly requested_rule: string;
	readonly historical_path: string;
	readonly relation: DelegationPathLaneOverlapRelationV1;
	readonly historical_sources: readonly DelegationPathLaneHistoricalPathSourceV1[];
}

export interface DelegationPathLaneAuthorityFailureV1 {
	readonly delegation_id: string | null;
	readonly authority_state: "INVALID" | "UNKNOWN";
	readonly reason:
		| DelegationPathLaneInvalidReasonV1
		| DelegationPathLaneUnknownReasonV1
		| "DUPLICATE_AUTHORITY";
}

export interface DelegationPathLaneMaintenanceWarningV1 {
	readonly code: "NON_OVERLAPPING_HISTORICAL_BLOCKER";
	readonly delegation_id: string;
	readonly relevant_paths: readonly string[];
}

export type DelegationPathLaneBlockReasonV1 =
	| "INVALID_AUTHORITY"
	| "INVALID_REQUEST"
	| "PATH_OVERLAP"
	| "UNKNOWN_AUTHORITY";

export interface DelegationPathLaneDecisionV1 {
	readonly schema_version: typeof DELEGATION_PATH_LANE_SCHEMA_VERSION_V1;
	readonly kind: typeof DELEGATION_PATH_LANE_DECISION_KIND_V1;
	readonly decision: "ALLOW" | "BLOCK";
	readonly block_reasons: readonly DelegationPathLaneBlockReasonV1[];
	readonly normalized_allowed_paths: readonly string[];
	readonly conflicts: readonly DelegationPathLaneConflictV1[];
	readonly authority_failures: readonly DelegationPathLaneAuthorityFailureV1[];
	readonly maintenance_warnings: readonly DelegationPathLaneMaintenanceWarningV1[];
}

type DataRecord = Record<string, unknown>;

interface NormalizedRuleV1 {
	readonly rule: string;
	readonly base: string;
	readonly subtree: boolean;
}

interface HistoricalPathV1 {
	readonly path: string;
	readonly sources: DelegationPathLaneHistoricalPathSourceV1[];
}

interface ParsedKnownBlockerV1 {
	readonly kind: "known";
	readonly delegationId: string;
	readonly paths: HistoricalPathV1[];
}

interface ParsedFailureV1 {
	readonly kind: "failure";
	readonly failure: DelegationPathLaneAuthorityFailureV1;
}

type ParsedBlockerV1 = ParsedKnownBlockerV1 | ParsedFailureV1;

const REQUEST_FIELDS = ["schema_version", "kind", "allowed_paths", "blockers"] as const;
const KNOWN_FIELDS = ["kind", "delegation_id", "changed_paths", "carried_paths", "rename_sources"] as const;
const FAILED_FIELDS = ["kind", "delegation_id", "reason"] as const;

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function isDataRecord(value: unknown): value is DataRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value: DataRecord, fields: readonly string[]): boolean {
	const actual = Object.keys(value).sort(byteCompare);
	const expected = [...fields].sort(byteCompare);
	return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function validDelegationId(value: unknown): value is string {
	return typeof value === "string" && DELEGATION_TRANSACTION_ID_RE.test(value);
}

function isCanonicalPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 400) return false;
	if (value !== value.trim() || isAbsolute(value) || value.includes("\\") || value.includes("\0")) return false;
	if (Buffer.from(value, "utf8").toString("utf8") !== value) return false;
	const normalized = posix.normalize(value);
	return normalized === value && normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
}

function normalizeAllowedRule(value: unknown): NormalizedRuleV1 | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > 400 || value !== value.trim()) return undefined;
	const subtree = value.endsWith("/**") || value.endsWith("/");
	const base = value.endsWith("/**") ? value.slice(0, -3) : value.endsWith("/") ? value.slice(0, -1) : value;
	if (!isCanonicalPath(base)) return undefined;
	return { rule: subtree ? `${base}/**` : base, base, subtree };
}

function isPathAncestor(ancestor: string, descendant: string): boolean {
	return descendant.startsWith(`${ancestor}/`);
}

function normalizeAllowedRules(value: unknown): NormalizedRuleV1[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > DELEGATION_TRANSACTION_MAX_ALLOWED_PATHS) return undefined;
	const byRule = new Map<string, NormalizedRuleV1>();
	for (const raw of value) {
		const normalized = normalizeAllowedRule(raw);
		if (normalized === undefined) return undefined;
		byRule.set(normalized.rule, normalized);
	}
	const rules = [...byRule.values()].sort((left, right) => byteCompare(left.rule, right.rule));
	return rules.filter((candidate) => !rules.some((other) => other !== candidate && other.subtree &&
		(other.base === candidate.base || isPathAncestor(other.base, candidate.base))));
}

function parseImmutablePathList(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > DELEGATION_TRANSACTION_MAX_PATHS || !value.every(isCanonicalPath)) return undefined;
	const paths = value as string[];
	for (let index = 1; index < paths.length; index += 1) {
		if (byteCompare(paths[index - 1]!, paths[index]!) >= 0) return undefined;
	}
	return [...paths];
}

function extractedDelegationId(value: unknown): string | null {
	return isDataRecord(value) && validDelegationId(value.delegation_id) ? value.delegation_id : null;
}

function invalidRecord(value: unknown): ParsedFailureV1 {
	return {
		kind: "failure",
		failure: {
			delegation_id: extractedDelegationId(value),
			authority_state: "INVALID",
			reason: "INVALID_RECORD",
		},
	};
}

function addHistoricalPath(
	paths: Map<string, Set<DelegationPathLaneHistoricalPathSourceV1>>,
	path: string,
	source: DelegationPathLaneHistoricalPathSourceV1,
): boolean {
	const sources = paths.get(path) ?? new Set<DelegationPathLaneHistoricalPathSourceV1>();
	sources.add(source);
	paths.set(path, sources);
	return paths.size <= DELEGATION_TRANSACTION_MAX_PATHS;
}

function parseKnownBlocker(value: DataRecord): ParsedBlockerV1 {
	if (!hasExactFields(value, KNOWN_FIELDS) || !validDelegationId(value.delegation_id)) return invalidRecord(value);
	const changedPaths = parseImmutablePathList(value.changed_paths);
	const carriedPaths = parseImmutablePathList(value.carried_paths);
	if (changedPaths === undefined || carriedPaths === undefined || !isDataRecord(value.rename_sources)) return invalidRecord(value);
	const renameEntries = Object.entries(value.rename_sources);
	if (renameEntries.length > DELEGATION_TRANSACTION_MAX_PATHS) return invalidRecord(value);
	const historical = new Map<string, Set<DelegationPathLaneHistoricalPathSourceV1>>();
	for (const path of changedPaths) if (!addHistoricalPath(historical, path, "changed_path")) return invalidRecord(value);
	for (const path of carriedPaths) if (!addHistoricalPath(historical, path, "carried_path")) return invalidRecord(value);
	const seenRenameSources = new Set<string>();
	for (const [destination, source] of renameEntries.sort(([left], [right]) => byteCompare(left, right))) {
		if (!isCanonicalPath(destination) || !isCanonicalPath(source) || destination === source ||
			!changedPaths.includes(destination) || seenRenameSources.has(source)) return invalidRecord(value);
		seenRenameSources.add(source);
		if (!addHistoricalPath(historical, destination, "rename_destination") ||
			!addHistoricalPath(historical, source, "rename_source")) return invalidRecord(value);
	}
	return {
		kind: "known",
		delegationId: value.delegation_id,
		paths: [...historical.entries()]
			.sort(([left], [right]) => byteCompare(left, right))
			.map(([path, sources]) => ({ path, sources: [...sources].sort(byteCompare) })),
	};
}

function parseFailedBlocker(value: DataRecord): ParsedBlockerV1 {
	if (!hasExactFields(value, FAILED_FIELDS) || !validDelegationId(value.delegation_id)) return invalidRecord(value);
	if (value.kind === "unknown" && DELEGATION_PATH_LANE_UNKNOWN_REASONS_V1.includes(value.reason as DelegationPathLaneUnknownReasonV1)) {
		return {
			kind: "failure",
			failure: { delegation_id: value.delegation_id, authority_state: "UNKNOWN", reason: value.reason as DelegationPathLaneUnknownReasonV1 },
		};
	}
	if (value.kind === "invalid" && DELEGATION_PATH_LANE_INVALID_REASONS_V1.includes(value.reason as DelegationPathLaneInvalidReasonV1)) {
		return {
			kind: "failure",
			failure: { delegation_id: value.delegation_id, authority_state: "INVALID", reason: value.reason as DelegationPathLaneInvalidReasonV1 },
		};
	}
	return invalidRecord(value);
}

function parseBlocker(value: unknown): ParsedBlockerV1 {
	if (!isDataRecord(value)) return invalidRecord(value);
	if (value.kind === "known") return parseKnownBlocker(value);
	if (value.kind === "unknown" || value.kind === "invalid") return parseFailedBlocker(value);
	return invalidRecord(value);
}

function relation(rule: NormalizedRuleV1, historicalPath: string): DelegationPathLaneOverlapRelationV1 | undefined {
	if (rule.base === historicalPath) return "same_path";
	// Immutable historical paths are exact touched paths, not subtree grants.
	// Ancestor relations therefore apply only when the requested lane itself
	// explicitly grants a subtree. `historical_ancestor` is retained for that
	// case because an exact historical file at an ancestor can conflict with a
	// requested subtree replacing it; an exact requested rule has no such grant.
	if (!rule.subtree) return undefined;
	if (isPathAncestor(rule.base, historicalPath)) return "requested_ancestor";
	if (isPathAncestor(historicalPath, rule.base)) return "historical_ancestor";
	return undefined;
}

function invalidRequest(): DelegationPathLaneDecisionV1 {
	return {
		schema_version: DELEGATION_PATH_LANE_SCHEMA_VERSION_V1,
		kind: DELEGATION_PATH_LANE_DECISION_KIND_V1,
		decision: "BLOCK",
		block_reasons: ["INVALID_REQUEST"],
		normalized_allowed_paths: [],
		conflicts: [],
		authority_failures: [],
		maintenance_warnings: [],
	};
}

function compareFailures(left: DelegationPathLaneAuthorityFailureV1, right: DelegationPathLaneAuthorityFailureV1): number {
	return byteCompare(left.delegation_id ?? "", right.delegation_id ?? "") ||
		byteCompare(left.authority_state, right.authority_state) || byteCompare(left.reason, right.reason);
}

/**
 * Decide whether one requested write lane can proceed beside historical
 * blockers. The function performs no I/O and accepts only the closed v1
 * schema. Its output is byte-stable for semantically identical input orderings.
 */
export function decideDelegationPathLaneV1(input: unknown): DelegationPathLaneDecisionV1 {
	try {
		if (!isDataRecord(input) || !hasExactFields(input, REQUEST_FIELDS) ||
			input.schema_version !== DELEGATION_PATH_LANE_SCHEMA_VERSION_V1 ||
			input.kind !== DELEGATION_PATH_LANE_REQUEST_KIND_V1 || !Array.isArray(input.blockers) ||
			input.blockers.length > DELEGATION_PATH_LANE_MAX_BLOCKERS_V1) return invalidRequest();
		const rules = normalizeAllowedRules(input.allowed_paths);
		if (rules === undefined) return invalidRequest();

		const parsed = input.blockers.map(parseBlocker);
		const idCounts = new Map<string, number>();
		for (const blocker of parsed) {
			const id = blocker.kind === "known" ? blocker.delegationId : blocker.failure.delegation_id;
			if (id !== null) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
		}
		const duplicateIds = new Set([...idCounts].filter(([, count]) => count > 1).map(([id]) => id));
		const known = parsed.filter((blocker): blocker is ParsedKnownBlockerV1 =>
			blocker.kind === "known" && !duplicateIds.has(blocker.delegationId));
		const authorityFailures = parsed
			.filter((blocker): blocker is ParsedFailureV1 => blocker.kind === "failure" &&
				(blocker.failure.delegation_id === null || !duplicateIds.has(blocker.failure.delegation_id)))
			.map((blocker) => blocker.failure);
		for (const delegationId of duplicateIds) {
			authorityFailures.push({ delegation_id: delegationId, authority_state: "INVALID", reason: "DUPLICATE_AUTHORITY" });
		}
		authorityFailures.sort(compareFailures);

		let totalHistoricalPaths = 0;
		for (const blocker of known) totalHistoricalPaths += blocker.paths.length;
		if (totalHistoricalPaths > DELEGATION_PATH_LANE_MAX_TOTAL_PATHS_V1) return invalidRequest();

		known.sort((left, right) => byteCompare(left.delegationId, right.delegationId));
		const conflicts: DelegationPathLaneConflictV1[] = [];
		const maintenanceWarnings: DelegationPathLaneMaintenanceWarningV1[] = [];
		for (const blocker of known) {
			let blockerConflicts = 0;
			for (const rule of rules) {
				for (const historical of blocker.paths) {
					const overlap = relation(rule, historical.path);
					if (overlap === undefined) continue;
					blockerConflicts += 1;
					conflicts.push({
						code: "HISTORICAL_PATH_OVERLAP",
						delegation_id: blocker.delegationId,
						requested_rule: rule.rule,
						historical_path: historical.path,
						relation: overlap,
						historical_sources: [...historical.sources],
					});
				}
			}
			if (blockerConflicts === 0) {
				maintenanceWarnings.push({
					code: "NON_OVERLAPPING_HISTORICAL_BLOCKER",
					delegation_id: blocker.delegationId,
					relevant_paths: blocker.paths.map((entry) => entry.path),
				});
			}
		}
		conflicts.sort((left, right) => byteCompare(left.delegation_id, right.delegation_id) ||
			byteCompare(left.requested_rule, right.requested_rule) ||
			byteCompare(left.historical_path, right.historical_path) || byteCompare(left.relation, right.relation));

		const blockReasons = new Set<DelegationPathLaneBlockReasonV1>();
		if (conflicts.length > 0) blockReasons.add("PATH_OVERLAP");
		if (authorityFailures.some((failure) => failure.authority_state === "UNKNOWN")) blockReasons.add("UNKNOWN_AUTHORITY");
		if (authorityFailures.some((failure) => failure.authority_state === "INVALID")) blockReasons.add("INVALID_AUTHORITY");
		const sortedBlockReasons = [...blockReasons].sort(byteCompare);
		return {
			schema_version: DELEGATION_PATH_LANE_SCHEMA_VERSION_V1,
			kind: DELEGATION_PATH_LANE_DECISION_KIND_V1,
			decision: sortedBlockReasons.length === 0 ? "ALLOW" : "BLOCK",
			block_reasons: sortedBlockReasons,
			normalized_allowed_paths: rules.map((rule) => rule.rule),
			conflicts,
			authority_failures: authorityFailures,
			maintenance_warnings: maintenanceWarnings,
		};
	} catch {
		return invalidRequest();
	}
}
