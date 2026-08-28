/**
 * ChangeSet-scoped review relevance for new delegation-v2 generations.
 *
 * One lstat-only WorkspaceGuard discovers current metadata.  Content is then
 * streamed exactly once for the closed relevance set W/D/S.  Baseline dirty
 * paths outside that set are B and are deliberately ignored; a new current
 * dirty path outside baseline/W/D/S is U and fails closed unless the guard
 * itself classified it as a workbench artifact.
 */

import { dirname, posix } from "node:path";

import { canonicalHash } from "../cache/canonical-hash.ts";
import { validateChangeSet, type ChangeSetRecord } from "./change-set.ts";
import {
	revalidateDelegationCommandProvenanceReceipts,
	validateDelegationCommandProvenance,
	type DelegationCommandProvenanceRecord,
} from "./delegation-command-effect-provenance.ts";
import type { ExecFn } from "./config.ts";
import {
	DELEGATION_TRANSACTION_HASH_RE,
	DELEGATION_TRANSACTION_ID_RE,
} from "./delegation-transaction.ts";
import {
	captureStreamingIdentities,
	isStrictStreamingIdentityPath,
	streamingIdentityEqual,
	type CaptureStreamingIdentitiesInput,
	type StreamingIdentityMeter,
	type StreamingPathIdentity,
} from "./streaming-identity.ts";
import {
	collectWorkspaceGuard,
	validateWorkspaceGuard,
	type CollectWorkspaceGuardInput,
	type WorkspaceGuardEntry,
	type WorkspaceGuardRecord,
} from "./workspace-guard.ts";

export const REVIEW_RELEVANCE_SCHEMA_VERSION_V2 = 2 as const;
export const REVIEW_RELEVANCE_KIND_V2 = "changeset-relevance-v2" as const;
export const REVIEW_RELEVANCE_MAX_PATHS_V2 = 500 as const;
export const REVIEW_RELEVANCE_MAX_TOTAL_BYTES_V2 = 256 * 1024 * 1024;
export const REVIEW_RELEVANCE_MAX_FILE_BYTES_V2 = 64 * 1024 * 1024;

export type ReviewRelevanceRoleV2 = "W" | "C" | "D" | "S";

export interface ReviewRelevanceEntryV2 {
	path: string;
	roles: readonly ReviewRelevanceRoleV2[];
	status: string;
	full_identity: StreamingPathIdentity;
}

export interface ReviewRelevanceProjectionV2 {
	schema_version: typeof REVIEW_RELEVANCE_SCHEMA_VERSION_V2;
	diff_identity_kind: typeof REVIEW_RELEVANCE_KIND_V2;
	delegation_id: string;
	contract_hash: string;
	change_set_hash: string;
	worker_delta_hash: string;
	/** Present only for current generations with command-effect provenance. */
	command_provenance_hash?: string;
	git_head: string | null;
	entries: readonly ReviewRelevanceEntryV2[];
}

export interface ReviewRelevanceBindingV2 {
	schema_version: typeof REVIEW_RELEVANCE_SCHEMA_VERSION_V2;
	diff_identity_kind: typeof REVIEW_RELEVANCE_KIND_V2;
	projection_hash: string;
}

export interface ReviewRelevanceMeterV2 {
	guard_status_bytes: number;
	guard_stat_calls: number;
	identity_paths_attempted: number;
	identity_paths_completed: number;
	identity_bytes_read: number;
}

export interface ReviewRelevanceLimitsV2 {
	max_paths?: number;
	max_total_bytes?: number;
	max_file_bytes?: number;
}

export type ReviewRelevanceErrorCodeV2 =
	| "invalid_input"
	| "guard_unavailable"
	| "head_conflict"
	| "relevant_conflict"
	| "unknown_origin"
	| "identity_unavailable"
	| "binding_conflict"
	| "limit_exceeded";

export interface ReviewRelevanceErrorV2 {
	code: ReviewRelevanceErrorCodeV2;
	message: string;
	path?: string;
}

