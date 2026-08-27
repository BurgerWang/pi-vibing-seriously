/**
 * Durable command-effect provenance for declared recipe subprocesses.
 *
 * A recipe declaration is write authority, not proof that a subprocess
 * caused an observed workspace change.  This module binds one run id to two
 * stable workspace guards plus before/after streaming content identities for
 * every exact declared output, including Git-ignored files.  Only those exact
 * outputs can be command-attributed; broad declarations remain unknown and
 * every other Git-visible path remains out of scope.  None of these facts
 * grant semantic acceptance.
 */

import { createHash } from "node:crypto";

import type { ExecFn } from "./config.ts";
import type { RecipeMutation } from "./recipe-schema.ts";
import {
	captureStreamingIdentities,
	isStrictStreamingIdentityPath,
	STREAMING_IDENTITY_MAX_FILE_BYTES,
	STREAMING_IDENTITY_MAX_PATHS,
	STREAMING_IDENTITY_MAX_TOTAL_BYTES,
	STREAMING_IDENTITY_SCHEMA_VERSION,
	type CaptureStreamingIdentitiesInput,
	type CaptureStreamingIdentitiesResult,
	type StreamingIdentityError,
	type StreamingIdentityErrorCode,
	type StreamingIdentityMeter,
	type StreamingPathIdentity,
} from "./streaming-identity.ts";
import {
	collectWorkspaceGuard,
	isStrictWorkspaceGuardPath,
	validateWorkspaceGuard,
	type CollectWorkspaceGuardInput,
	type CollectWorkspaceGuardResult,
	type WorkspaceGuardEntry,
	type WorkspaceGuardRecord,
} from "./workspace-guard.ts";

export const COMMAND_EFFECT_SCHEMA_VERSION = 1 as const;
export const COMMAND_EFFECT_FILE = "command-effect.json" as const;
export const COMMAND_EFFECT_SEMANTIC_ACCEPTANCE = "NOT_GRANTED" as const;
export const COMMAND_EFFECT_MAX_DECLARATIONS = 10_000 as const;
export const COMMAND_EFFECT_MAX_PATHS = 500 as const;
export const COMMAND_EFFECT_MAX_BYTES = 4 * 1024 * 1024;
export const COMMAND_EFFECT_MAX_EXACT_OUTPUT_PATHS = STREAMING_IDENTITY_MAX_PATHS;
export const COMMAND_EFFECT_MAX_EXACT_OUTPUT_FILE_BYTES = STREAMING_IDENTITY_MAX_FILE_BYTES;
export const COMMAND_EFFECT_MAX_EXACT_OUTPUT_TOTAL_BYTES = STREAMING_IDENTITY_MAX_TOTAL_BYTES;

export type CommandEffectClassification =
	| "COMMAND_ATTRIBUTED"
	| "RECIPE_DECLARATION_VIOLATION"
	| "UNKNOWN_ORIGIN"
	| "OUT_OF_SCOPE";

export type CommandEffectStatus =
	| "CLEAN"
	| "COMMAND_ATTRIBUTED"
	| "RECIPE_DECLARATION_VIOLATION"
	| "UNKNOWN_ORIGIN"
	| "OUT_OF_SCOPE"
	| "EVIDENCE_UNAVAILABLE";

export type CommandEffectCaptureError =
	| "BEFORE_GUARD_UNAVAILABLE"
	| "AFTER_GUARD_UNAVAILABLE"
	| "BEFORE_EXACT_OUTPUT_UNAVAILABLE"
	| "AFTER_EXACT_OUTPUT_UNAVAILABLE"
	| "GIT_HEAD_CHANGED";

export type CommandEffectTerminalReason =
	| "RECIPE_DECLARATION_VIOLATION"
	| "COMMAND_EFFECT_UNKNOWN_ORIGIN"
	| "COMMAND_EFFECT_OUT_OF_SCOPE"
	| "COMMAND_EFFECT_EVIDENCE_UNAVAILABLE";

