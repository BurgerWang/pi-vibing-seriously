/**
 * ChangeSet v2 asynchronous finalization boundary.
 *
 * The pure change-set module remains the sole authority for validating and
 * computing the record. This adapter performs exactly one bounded streaming
 * capture of the journal-touched paths, then forwards those identities to the
 * pure computation. It performs no git, shell, network, clock, or random I/O.
 */

import {
	computeChangeSet,
	type ChangeSetRecord,
	type ComputeChangeSetResult,
} from "./change-set.ts";
import {
	captureStreamingIdentities,
	STREAMING_IDENTITY_MAX_FILE_BYTES,
	STREAMING_IDENTITY_MAX_PATHS,
	STREAMING_IDENTITY_MAX_TOTAL_BYTES,
	type StreamingIdentityAdapter,
	type StreamingIdentityErrorCode,
	type StreamingIdentityHooks,
	type StreamingIdentityMeter,
} from "./streaming-identity.ts";
import type { WorkerWriteJournalRecord } from "./write-journal.ts";
import type { WorkspaceGuardRecord } from "./workspace-guard.ts";

export interface FinalizeChangeSetV2Input {
	project_root: string;
	delegation_id: string;
	contract_hash: string;
	journal_hash: string;
	journal: WorkerWriteJournalRecord;
	before_guard: WorkspaceGuardRecord;
	after_guard: WorkspaceGuardRecord;
	dependency_paths: readonly string[];
}

export interface FinalizeChangeSetV2Limits {
	max_paths?: number;
	max_file_bytes?: number;
	max_total_bytes?: number;
}

export interface FinalizeChangeSetV2Options {
	limits?: Readonly<FinalizeChangeSetV2Limits>;
	identity_adapter?: StreamingIdentityAdapter;
	identity_hooks?: StreamingIdentityHooks;
}

export type FinalizeChangeSetV2ErrorCode =
	| "invalid_input"
	| "invalid_journal"
	| "invalid_guard"
	| "invalid_dependencies"
	| "identity_failure"
	| "limit_exceeded";

export interface FinalizeChangeSetV2Error {
	code: FinalizeChangeSetV2ErrorCode;
	message: string;
	identity_code?: StreamingIdentityErrorCode;
}

export type FinalizeChangeSetV2Result =
	| { ok: true; value: Readonly<ChangeSetRecord> }
	| { ok: false; error: Readonly<FinalizeChangeSetV2Error> };

const INPUT_FIELDS = [
	"project_root", "delegation_id", "contract_hash", "journal_hash", "journal",
	"before_guard", "after_guard", "dependency_paths",
] as const;
const OPTION_FIELDS = ["limits", "identity_adapter", "identity_hooks"] as const;
const LIMIT_FIELDS = ["max_paths", "max_file_bytes", "max_total_bytes"] as const;