export interface CollectReviewRelevanceV2Input {
	project_root: string;
	delegation_id: string;
	contract_hash: string;
	after_guard: Readonly<WorkspaceGuardRecord>;
	change_set: Readonly<ChangeSetRecord>;
	command_provenance?: Readonly<DelegationCommandProvenanceRecord>;
	exec: ExecFn;
	limits?: Readonly<ReviewRelevanceLimitsV2>;
	/** Same-binding segmented/finalized replay authority. */
	expected_projection?: Readonly<ReviewRelevanceProjectionV2>;
	/**
	 * A committed terminal-negative packet may be reviewed after a managed
	 * policy/schema control changed. Worker, command, and dependency paths stay
	 * byte-exact; only S-only controls are rebound into the new Sol packet.
	 */
	allow_control_rebase?: boolean;
}

export interface CollectReviewRelevanceV2Dependencies {
	collect_guard?: (input: CollectWorkspaceGuardInput) => ReturnType<typeof collectWorkspaceGuard>;
	capture_identities?: (input: CaptureStreamingIdentitiesInput) => ReturnType<typeof captureStreamingIdentities>;
}

export interface CollectedReviewRelevanceV2 {
	binding: Readonly<ReviewRelevanceBindingV2>;
	projection: Readonly<ReviewRelevanceProjectionV2>;
	current_guard: Readonly<WorkspaceGuardRecord>;
	worker_paths: readonly string[];
	dependency_paths: readonly string[];
	control_paths: readonly string[];
	baseline_ignored_paths: readonly string[];
	meter: Readonly<ReviewRelevanceMeterV2>;
}

export type CollectReviewRelevanceV2Result =
	| { ok: true; value: Readonly<CollectedReviewRelevanceV2> }
	| { ok: false; error: Readonly<ReviewRelevanceErrorV2>; meter: Readonly<ReviewRelevanceMeterV2> };

const FIXED_CONTROL_PATHS = [
	".pi/settings.json",
	".pi/workbench/project.yaml",
	".pi/workbench/recipes.yaml",
	".pi/workbench/gates.yaml",
	".pi/workbench/profiles.yaml",
] as const;
const ROLE_ORDER: readonly ReviewRelevanceRoleV2[] = ["W", "C", "D", "S"];

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function emptyMeter(): ReviewRelevanceMeterV2 {
	return {
		guard_status_bytes: 0,
		guard_stat_calls: 0,
		identity_paths_attempted: 0,
		identity_paths_completed: 0,
		identity_bytes_read: 0,
	};
}

function resultMeter(meter: ReviewRelevanceMeterV2): Readonly<ReviewRelevanceMeterV2> {
	return Object.freeze({ ...meter });
}