export interface CommandEffectObservedChange {
	path: string;
	classification: CommandEffectClassification;
	before: WorkspaceGuardEntry | null;
	after: WorkspaceGuardEntry | null;
	before_exact_output: StreamingPathIdentity | null;
	after_exact_output: StreamingPathIdentity | null;
}

/**
 * Stable content evidence for every exact write declaration.  A failed
 * capture deliberately retains no partial identities, but keeps a bounded
 * meter and closed error so the run fails with EVIDENCE_UNAVAILABLE.
 */
export interface CommandEffectExactOutputEvidence {
	identities: readonly StreamingPathIdentity[];
	error: Readonly<StreamingIdentityError> | null;
	meter: Readonly<StreamingIdentityMeter>;
}

export interface CommandEffectRecord {
	schema_version: typeof COMMAND_EFFECT_SCHEMA_VERSION;
	kind: "recipe";
	run_id: string;
	recipe: string;
	actor: "workbench" | "worker";
	worker_delegation_id: string | null;
	worker_contract_hash: string | null;
	mutation_declaration: RecipeMutation;
	declared_writes: readonly string[];
	exact_declared_output_paths: readonly string[];
	before_guard: Readonly<WorkspaceGuardRecord> | null;
	after_guard: Readonly<WorkspaceGuardRecord> | null;
	before_exact_output_evidence: Readonly<CommandEffectExactOutputEvidence>;
	after_exact_output_evidence: Readonly<CommandEffectExactOutputEvidence>;
	capture_error: CommandEffectCaptureError | null;
	observed_changes: readonly CommandEffectObservedChange[];
	status: CommandEffectStatus;
	semantic_acceptance: typeof COMMAND_EFFECT_SEMANTIC_ACCEPTANCE;
	command_effect_hash: string;
}

export interface BeginRecipeCommandEffectCaptureInput {
	project_root: string;
	exec: ExecFn;
	declared_writes: readonly string[];
}

export interface RecipeCommandEffectCaptureStart {
	before_guard: Readonly<WorkspaceGuardRecord> | null;
	exact_declared_output_paths: readonly string[];
	before_exact_output_evidence: Readonly<CommandEffectExactOutputEvidence>;
}

export interface BuildRecipeCommandEffectRecordInput {
	run_id: string;
	recipe: string;
	actor: "workbench" | "worker";
	worker_delegation_id?: string | null;
	worker_contract_hash?: string | null;
	mutation_declaration: RecipeMutation;
	declared_writes: readonly string[];
	before_guard: Readonly<WorkspaceGuardRecord> | null;
	after_guard: Readonly<WorkspaceGuardRecord> | null;
	before_exact_output_evidence: Readonly<CommandEffectExactOutputEvidence>;
	after_exact_output_evidence: Readonly<CommandEffectExactOutputEvidence>;
}

export interface CompleteRecipeCommandEffectCaptureInput
	extends Omit<
		BuildRecipeCommandEffectRecordInput,
		"before_guard" | "after_guard" | "before_exact_output_evidence" | "after_exact_output_evidence"
	> {
	project_root: string;
	exec: ExecFn;
	started: Readonly<RecipeCommandEffectCaptureStart>;
}

type CollectGuard = (input: CollectWorkspaceGuardInput) => Promise<CollectWorkspaceGuardResult>;
type CaptureIdentities = (input: CaptureStreamingIdentitiesInput) => Promise<CaptureStreamingIdentitiesResult>;

export interface RecipeCommandEffectCaptureDependencies {
	collect_guard?: CollectGuard;
	capture_identities?: CaptureIdentities;
}