const ERROR_MESSAGES: Readonly<Record<FinalizeChangeSetV2ErrorCode, string>> = Object.freeze({
	invalid_input: "change set finalizer input is invalid",
	invalid_journal: "change set finalizer journal is invalid",
	invalid_guard: "change set finalizer workspace guard is invalid",
	invalid_dependencies: "change set finalizer dependency paths are invalid",
	identity_failure: "change set finalizer identity capture failed",
	limit_exceeded: "change set finalizer hard or configured limit was exceeded",
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactFields(value: object, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length && actual.every((field, index) => field === wanted[index]);
}

function boundedPositive(value: unknown, hardMaximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= hardMaximum;
}

function isIdentityAdapter(value: unknown): value is StreamingIdentityAdapter {
	return isPlainObject(value)
		&& typeof value.lstat === "function"
		&& typeof value.realpath === "function"
		&& typeof value.openNoFollow === "function";
}

function isIdentityHooks(value: unknown): value is StreamingIdentityHooks {
	return isPlainObject(value) && Object.keys(value).every((key) => key === "fault")
		&& (value.fault === undefined || typeof value.fault === "function");
}

function fail(
	code: FinalizeChangeSetV2ErrorCode,
	identityCode?: StreamingIdentityErrorCode,
): FinalizeChangeSetV2Result {
	return {
		ok: false,
		error: Object.freeze({
			code,
			message: ERROR_MESSAGES[code],
			...(identityCode === undefined ? {} : { identity_code: identityCode }),
		}),
	};
}

function normalizeLimits(value: unknown): Required<FinalizeChangeSetV2Limits> | undefined {
	if (value !== undefined && (!isPlainObject(value) || !exactFields(value, Object.keys(value).filter((key) => LIMIT_FIELDS.includes(key as typeof LIMIT_FIELDS[number]))))) {
		return undefined;
	}
	const limits = value as Readonly<FinalizeChangeSetV2Limits> | undefined;
	const normalized = {
		max_paths: limits?.max_paths ?? STREAMING_IDENTITY_MAX_PATHS,
		max_file_bytes: limits?.max_file_bytes ?? STREAMING_IDENTITY_MAX_FILE_BYTES,
		max_total_bytes: limits?.max_total_bytes ?? STREAMING_IDENTITY_MAX_TOTAL_BYTES,
	};
	return boundedPositive(normalized.max_paths, STREAMING_IDENTITY_MAX_PATHS)
		&& boundedPositive(normalized.max_file_bytes, STREAMING_IDENTITY_MAX_FILE_BYTES)
		&& boundedPositive(normalized.max_total_bytes, STREAMING_IDENTITY_MAX_TOTAL_BYTES)
		? normalized
		: undefined;
}

function normalizeOptions(options: FinalizeChangeSetV2Options | undefined):
	| { limits: Required<FinalizeChangeSetV2Limits>; adapter?: StreamingIdentityAdapter; hooks?: StreamingIdentityHooks }
	| undefined {
	if (options !== undefined && (!isPlainObject(options) || !exactFields(options, Object.keys(options).filter((key) => OPTION_FIELDS.includes(key as typeof OPTION_FIELDS[number]))))) {
		return undefined;
	}
	const limits = normalizeLimits(options?.limits);
	if (limits === undefined) return undefined;
	if (options?.identity_adapter !== undefined && !isIdentityAdapter(options.identity_adapter)) return undefined;
	if (options?.identity_hooks !== undefined && !isIdentityHooks(options.identity_hooks)) return undefined;
	return {
		limits,
		...(options?.identity_adapter === undefined ? {} : { adapter: options.identity_adapter }),
		...(options?.identity_hooks === undefined ? {} : { hooks: options.identity_hooks }),
	};
}

function mapPureFailure(result: Exclude<ComputeChangeSetResult, { ok: true }>): FinalizeChangeSetV2Result {
	switch (result.error.code) {
		case "invalid_journal": return fail("invalid_journal");
		case "invalid_guard": return fail("invalid_guard");
		case "invalid_dependencies": return fail("invalid_dependencies");
		case "limit_exceeded": return fail("limit_exceeded");
		default: return fail("invalid_input");
	}
}

function pureInput(
	input: FinalizeChangeSetV2Input,
	finalIdentities: Parameters<typeof computeChangeSet>[0]["final_identities"],
	meter: Readonly<StreamingIdentityMeter>,
): Parameters<typeof computeChangeSet>[0] {
	return {
		delegation_id: input.delegation_id,
		contract_hash: input.contract_hash,
		journal_hash: input.journal_hash,
		journal: input.journal,
		before_guard: input.before_guard,
		after_guard: input.after_guard,
		dependency_paths: input.dependency_paths,
		final_identities: finalIdentities,
		finalization_meter: meter,
	};
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

/**
 * Validate immutable authority inputs, capture only final journal-touched
 * identities, and return the pure ChangeSet record unchanged.
 */
export async function finalizeChangeSetV2(
	input: FinalizeChangeSetV2Input,
	options?: FinalizeChangeSetV2Options,
): Promise<FinalizeChangeSetV2Result> {
	if (!isPlainObject(input) || !exactFields(input, INPUT_FIELDS)
		|| typeof input.project_root !== "string" || input.project_root.length === 0) return fail("invalid_input");
	const normalized = normalizeOptions(options);
	if (normalized === undefined) return fail("invalid_input");

	const zeroMeter: StreamingIdentityMeter = { paths_attempted: 0, paths_completed: 0, bytes_read: 0 };
	const preflight = computeChangeSet(pureInput(input, [], zeroMeter));
	if (preflight.ok) return preflight;
	if (preflight.error.code !== "invalid_finals" && preflight.error.code !== "invalid_meter") {
		return mapPureFailure(preflight);
	}

	// Reaching invalid_finals/invalid_meter proves that the pure authority has
	// already accepted the exact journal, guards, identities, and dependency
	// path schema. Derive the capture set solely from that sealed journal.
	const touchedPaths = [...new Set(input.journal.operations.map((operation) => operation.path))].sort(byteCompare);
	if (touchedPaths.length > normalized.limits.max_paths) return fail("limit_exceeded");

	const meter: StreamingIdentityMeter = { paths_attempted: 0, paths_completed: 0, bytes_read: 0 };
	const captured = await captureStreamingIdentities({
		project_root: input.project_root,
		paths: touchedPaths,
		limits: normalized.limits,
		meter,
		...(normalized.adapter === undefined ? {} : { adapter: normalized.adapter }),
		...(normalized.hooks === undefined ? {} : { hooks: normalized.hooks }),
	});
	if (!captured.ok) {
		const overflow = captured.error.code === "path_count_overflow"
			|| captured.error.code === "file_bytes_overflow"
			|| captured.error.code === "total_bytes_overflow";
		return fail(overflow ? "limit_exceeded" : "identity_failure", captured.error.code);
	}

	const computed = computeChangeSet(pureInput(input, captured.identities, captured.meter));
	return computed.ok ? computed : mapPureFailure(computed);
}