function fail(
	code: ReviewRelevanceErrorCodeV2,
	meter: ReviewRelevanceMeterV2,
	path?: string,
): CollectReviewRelevanceV2Result {
	const messages: Record<ReviewRelevanceErrorCodeV2, string> = {
		invalid_input: "review relevance input is invalid",
		guard_unavailable: "review relevance current workspace guard is unavailable",
		head_conflict: "review relevance Git HEAD changed",
		relevant_conflict: "review relevance path changed after the worker",
		unknown_origin: "review relevance found a new dirty path of unknown origin",
		identity_unavailable: "review relevance full identity capture failed",
		binding_conflict: "review relevance binding changed between review segments",
		limit_exceeded: "review relevance hard bound was exceeded",
	};
	return {
		ok: false,
		error: Object.freeze({ code, message: messages[code], ...(path === undefined ? {} : { path }) }),
		meter: resultMeter(meter),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: object, fields: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...fields].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeLimits(value: Readonly<ReviewRelevanceLimitsV2> | undefined): Required<ReviewRelevanceLimitsV2> | undefined {
	if (value !== undefined && (!isRecord(value) || Object.keys(value).some((key) => ![
		"max_paths", "max_total_bytes", "max_file_bytes",
	].includes(key)))) return undefined;
	const max_paths = value?.max_paths ?? REVIEW_RELEVANCE_MAX_PATHS_V2;
	const max_total_bytes = value?.max_total_bytes ?? REVIEW_RELEVANCE_MAX_TOTAL_BYTES_V2;
	const max_file_bytes = value?.max_file_bytes ?? REVIEW_RELEVANCE_MAX_FILE_BYTES_V2;
	if (![max_paths, max_total_bytes, max_file_bytes].every((item) => Number.isSafeInteger(item) && item > 0)
		|| max_paths > REVIEW_RELEVANCE_MAX_PATHS_V2 || max_total_bytes > REVIEW_RELEVANCE_MAX_TOTAL_BYTES_V2
		|| max_file_bytes > REVIEW_RELEVANCE_MAX_FILE_BYTES_V2 || max_file_bytes > max_total_bytes) return undefined;
	return { max_paths, max_total_bytes, max_file_bytes };
}

/**
 * Compare one persisted guard entry across an ordinary filesystem remount.
 *
 * Linux device numbers are mount-instance metadata: the same unchanged inode
 * can receive a different `st_dev` after reboot/remount.  Keep every other
 * cheap guard field strict, then restore the persisted device number only
 * after the current file has been streamed and its full identity has been
 * tied back to this exact current guard entry.  Content hashes and the
 * immutable projection/envelope remain authoritative.
 */
function sameGuardEntry(left: WorkspaceGuardEntry | undefined, right: WorkspaceGuardEntry | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (left.path !== right.path || left.status !== right.status || left.identity.kind !== right.identity.kind) return false;
	if (left.identity.kind === "missing" || right.identity.kind === "missing") return left.identity.kind === right.identity.kind;
	return left.identity.byte_size === right.identity.byte_size
		&& left.identity.stat.ino === right.identity.stat.ino
		&& left.identity.stat.mtime_ns === right.identity.stat.mtime_ns
		&& left.identity.stat.ctime_ns === right.identity.stat.ctime_ns;
}

function restorePersistedDeviceForStableRemount(
	identity: StreamingPathIdentity,
	baseline: WorkspaceGuardEntry | undefined,
	current: WorkspaceGuardEntry | undefined,
	expected: ReviewRelevanceEntryV2 | undefined,
): StreamingPathIdentity {
	if (identity.kind === "missing") return identity;
	if (expected?.full_identity.kind === "file"
		&& identity.path === expected.full_identity.path
		&& identity.byte_size === expected.full_identity.byte_size
		&& identity.sha256 === expected.full_identity.sha256
		&& identity.stat.ino === expected.full_identity.stat.ino
		&& identity.stat.mtime_ns === expected.full_identity.stat.mtime_ns
		&& identity.stat.ctime_ns === expected.full_identity.stat.ctime_ns) {
		return identity.stat.dev === expected.full_identity.stat.dev ? identity : Object.freeze({
			...identity,
			stat: Object.freeze({ ...identity.stat, dev: expected.full_identity.stat.dev }),
		});
	}
	if (baseline?.identity.kind !== "file" || current?.identity.kind !== "file"
		|| baseline.identity.stat.dev === current.identity.stat.dev) return identity;
	if (identity.byte_size !== current.identity.byte_size
		|| identity.stat.dev !== current.identity.stat.dev
		|| identity.stat.ino !== current.identity.stat.ino
		|| identity.stat.mtime_ns !== current.identity.stat.mtime_ns
		|| identity.stat.ctime_ns !== current.identity.stat.ctime_ns) return identity;
	return Object.freeze({
		...identity,
		stat: Object.freeze({ ...identity.stat, dev: baseline.identity.stat.dev }),
	});
}

/** Closed predicate for versioned managed policy/schema controls. */
export function isManagedReviewControlPathV2(path: string): boolean {
	if (!isStrictStreamingIdentityPath(path)) return false;
	return /^(?:\.pi\/)?(?:workbench\/)?(?:policies|policy|schemas|schema)\/[A-Za-z0-9._/-]+\.(?:json|ya?ml)$/u.test(path)
		|| /^\.pi\/workbench\/(?:policies|schemas)\/[A-Za-z0-9._/-]+$/u.test(path);
}

function applicableAgentPaths(paths: readonly string[]): string[] {
	const out = new Set<string>(["AGENTS.md"]);
	for (const path of paths) {
		let current = dirname(path).replaceAll("\\", "/");
		while (current !== "." && current !== "/" && current.length > 0) {
			out.add(posix.join(current, "AGENTS.md"));
			const next = posix.dirname(current);
			if (next === current) break;
			current = next;
		}
	}
	return [...out].sort(byteCompare);
}

function controlPaths(
	worker: readonly string[],
	dependencies: readonly string[],
	baseline: Readonly<WorkspaceGuardRecord>,
	current: Readonly<WorkspaceGuardRecord>,
): string[] {
	const observed = [...baseline.entries, ...current.entries].map((entry) => entry.path)
		.filter(isManagedReviewControlPathV2);
	return [...new Set([
		...FIXED_CONTROL_PATHS,
		...applicableAgentPaths([...worker, ...dependencies]),
		...observed,
	])].sort(byteCompare);
}

function roleMap(
	worker: readonly string[],
	command: readonly string[],
	dependencies: readonly string[],
	controls: readonly string[],
): Map<string, ReviewRelevanceRoleV2[]> {
	const map = new Map<string, ReviewRelevanceRoleV2[]>();
	for (const [role, paths] of [["W", worker], ["C", command], ["D", dependencies], ["S", controls]] as const) {
		for (const path of paths) {
			const roles = map.get(path) ?? [];
			if (!roles.includes(role)) roles.push(role);
			roles.sort((left, right) => ROLE_ORDER.indexOf(left) - ROLE_ORDER.indexOf(right));
			map.set(path, roles);
		}
	}
	return map;
}

function validIdentity(value: unknown, path: string): value is StreamingPathIdentity {
	if (!isRecord(value) || value.schema_version !== 2 || value.path !== path) return false;
	if (value.kind === "missing") return exactKeys(value, ["schema_version", "kind", "path"]);
	return value.kind === "file" && exactKeys(value, ["schema_version", "kind", "path", "byte_size", "sha256", "stat"])
		&& safeCounter(value.byte_size) && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/u.test(value.sha256)
		&& isRecord(value.stat) && exactKeys(value.stat, ["dev", "ino", "mtime_ns", "ctime_ns"])
		&& Object.values(value.stat).every((item) => typeof item === "string" && /^(0|[1-9]\d*)$/u.test(item));
}

export function computeReviewRelevanceProjectionHashV2(projection: ReviewRelevanceProjectionV2): string {
	return canonicalHash(projection);
}

/** Deterministic stale-state hash for a closed relevance conflict. */
export function computeReviewRelevanceConflictHashV2(input: {
	delegation_id: string;
	contract_hash: string;
	change_set_hash: string;
	error_code: "head_conflict" | "relevant_conflict" | "unknown_origin" | "binding_conflict";
	path?: string;
}): string {
	return canonicalHash({
		schema_version: 2,
		kind: "changeset-relevance-conflict-v2",
		delegation_id: input.delegation_id,
		contract_hash: input.contract_hash,
		change_set_hash: input.change_set_hash,
		error_code: input.error_code,
		path: input.path ?? null,
	});
}

export function validateReviewRelevanceProjectionV2(value: unknown): value is ReviewRelevanceProjectionV2 {
	if (!isRecord(value) || !(exactKeys(value, [
		"schema_version", "diff_identity_kind", "delegation_id", "contract_hash", "change_set_hash",
		"worker_delta_hash", "git_head", "entries",
	]) || exactKeys(value, [
		"schema_version", "diff_identity_kind", "delegation_id", "contract_hash", "change_set_hash",
		"worker_delta_hash", "command_provenance_hash", "git_head", "entries",
	])) || value.schema_version !== REVIEW_RELEVANCE_SCHEMA_VERSION_V2
		|| value.diff_identity_kind !== REVIEW_RELEVANCE_KIND_V2
		|| typeof value.delegation_id !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(value.delegation_id)
		|| typeof value.contract_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(value.contract_hash)
		|| typeof value.change_set_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(value.change_set_hash)
		|| typeof value.worker_delta_hash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(value.worker_delta_hash)
		|| !(value.command_provenance_hash === undefined || (typeof value.command_provenance_hash === "string"
			&& DELEGATION_TRANSACTION_HASH_RE.test(value.command_provenance_hash)))
		|| (value.git_head !== null && (typeof value.git_head !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(value.git_head)))
		|| !Array.isArray(value.entries) || value.entries.length > REVIEW_RELEVANCE_MAX_PATHS_V2) return false;
	let prior: string | undefined;
	for (const entry of value.entries) {
		if (!isRecord(entry) || !exactKeys(entry, ["path", "roles", "status", "full_identity"])
			|| !isStrictStreamingIdentityPath(entry.path) || (prior !== undefined && byteCompare(prior, entry.path) >= 0)
			|| !Array.isArray(entry.roles) || entry.roles.length === 0 || entry.roles.length > ROLE_ORDER.length
			|| !(entry.roles as unknown[]).every((role, index, all) => ROLE_ORDER.includes(role as ReviewRelevanceRoleV2)
				&& (index === 0 || ROLE_ORDER.indexOf(all[index - 1] as ReviewRelevanceRoleV2) < ROLE_ORDER.indexOf(role as ReviewRelevanceRoleV2)))
			|| typeof entry.status !== "string" || entry.status.length === 0 || entry.status.length > 8
			|| !validIdentity(entry.full_identity, entry.path)) return false;
		prior = entry.path;
	}
	const hasCommandRole = value.entries.some((entry) => entry.roles.includes("C"));
	return hasCommandRole ? value.command_provenance_hash !== undefined : true;
}

export function validateReviewRelevanceBindingV2(value: unknown): value is ReviewRelevanceBindingV2 {
	return isRecord(value) && exactKeys(value, ["schema_version", "diff_identity_kind", "projection_hash"])
		&& value.schema_version === REVIEW_RELEVANCE_SCHEMA_VERSION_V2
		&& value.diff_identity_kind === REVIEW_RELEVANCE_KIND_V2
		&& typeof value.projection_hash === "string" && DELEGATION_TRANSACTION_HASH_RE.test(value.projection_hash);
}

/** Collect one current relevance projection and fail closed on any unsafe drift. */
export async function collectReviewRelevanceV2(
	input: CollectReviewRelevanceV2Input,
	dependencies: CollectReviewRelevanceV2Dependencies = {},
): Promise<CollectReviewRelevanceV2Result> {
	const meter = emptyMeter();
	try {
		const limits = normalizeLimits(input?.limits);
		if (!input || typeof input.project_root !== "string" || typeof input.exec !== "function" || limits === undefined
			|| !DELEGATION_TRANSACTION_ID_RE.test(input.delegation_id) || !DELEGATION_TRANSACTION_HASH_RE.test(input.contract_hash)
			|| !validateWorkspaceGuard(input.after_guard) || !validateChangeSet(input.change_set)
			|| input.change_set.delegation_id !== input.delegation_id || input.change_set.contract_hash !== input.contract_hash
			|| (input.command_provenance !== undefined
				&& !validateDelegationCommandProvenance(input.command_provenance, input.change_set))
			|| (input.expected_projection !== undefined && !validateReviewRelevanceProjectionV2(input.expected_projection))
			|| (input.allow_control_rebase !== undefined && typeof input.allow_control_rebase !== "boolean")) {
			return fail("invalid_input", meter);
		}
		if (input.command_provenance !== undefined
			&& !await revalidateDelegationCommandProvenanceReceipts(
				input.project_root,
				input.command_provenance,
				input.change_set,
				input.after_guard,
			)) {
			return fail("binding_conflict", meter);
		}
		const collectGuard = dependencies.collect_guard ?? collectWorkspaceGuard;
		const currentResult = await collectGuard({ project_root: input.project_root, exec: input.exec });
		if (!currentResult.ok || !validateWorkspaceGuard(currentResult.guard)) return fail("guard_unavailable", meter);
		const current = currentResult.guard;
		meter.guard_status_bytes = current.meter.status_bytes;
		meter.guard_stat_calls = current.meter.stat_calls;
		if (current.git_head !== input.after_guard.git_head) return fail("head_conflict", meter);

		const worker = input.change_set.worker_delta.map((entry) => entry.path);
		const command = input.command_provenance?.command_delta.map((entry) => entry.path) ?? [];
		const effective = [...new Set([...worker, ...command])].sort(byteCompare);
		const dependenciesPaths = [...input.change_set.dependency_paths];
		const controls = controlPaths(effective, dependenciesPaths, input.after_guard, current);
		const roles = roleMap(worker, command, dependenciesPaths, controls);
		const relevancePaths = [...roles.keys()].sort(byteCompare);
		if (relevancePaths.length > limits.max_paths) return fail("limit_exceeded", meter);

		const baselineByPath = new Map(input.after_guard.entries.map((entry) => [entry.path, entry]));
		const currentByPath = new Map(current.entries.map((entry) => [entry.path, entry]));
		for (const path of relevancePaths) {
			if (!sameGuardEntry(baselineByPath.get(path), currentByPath.get(path))) {
				const pathRoles = roles.get(path) ?? [];
				const safeControlRebase = input.allow_control_rebase === true
					&& pathRoles.length === 1 && pathRoles[0] === "S";
				if (!safeControlRebase) return fail("relevant_conflict", meter, path);
			}
		}
		const baselinePaths = new Set(input.after_guard.entries.map((entry) => entry.path));
		const irrelevant = new Set(current.irrelevant_artifact_paths);
		for (const entry of current.entries) {
			if (!baselinePaths.has(entry.path) && !roles.has(entry.path) && !irrelevant.has(entry.path)) {
				return fail("unknown_origin", meter, entry.path);
			}
		}

		const identityMeter: StreamingIdentityMeter = { paths_attempted: 0, paths_completed: 0, bytes_read: 0 };
		const capture = dependencies.capture_identities ?? captureStreamingIdentities;
		const captured = await capture({
			project_root: input.project_root,
			paths: relevancePaths,
			limits: { max_paths: limits.max_paths, max_total_bytes: limits.max_total_bytes, max_file_bytes: limits.max_file_bytes },
			meter: identityMeter,
		});
		meter.identity_paths_attempted = captured.meter.paths_attempted;
		meter.identity_paths_completed = captured.meter.paths_completed;
		meter.identity_bytes_read = captured.meter.bytes_read;
		if (!captured.ok) {
			return fail(captured.error.code.includes("overflow") ? "limit_exceeded" : "identity_unavailable", meter, captured.error.path);
		}
		const expectedByPath = new Map((input.expected_projection?.entries ?? []).map((entry) => [entry.path, entry]));
		const identityByPath = new Map(captured.identities.map((identity) => [
			identity.path,
			restorePersistedDeviceForStableRemount(
				identity,
				baselineByPath.get(identity.path),
				currentByPath.get(identity.path),
				expectedByPath.get(identity.path),
			),
		]));
		for (const workerEntry of input.change_set.worker_delta) {
			const currentIdentity = identityByPath.get(workerEntry.path);
			if (currentIdentity === undefined || currentIdentity.path !== workerEntry.path ||
				!streamingIdentityEqual(currentIdentity, workerEntry.after)) {
				return fail("relevant_conflict", meter, workerEntry.path);
			}
		}
		for (const commandEntry of input.command_provenance?.command_delta ?? []) {
			const currentIdentity = identityByPath.get(commandEntry.path);
			if (currentIdentity === undefined || currentIdentity.path !== commandEntry.path
				|| !streamingIdentityEqual(currentIdentity, commandEntry.after)) {
				return fail("relevant_conflict", meter, commandEntry.path);
			}
		}
		const entries: ReviewRelevanceEntryV2[] = relevancePaths.map((path) => ({
			path,
			roles: Object.freeze([...(roles.get(path) ?? [])]),
			status: currentByPath.get(path)?.status ?? "CLEAN",
			full_identity: identityByPath.get(path)!,
		}));
		const projection: ReviewRelevanceProjectionV2 = Object.freeze({
			schema_version: REVIEW_RELEVANCE_SCHEMA_VERSION_V2,
			diff_identity_kind: REVIEW_RELEVANCE_KIND_V2,
			delegation_id: input.delegation_id,
			contract_hash: input.contract_hash,
			change_set_hash: input.change_set.change_set_hash,
			worker_delta_hash: input.change_set.worker_delta_hash,
			...(input.command_provenance === undefined ? {} : {
				command_provenance_hash: input.command_provenance.command_provenance_hash,
			}),
			git_head: current.git_head,
			entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
		});
		if (!validateReviewRelevanceProjectionV2(projection)) return fail("identity_unavailable", meter);
		if (input.expected_projection !== undefined &&
			computeReviewRelevanceProjectionHashV2(input.expected_projection) !== computeReviewRelevanceProjectionHashV2(projection)) {
			return fail("binding_conflict", meter);
		}
		const projectionHash = computeReviewRelevanceProjectionHashV2(projection);
		const binding: ReviewRelevanceBindingV2 = Object.freeze({
			schema_version: REVIEW_RELEVANCE_SCHEMA_VERSION_V2,
			diff_identity_kind: REVIEW_RELEVANCE_KIND_V2,
			projection_hash: projectionHash,
		});
		const baselineIgnored = input.after_guard.entries.map((entry) => entry.path)
			.filter((path) => !roles.has(path)).sort(byteCompare);
		return {
			ok: true,
			value: Object.freeze({
				binding,
				projection,
				current_guard: current,
				worker_paths: Object.freeze([...effective]),
				dependency_paths: Object.freeze([...dependenciesPaths]),
				control_paths: Object.freeze([...controls]),
				baseline_ignored_paths: Object.freeze(baselineIgnored),
				meter: resultMeter(meter),
			}),
		};
	} catch {
		return fail("invalid_input", meter);
	}
}