const RUN_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/u;
const DELEGATION_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/u;
const HASH_RE = /^[0-9a-f]{64}$/u;
const GLOB_META_RE = /[*?\[\]{}]/u;
const NON_NEGATIVE_DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/u;
const STREAMING_IDENTITY_ERROR_CODES = new Set<StreamingIdentityErrorCode>([
	"invalid_input", "invalid_path", "duplicate_path", "path_count_overflow",
	"file_bytes_overflow", "total_bytes_overflow", "path_symlink", "path_not_regular",
	"path_escape", "stat_failed", "open_failed", "read_failed", "close_failed",
	"path_after_failed", "unstable",
]);

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function canonicalStrings(values: readonly string[]): string[] {
	return [...new Set(values)].sort(byteCompare);
}

function exactOutputPaths(declarations: readonly string[]): string[] {
	return canonicalStrings(declarations).filter(exactDeclaration);
}

function cloneIdentity(identity: StreamingPathIdentity): StreamingPathIdentity {
	return structuredClone(identity);
}

function identityEqual(left: StreamingPathIdentity | undefined, right: StreamingPathIdentity | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return JSON.stringify(left) === JSON.stringify(right);
}

function safeCounter(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateStreamingIdentity(value: unknown): value is StreamingPathIdentity {
	if (!plainRecord(value) || value.schema_version !== STREAMING_IDENTITY_SCHEMA_VERSION
		|| !isStrictStreamingIdentityPath(value.path)) return false;
	if (value.kind === "missing") return exactKeys(value, ["schema_version", "kind", "path"]);
	return value.kind === "file"
		&& exactKeys(value, ["schema_version", "kind", "path", "byte_size", "sha256", "stat"])
		&& safeCounter(value.byte_size, COMMAND_EFFECT_MAX_EXACT_OUTPUT_FILE_BYTES)
		&& typeof value.sha256 === "string" && HASH_RE.test(value.sha256)
		&& plainRecord(value.stat)
		&& exactKeys(value.stat, ["dev", "ino", "mtime_ns", "ctime_ns"])
		&& [value.stat.dev, value.stat.ino, value.stat.mtime_ns, value.stat.ctime_ns]
			.every((entry) => typeof entry === "string" && NON_NEGATIVE_DECIMAL_RE.test(entry));
}

function validateStreamingError(value: unknown, exact: ReadonlySet<string>): value is StreamingIdentityError {
	if (!plainRecord(value) || !exactKeys(value, value.path === undefined
		? ["code", "message"]
		: ["code", "message", "path"])
		|| typeof value.code !== "string" || !STREAMING_IDENTITY_ERROR_CODES.has(value.code as StreamingIdentityErrorCode)
		|| typeof value.message !== "string" || value.message.length === 0 || Buffer.byteLength(value.message, "utf8") > 256) return false;
	return value.path === undefined || (typeof value.path === "string" && exact.has(value.path));
}

function validateExactOutputEvidence(
	value: unknown,
	exactOutputs: readonly string[],
): value is CommandEffectExactOutputEvidence {
	if (!plainRecord(value) || !exactKeys(value, ["identities", "error", "meter"])
		|| !Array.isArray(value.identities) || value.identities.length > COMMAND_EFFECT_MAX_EXACT_OUTPUT_PATHS
		|| !value.identities.every(validateStreamingIdentity)
		|| !plainRecord(value.meter) || !exactKeys(value.meter, ["paths_attempted", "paths_completed", "bytes_read"])
		|| !safeCounter(value.meter.paths_attempted, COMMAND_EFFECT_MAX_EXACT_OUTPUT_PATHS)
		|| !safeCounter(value.meter.paths_completed, COMMAND_EFFECT_MAX_EXACT_OUTPUT_PATHS)
		|| value.meter.paths_attempted > exactOutputs.length
		|| value.meter.paths_completed > value.meter.paths_attempted
		|| !safeCounter(value.meter.bytes_read, COMMAND_EFFECT_MAX_EXACT_OUTPUT_TOTAL_BYTES)) return false;
	const exactSet = new Set(exactOutputs);
	if (value.error === null) {
		if (value.identities.length !== exactOutputs.length
			|| value.meter.paths_attempted !== exactOutputs.length
			|| value.meter.paths_completed !== exactOutputs.length
			|| value.identities.some((entry, index) => entry.path !== exactOutputs[index])) return false;
		const expectedBytes = value.identities.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.byte_size : 0), 0);
		return value.meter.bytes_read === expectedBytes;
	}
	return value.identities.length === 0 && validateStreamingError(value.error, exactSet);
}

function cloneExactOutputEvidence(
	evidence: Readonly<CommandEffectExactOutputEvidence>,
): CommandEffectExactOutputEvidence {
	return {
		identities: evidence.identities.map(cloneIdentity),
		error: evidence.error === null ? null : structuredClone(evidence.error),
		meter: { ...evidence.meter },
	};
}

function cloneGuardEntry(entry: WorkspaceGuardEntry): WorkspaceGuardEntry {
	return structuredClone(entry);
}

function guardEntryEqual(left: WorkspaceGuardEntry | undefined, right: WorkspaceGuardEntry | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return JSON.stringify(left) === JSON.stringify(right);
}

function exactDeclaration(path: string): boolean {
	return isStrictWorkspaceGuardPath(path) && !GLOB_META_RE.test(path);
}

function broadDeclarationMayCover(path: string, declaration: string): boolean {
	if (declaration.endsWith("/**")) {
		const base = declaration.slice(0, -3);
		return isStrictWorkspaceGuardPath(base) && (path === base || path.startsWith(`${base}/`));
	}
	if (declaration.endsWith("/")) {
		const base = declaration.slice(0, -1);
		return isStrictWorkspaceGuardPath(base) && (path === base || path.startsWith(`${base}/`));
	}
	// The recipe schema currently accepts arbitrary contained glob text.  Do
	// not implement a second glob dialect here or pretend an opaque pattern is
	// exact provenance.  It remains unknown and therefore fail-closed.
	return GLOB_META_RE.test(declaration);
}

function classifyPath(
	path: string,
	mutation: RecipeMutation,
	exact: ReadonlySet<string>,
	declarations: readonly string[],
): CommandEffectClassification {
	if (mutation === "none") return "RECIPE_DECLARATION_VIOLATION";
	if (exact.has(path)) return "COMMAND_ATTRIBUTED";
	if (declarations.some((declaration) => broadDeclarationMayCover(path, declaration))) return "UNKNOWN_ORIGIN";
	return "OUT_OF_SCOPE";
}

function statusFor(
	changes: readonly CommandEffectObservedChange[],
	captureError: CommandEffectCaptureError | null,
	hasInexactDeclaration: boolean,
): CommandEffectStatus {
	if (captureError !== null) return "EVIDENCE_UNAVAILABLE";
	if (changes.some((entry) => entry.classification === "RECIPE_DECLARATION_VIOLATION")) return "RECIPE_DECLARATION_VIOLATION";
	if (changes.some((entry) => entry.classification === "OUT_OF_SCOPE")) return "OUT_OF_SCOPE";
	if (hasInexactDeclaration || changes.some((entry) => entry.classification === "UNKNOWN_ORIGIN")) return "UNKNOWN_ORIGIN";
	if (changes.length > 0) return "COMMAND_ATTRIBUTED";
	return "CLEAN";
}

function projection(record: Omit<CommandEffectRecord, "command_effect_hash"> | CommandEffectRecord): unknown {
	return {
		schema_version: COMMAND_EFFECT_SCHEMA_VERSION,
		kind: "recipe",
		run_id: record.run_id,
		recipe: record.recipe,
		actor: record.actor,
		worker_delegation_id: record.worker_delegation_id,
		worker_contract_hash: record.worker_contract_hash,
		mutation_declaration: record.mutation_declaration,
		declared_writes: [...record.declared_writes],
		exact_declared_output_paths: [...record.exact_declared_output_paths],
		before_guard: record.before_guard,
		after_guard: record.after_guard,
		before_exact_output_evidence: record.before_exact_output_evidence,
		after_exact_output_evidence: record.after_exact_output_evidence,
		capture_error: record.capture_error,
		observed_changes: record.observed_changes.map((entry) => ({
			path: entry.path,
			classification: entry.classification,
			before: entry.before,
			after: entry.after,
			before_exact_output: entry.before_exact_output,
			after_exact_output: entry.after_exact_output,
		})),
		status: record.status,
		semantic_acceptance: COMMAND_EFFECT_SEMANTIC_ACCEPTANCE,
	};
}

export function computeCommandEffectHash(record: Omit<CommandEffectRecord, "command_effect_hash"> | CommandEffectRecord): string {
	return createHash("sha256").update(JSON.stringify(projection(record))).digest("hex");
}

function deepFreeze<T>(value: T): Readonly<T> {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Build one deterministic record from already-stable before/after guards. */
export function buildRecipeCommandEffectRecord(input: BuildRecipeCommandEffectRecordInput): Readonly<CommandEffectRecord> {
	const workerDelegationId = input.worker_delegation_id ?? null;
	const workerContractHash = input.worker_contract_hash ?? null;
	if (input.actor === "worker") {
		if (!DELEGATION_ID_RE.test(workerDelegationId ?? "") || !HASH_RE.test(workerContractHash ?? "")) {
			throw new Error("worker command-effect identity is invalid");
		}
	} else if (workerDelegationId !== null || workerContractHash !== null) {
		throw new Error("workbench command-effect identity must be null");
	}
	const declarations = canonicalStrings(input.declared_writes);
	const exactOutputs = exactOutputPaths(declarations);
	const exactSet = new Set(exactOutputs);
	if (!validateExactOutputEvidence(input.before_exact_output_evidence, exactOutputs)
		|| !validateExactOutputEvidence(input.after_exact_output_evidence, exactOutputs)) {
		throw new Error("invalid exact declared-output evidence");
	}
	let captureError: CommandEffectCaptureError | null = input.before_guard === null
		? "BEFORE_GUARD_UNAVAILABLE"
		: input.after_guard === null
			? "AFTER_GUARD_UNAVAILABLE"
			: input.before_exact_output_evidence.error !== null
				? "BEFORE_EXACT_OUTPUT_UNAVAILABLE"
				: input.after_exact_output_evidence.error !== null
					? "AFTER_EXACT_OUTPUT_UNAVAILABLE"
					: input.before_guard.git_head !== input.after_guard.git_head
						? "GIT_HEAD_CHANGED"
						: null;
	if (input.before_guard !== null && !validateWorkspaceGuard(input.before_guard)) captureError = "BEFORE_GUARD_UNAVAILABLE";
	if (input.after_guard !== null && !validateWorkspaceGuard(input.after_guard)) captureError = "AFTER_GUARD_UNAVAILABLE";

	const changes: CommandEffectObservedChange[] = [];
	if (captureError === null && input.before_guard !== null && input.after_guard !== null) {
		const before = new Map(input.before_guard.entries.map((entry) => [entry.path, entry] as const));
		const after = new Map(input.after_guard.entries.map((entry) => [entry.path, entry] as const));
		const beforeExact = new Map(input.before_exact_output_evidence.identities.map((entry) => [entry.path, entry] as const));
		const afterExact = new Map(input.after_exact_output_evidence.identities.map((entry) => [entry.path, entry] as const));
		for (const path of canonicalStrings([...before.keys(), ...after.keys(), ...beforeExact.keys(), ...afterExact.keys()])) {
			const beforeEntry = before.get(path);
			const afterEntry = after.get(path);
			const beforeExactEntry = beforeExact.get(path);
			const afterExactEntry = afterExact.get(path);
			if (guardEntryEqual(beforeEntry, afterEntry) && identityEqual(beforeExactEntry, afterExactEntry)) continue;
			changes.push({
				path,
				classification: classifyPath(path, input.mutation_declaration, exactSet, declarations),
				before: beforeEntry === undefined ? null : cloneGuardEntry(beforeEntry),
				after: afterEntry === undefined ? null : cloneGuardEntry(afterEntry),
				before_exact_output: beforeExactEntry === undefined ? null : cloneIdentity(beforeExactEntry),
				after_exact_output: afterExactEntry === undefined ? null : cloneIdentity(afterExactEntry),
			});
		}
	}

	const withoutHash: Omit<CommandEffectRecord, "command_effect_hash"> = {
		schema_version: COMMAND_EFFECT_SCHEMA_VERSION,
		kind: "recipe",
		run_id: input.run_id,
		recipe: input.recipe,
		actor: input.actor,
		worker_delegation_id: workerDelegationId,
		worker_contract_hash: workerContractHash,
		mutation_declaration: input.mutation_declaration,
		declared_writes: declarations,
		exact_declared_output_paths: exactOutputs,
		before_guard: input.before_guard === null ? null : structuredClone(input.before_guard),
		after_guard: input.after_guard === null ? null : structuredClone(input.after_guard),
		before_exact_output_evidence: cloneExactOutputEvidence(input.before_exact_output_evidence),
		after_exact_output_evidence: cloneExactOutputEvidence(input.after_exact_output_evidence),
		capture_error: captureError,
		observed_changes: changes,
		status: statusFor(changes, captureError, exactOutputs.length !== declarations.length),
		semantic_acceptance: COMMAND_EFFECT_SEMANTIC_ACCEPTANCE,
	};
	return deepFreeze({ ...withoutHash, command_effect_hash: computeCommandEffectHash(withoutHash) });
}

function plainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict closed-schema validator; recomputation checks every classification. */
export function validateCommandEffectRecord(value: unknown): value is CommandEffectRecord {
	if (!plainRecord(value) || Object.keys(value).sort().join(",") !== [
		"actor", "after_exact_output_evidence", "after_guard", "before_exact_output_evidence", "before_guard",
		"capture_error", "command_effect_hash", "declared_writes",
		"exact_declared_output_paths", "kind", "mutation_declaration", "observed_changes", "recipe",
		"run_id", "schema_version", "semantic_acceptance", "status", "worker_contract_hash", "worker_delegation_id",
	].sort().join(",") || value.schema_version !== COMMAND_EFFECT_SCHEMA_VERSION || value.kind !== "recipe"
		|| typeof value.run_id !== "string" || !RUN_ID_RE.test(value.run_id)
		|| typeof value.recipe !== "string" || value.recipe.length === 0 || Buffer.byteLength(value.recipe, "utf8") > 256
		|| (value.actor !== "workbench" && value.actor !== "worker")
		|| (value.mutation_declaration !== "none" && value.mutation_declaration !== "artifacts" && value.mutation_declaration !== "source")
		|| !Array.isArray(value.declared_writes) || value.declared_writes.length > COMMAND_EFFECT_MAX_DECLARATIONS
		|| !value.declared_writes.every((entry) => typeof entry === "string" && entry.length > 0 && Buffer.byteLength(entry, "utf8") <= 4_096)
		|| !Array.isArray(value.exact_declared_output_paths) || value.exact_declared_output_paths.length > COMMAND_EFFECT_MAX_DECLARATIONS
		|| !Array.isArray(value.observed_changes) || value.observed_changes.length > COMMAND_EFFECT_MAX_PATHS
		|| value.semantic_acceptance !== COMMAND_EFFECT_SEMANTIC_ACCEPTANCE
		|| typeof value.command_effect_hash !== "string" || !HASH_RE.test(value.command_effect_hash)) return false;
	const delegationId = value.worker_delegation_id;
	const contractHash = value.worker_contract_hash;
	if (value.actor === "worker") {
		if (typeof delegationId !== "string" || !DELEGATION_ID_RE.test(delegationId)
			|| typeof contractHash !== "string" || !HASH_RE.test(contractHash)) return false;
	} else if (delegationId !== null || contractHash !== null) return false;
	if (!(value.before_guard === null || validateWorkspaceGuard(value.before_guard))
		|| !(value.after_guard === null || validateWorkspaceGuard(value.after_guard))) return false;
	const declarations = canonicalStrings(value.declared_writes as string[]);
	const exactOutputs = exactOutputPaths(declarations);
	if (!validateExactOutputEvidence(value.before_exact_output_evidence, exactOutputs)
		|| !validateExactOutputEvidence(value.after_exact_output_evidence, exactOutputs)) return false;
	try {
		const expected = buildRecipeCommandEffectRecord({
			run_id: value.run_id,
			recipe: value.recipe,
			actor: value.actor,
			worker_delegation_id: delegationId as string | null,
			worker_contract_hash: contractHash as string | null,
			mutation_declaration: value.mutation_declaration,
			declared_writes: value.declared_writes as string[],
			before_guard: value.before_guard as WorkspaceGuardRecord | null,
			after_guard: value.after_guard as WorkspaceGuardRecord | null,
			before_exact_output_evidence: value.before_exact_output_evidence,
			after_exact_output_evidence: value.after_exact_output_evidence,
		});
		return JSON.stringify(expected) === JSON.stringify(value);
	} catch {
		return false;
	}
}

async function safeCollect(
	input: BeginRecipeCommandEffectCaptureInput,
	collect: CollectGuard,
): Promise<Readonly<WorkspaceGuardRecord> | null> {
	try {
		const result = await collect({ project_root: input.project_root, exec: input.exec });
		return result.ok && validateWorkspaceGuard(result.guard) ? result.guard : null;
	} catch {
		return null;
	}
}

function unavailableExactOutputEvidence(
	code: StreamingIdentityErrorCode,
	message: string,
): Readonly<CommandEffectExactOutputEvidence> {
	return deepFreeze({
		identities: [],
		error: { code, message },
		meter: { paths_attempted: 0, paths_completed: 0, bytes_read: 0 },
	});
}

async function safeCaptureExactOutputs(
	projectRoot: string,
	paths: readonly string[],
	capture: CaptureIdentities,
): Promise<Readonly<CommandEffectExactOutputEvidence>> {
	try {
		const result = await capture({
			project_root: projectRoot,
			paths,
			limits: {
				max_paths: COMMAND_EFFECT_MAX_EXACT_OUTPUT_PATHS,
				max_file_bytes: COMMAND_EFFECT_MAX_EXACT_OUTPUT_FILE_BYTES,
				max_total_bytes: COMMAND_EFFECT_MAX_EXACT_OUTPUT_TOTAL_BYTES,
			},
		});
		return deepFreeze(result.ok
			? { identities: result.identities.map(cloneIdentity), error: null, meter: { ...result.meter } }
			: { identities: [], error: structuredClone(result.error), meter: { ...result.meter } });
	} catch {
		return unavailableExactOutputEvidence("read_failed", "streaming identity capture threw unexpectedly");
	}
}

/** Capture the stable guard immediately before the subprocess. */
export async function beginRecipeCommandEffectCapture(
	input: BeginRecipeCommandEffectCaptureInput,
	dependencies: RecipeCommandEffectCaptureDependencies = {},
): Promise<Readonly<RecipeCommandEffectCaptureStart>> {
	const exactOutputs = exactOutputPaths(input.declared_writes);
	const [beforeGuard, beforeExactOutputEvidence] = await Promise.all([
		safeCollect(input, dependencies.collect_guard ?? collectWorkspaceGuard),
		safeCaptureExactOutputs(input.project_root, exactOutputs, dependencies.capture_identities ?? captureStreamingIdentities),
	]);
	return deepFreeze({
		before_guard: beforeGuard,
		exact_declared_output_paths: exactOutputs,
		before_exact_output_evidence: beforeExactOutputEvidence,
	});
}

/** A subprocess may start only when every required before-image is stable. */
export function recipeCommandEffectPreCaptureError(
	started: Readonly<RecipeCommandEffectCaptureStart>,
): Extract<CommandEffectCaptureError, "BEFORE_GUARD_UNAVAILABLE" | "BEFORE_EXACT_OUTPUT_UNAVAILABLE"> | undefined {
	if (started.before_guard === null) return "BEFORE_GUARD_UNAVAILABLE";
	if (started.before_exact_output_evidence.error !== null) return "BEFORE_EXACT_OUTPUT_UNAVAILABLE";
	return undefined;
}

/** Capture the stable guard immediately after the subprocess and close the record. */
export async function completeRecipeCommandEffectCapture(
	input: CompleteRecipeCommandEffectCaptureInput,
	dependencies: RecipeCommandEffectCaptureDependencies = {},
): Promise<Readonly<CommandEffectRecord>> {
	const exactOutputs = exactOutputPaths(input.declared_writes);
	const capture = dependencies.capture_identities ?? captureStreamingIdentities;
	const [afterGuard, afterExactOutputEvidence] = await Promise.all([
		safeCollect(input, dependencies.collect_guard ?? collectWorkspaceGuard),
		safeCaptureExactOutputs(input.project_root, exactOutputs, capture),
	]);
	const beforeExactOutputEvidence = JSON.stringify(input.started.exact_declared_output_paths) === JSON.stringify(exactOutputs)
		? input.started.before_exact_output_evidence
		: unavailableExactOutputEvidence("invalid_input", "declared writes changed during command-effect capture");
	return buildRecipeCommandEffectRecord({
		run_id: input.run_id,
		recipe: input.recipe,
		actor: input.actor,
		worker_delegation_id: input.worker_delegation_id,
		worker_contract_hash: input.worker_contract_hash,
		mutation_declaration: input.mutation_declaration,
		declared_writes: input.declared_writes,
		before_guard: input.started.before_guard,
		after_guard: afterGuard,
		before_exact_output_evidence: beforeExactOutputEvidence,
		after_exact_output_evidence: afterExactOutputEvidence,
	});
}

/** Exact fail-closed reason used by recipe output and future ChangeSet wiring. */
export function commandEffectBlockingReason(record: Readonly<CommandEffectRecord>): CommandEffectTerminalReason | undefined {
	switch (record.status) {
		case "RECIPE_DECLARATION_VIOLATION": return "RECIPE_DECLARATION_VIOLATION";
		case "UNKNOWN_ORIGIN": return "COMMAND_EFFECT_UNKNOWN_ORIGIN";
		case "OUT_OF_SCOPE": return "COMMAND_EFFECT_OUT_OF_SCOPE";
		case "EVIDENCE_UNAVAILABLE": return "COMMAND_EFFECT_EVIDENCE_UNAVAILABLE";
		default: return undefined;
	}
}

/** Closed terminal projection; semantic acceptance is deliberately absent. */
export function commandEffectTerminalReasons(records: readonly Readonly<CommandEffectRecord>[]): CommandEffectTerminalReason[] {
	const found = new Set<CommandEffectTerminalReason>();
	for (const record of records) {
		const blocking = commandEffectBlockingReason(record);
		if (blocking !== undefined) found.add(blocking);
		if (record.status === "EVIDENCE_UNAVAILABLE") found.add("COMMAND_EFFECT_EVIDENCE_UNAVAILABLE");
	}
	return [
		"RECIPE_DECLARATION_VIOLATION",
		"COMMAND_EFFECT_UNKNOWN_ORIGIN",
		"COMMAND_EFFECT_OUT_OF_SCOPE",
		"COMMAND_EFFECT_EVIDENCE_UNAVAILABLE",
	].filter((reason): reason is CommandEffectTerminalReason => found.has(reason as CommandEffectTerminalReason));
}
