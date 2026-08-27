/**
 * Workbench run records — run IDs and reading run artifacts. Pure logic.
 *
 * Each run writes to `<project-root>/<CONFIG_DIR_NAME>/workbench/runs/<run-id>/`:
 *   manifest.json, command.json, environment.json, stdout.log, stderr.log,
 *   summary.json
 *
 * Never stores API keys, tokens, or full environment values in these records.
 */

import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { runsDir } from "./config.ts";
import {
	fileSourceSnapshotFromStats,
	readJsonFileBounded,
	readTailPage,
	type BoundedFileErrorCode,
	type BoundedFileIoHooks,
} from "./bounded-file-io.ts";
import {
	computeRunLogSourceId,
	computeRunLogSourceStateId,
	decodeContinuationCursor,
	validateRunLogCursorSource,
	type FileSourceSnapshot,
	type RunLogCursorPayloadV1,
	type RunLogSourceState,
} from "./continuation-cursor.ts";
import type { ValidationComponent } from "./recipe-schema.ts";
import type { ValidationEvidenceBlock } from "./validation-evidence.ts";
import type { CacheRequestMode } from "../cache/action-types.ts";
import type { CommandEffectStatus } from "./command-effect.ts";

/** Frozen legacy manifest version. Existing v1 records remain read-only. */
export const RUN_SCHEMA_VERSION = 1;
/** Current manifest version. Old v1 readers must reject newly published runs. */
export const RUN_MANIFEST_SCHEMA_VERSION_V2 = 2;
/** Run JSON is metadata, never an unbounded model-input channel. */
export const RUN_JSON_INPUT_MAX_BYTES = 1_048_576 as const;

export const GATE_ATTEMPT_INDEX_SCHEMA_VERSION = 1 as const;
export const GATE_ATTEMPT_INDEX_SCHEMA_VERSION_V2 = 2 as const;
export const GATE_ATTEMPT_INDEX_DIR = ".gate-index" as const;
export const GATE_ATTEMPT_INDEX_MAX_BYTES = 4_096 as const;
export const GATE_ATTEMPT_ORDER_SCHEMA_VERSION = 1 as const;
export const GATE_ATTEMPT_ORDER_DIR = ".gate-attempt-order" as const;
export const GATE_ATTEMPT_ORDER_MAX_BYTES = 4_096 as const;

export const RUN_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/;

export function makeRunId(date: Date): string {
	const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
	const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
	return `${stamp}-${rand}`;
}

/** Validate a run id strictly (also protects against path traversal). */
export function isValidRunId(runId: string): boolean {
	return RUN_ID_RE.test(runId);
}

export function runDirFor(projectRoot: string, runId: string): string {
	if (!isValidRunId(runId)) throw new Error(`invalid run id "${runId}"`);
	return join(runsDir(projectRoot), runId);
}

export interface RunRecord {
	schema_version: number;
	run_id: string;
	recipe: string;
	profile: string | undefined;
	started_at: string;
	finished_at: string;
	duration_ms: number;
	cwd: string;
	argv: string[];
	exit_code: number | null;
	timed_out: boolean;
	cancelled: boolean;
	git_commit: string | null;
	git_dirty: boolean;
	artifact_paths: string[];
	stdout_truncated: boolean;
	stderr_truncated: boolean;
	mode: string;
	expected_exit_codes: number[];
	declared_writes: string[];
	environment_names: string[];
	/**
	 * Phase 2A: the recipe's declared validation components (closed set:
	 * typecheck | unit-test | whitespace) — the exact recipe declaration,
	 * required on every manifest.
	 */
	validation_components: ValidationComponent[];
	/**
	 * P6-C: cache request mode of this run. "default" reads/writes per the
	 * recipe cache policy; "no-cache" never touches the cache;
	 * "refresh-cache" never reads but rewrites on success. Cache-hit
	 * materialized runs are always "default" — only default mode reads hits.
	 */
	cache_request_mode: CacheRequestMode;
	/** P6-C: how this run was produced. Absent = executed normally. */
	execution_source?: "exec" | "cache";
	/** P6-C: action key when execution_source === "cache". */
	action_key?: string;
	/** P6-C: hash of the executed argv (values are never stored); set for
	 * exec runs (executed-argv hash) and cache hits (action-key argv hash). */
	argv_hash?: string;
	/** P6-C: the run whose cached result was reused. */
	reused_from_run_id?: string;
	/** P6-C: when the cached result was produced / re-validated. */
	cache_created_at?: string;
	cache_validated_at?: string;
	/** P6-C: artifact restore/verification facts of a cached run. */
	artifact_validation?: {
		mode: string;
		artifacts_restored: boolean;
		hash_verified: boolean;
		status: string;
	};
	/** P6-D: quant contract facts of a cached quant-domain run. */
	quant_contract?: {
		type: string;
		manifest: string;
		immutable_key: string;
		validation_status: string;
		logical_reference: string | null;
		resolved_reference: string | null;
		warnings: string[];
	};
	/** P6-C: evidence locations recorded for this run. */
	evidence_paths?: string[];
	/**
	 * P4a: schema-versioned validation-evidence block. Absent on legacy v1
	 * records (still parseable — comparison then refuses reuse with
	 * missing-binding); a binding is present only when capture succeeded,
	 * otherwise a bounded unavailable_reason marks the record explicitly
	 * non-reusable.
	 */
	validation_evidence?: ValidationEvidenceBlock;
	/** Present on runs published through the atomic v2 run transaction. */
	run_transaction_schema_version?: 2;
	/** Bounded machine outcome; process success alone is never sufficient. */
	run_outcome?: "SUCCESS" | "PROCESS_FAILED" | "ARTIFACT_FAILED" | "COMMAND_EFFECT_FAILED";
	artifact_manifest_path?: "artifact-manifest.json";
	/** Durable subprocess provenance, committed in the same atomic run receipt. */
	command_effect_path?: "command-effect.json";
	command_effect_hash?: string;
	command_effect_status?: CommandEffectStatus;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxBytes: number, allowEmpty = false): value is string {
	return typeof value === "string"
		&& (allowEmpty || value.length > 0)
		&& Buffer.byteLength(value, "utf8") <= maxBytes
		&& !/[\u0000]/.test(value);
}

function boundedStringArray(value: unknown, maxItems: number, maxItemBytes: number): value is string[] {
	return Array.isArray(value)
		&& value.length <= maxItems
		&& value.every((entry) => boundedString(entry, maxItemBytes, true));
}

function finiteIso(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function integerArray(value: unknown, maxItems: number): value is number[] {
	return Array.isArray(value)
		&& value.length > 0
		&& value.length <= maxItems
		&& value.every((entry) => typeof entry === "number" && Number.isInteger(entry));
}

/**
 * One shared semantic parser for every committed v2 manifest.  Diagnostic
 * readers intentionally remain looser so they can explain partial attempts;
 * no v2 record is allowed to become execution/Gate authority unless it passes
 * this complete shape and terminal-outcome contract.
 */
export function parseCommittedRunManifestV2(value: unknown, runId: string): RunRecord | null {
	if (!plainRecord(value) || !isValidRunId(runId)) return null;
	if (value.schema_version !== RUN_MANIFEST_SCHEMA_VERSION_V2
		|| value.run_transaction_schema_version !== 2
		|| value.run_id !== runId
		|| !boundedString(value.recipe, 256)
		|| !(value.profile === undefined || boundedString(value.profile, 256))
		|| !finiteIso(value.started_at)
		|| !finiteIso(value.finished_at)
		|| typeof value.duration_ms !== "number"
		|| !Number.isSafeInteger(value.duration_ms)
		|| value.duration_ms < 0
		|| !boundedString(value.cwd, 32_768)
		|| !boundedStringArray(value.argv, 4_096, 65_536)
		|| !(value.exit_code === null || (typeof value.exit_code === "number" && Number.isInteger(value.exit_code)))
		|| typeof value.timed_out !== "boolean"
		|| typeof value.cancelled !== "boolean"
		|| !(value.git_commit === null || boundedString(value.git_commit, 256))
		|| typeof value.git_dirty !== "boolean"
		|| !boundedStringArray(value.artifact_paths, 10_000, 4_096)
		|| typeof value.stdout_truncated !== "boolean"
		|| typeof value.stderr_truncated !== "boolean"
		|| !boundedString(value.mode, 128)
		|| !integerArray(value.expected_exit_codes, 256)
		|| !boundedStringArray(value.declared_writes, 10_000, 4_096)
		|| !boundedStringArray(value.environment_names, 10_000, 1_024)
		|| !Array.isArray(value.validation_components)
		|| value.validation_components.length > 3
		|| value.validation_components.some((entry) => entry !== "typecheck" && entry !== "unit-test" && entry !== "whitespace")
		|| (value.cache_request_mode !== "default" && value.cache_request_mode !== "no-cache" && value.cache_request_mode !== "refresh-cache")
		|| (value.run_outcome !== "SUCCESS" && value.run_outcome !== "PROCESS_FAILED" && value.run_outcome !== "ARTIFACT_FAILED" && value.run_outcome !== "COMMAND_EFFECT_FAILED")
	) return null;

	if (new Set(value.expected_exit_codes).size !== value.expected_exit_codes.length) return null;
	if (new Set(value.validation_components).size !== value.validation_components.length) return null;
	if (value.timed_out && value.cancelled) return null;
	const expectedDuration = Math.max(0, Date.parse(value.finished_at) - Date.parse(value.started_at));
	if (value.duration_ms !== expectedDuration) return null;
	const processSucceeded = value.exit_code !== null
		&& value.expected_exit_codes.includes(value.exit_code)
		&& !value.timed_out
		&& !value.cancelled;
	if (value.run_outcome === "PROCESS_FAILED" ? processSucceeded : !processSucceeded) return null;

	if (!(value.execution_source === undefined || value.execution_source === "exec" || value.execution_source === "cache")) return null;
	if (!(value.action_key === undefined || boundedString(value.action_key, 256))) return null;
	if (!(value.argv_hash === undefined || (typeof value.argv_hash === "string" && /^[0-9a-f]{64}$/.test(value.argv_hash)))) return null;
	if (!(value.reused_from_run_id === undefined || (typeof value.reused_from_run_id === "string" && isValidRunId(value.reused_from_run_id)))) return null;
	if (!(value.cache_created_at === undefined || finiteIso(value.cache_created_at))) return null;
	if (!(value.cache_validated_at === undefined || finiteIso(value.cache_validated_at))) return null;
	if (!(value.evidence_paths === undefined || boundedStringArray(value.evidence_paths, 10_000, 4_096))) return null;
	if (!(value.artifact_manifest_path === undefined || value.artifact_manifest_path === "artifact-manifest.json")) return null;
	if (!(value.validation_evidence === undefined || plainRecord(value.validation_evidence))) return null;
	if (!(value.artifact_validation === undefined || plainRecord(value.artifact_validation))) return null;
	if (!(value.quant_contract === undefined || plainRecord(value.quant_contract))) return null;
	const commandEffectFields = [value.command_effect_path, value.command_effect_hash, value.command_effect_status];
	if (commandEffectFields.some((entry) => entry !== undefined)) {
		if (value.command_effect_path !== "command-effect.json"
			|| typeof value.command_effect_hash !== "string" || !/^[0-9a-f]{64}$/.test(value.command_effect_hash)
			|| typeof value.command_effect_status !== "string" || ![
				"CLEAN", "COMMAND_ATTRIBUTED", "RECIPE_DECLARATION_VIOLATION", "UNKNOWN_ORIGIN", "OUT_OF_SCOPE", "EVIDENCE_UNAVAILABLE",
			].includes(value.command_effect_status)) return null;
	}
	if (value.run_outcome === "COMMAND_EFFECT_FAILED"
		&& value.command_effect_status !== "RECIPE_DECLARATION_VIOLATION"
		&& value.command_effect_status !== "UNKNOWN_ORIGIN"
		&& value.command_effect_status !== "OUT_OF_SCOPE"
		&& value.command_effect_status !== "EVIDENCE_UNAVAILABLE") return null;
	if (value.run_outcome === "SUCCESS"
		&& (value.command_effect_status === "RECIPE_DECLARATION_VIOLATION"
			|| value.command_effect_status === "UNKNOWN_ORIGIN"
			|| value.command_effect_status === "OUT_OF_SCOPE"
			|| value.command_effect_status === "EVIDENCE_UNAVAILABLE")) return null;

	return value as unknown as RunRecord;
}

export interface GateRunCandidate {
	run_id: string;
	source: "marker" | "marker-invalid" | "hint" | "manifest" | "command" | "commit-inventory" | "classification-uncertain";
	/** Exact manifest start time when readable; absent candidates sort conservatively within the same second. */
	started_at?: string;
	/** Durable ordering for current-version attempts; independent of wall time. */
	attempt_sequence?: number;
}

export interface GateAttemptIndexRecord {
	schema_version: 1 | 2;
	recipe: "gate";
	run_id: string;
	started_at: string;
	registered_at: string;
	attempt_sequence?: number;
}

export interface GateAttemptOrderRecord {
	schema_version: 1;
	recipe: "gate";
	run_id: string;
	attempt_sequence: number;
	started_at: string;
	registered_at: string;
}

export type GateAttemptIndexRegistration =
	| { ok: true; path: string }
	| { ok: false; reason: "invalid_input" | "already_registered" | "index_unavailable" };

export interface GateAttemptIndexRegistrationHooks {
	/** Test hook; production uses an actual directory fsync. */
	syncDirectory?(directory: string): Promise<void>;
}

export interface GateRunCandidateHooks {
	/** Test/diagnostic hook: a previously unseen manifest is being classified. */
	onManifestProbe?(runId: string): void;
	/** Test/diagnostic hook: a corrupt/unreadable manifest needs its commit inventory classified. */
	onCommitInventoryProbe?(runId: string): void;
	/** Test/diagnostic hook: a cached classification is being checked without parsing its contents. */
	onSourceIdentityProbe?(runId: string, source: RunIdentityProbeSource): void;
}

export type RunCatalogSource = "manifest" | "command" | "commit-inventory";
export type RunIdentityProbeSource = RunCatalogSource | "gate-marker";

type RunCatalogSourceIdentity =
	| {
		kind: "regular" | "non-regular";
		dev: string;
		ino: string;
		size: string;
		mtimeNs: string;
		ctimeNs: string;
	}
	| { kind: "missing" }
	| { kind: "unavailable" };

interface RunCatalogEntry {
	recipe?: string;
	startedAt?: string;
	source?: RunCatalogSource;
	/** Every source which could have determined this classification. */
	sourceIdentities: Partial<Record<RunCatalogSource, RunCatalogSourceIdentity>>;
	/** A changed source became unreadable, so the candidate must obstruct every recipe. */
	uncertain?: boolean;
}

interface RunCatalog {
	entries: Map<string, RunCatalogEntry>;
}

interface GateAttemptMarkerCatalogEntry {
	record: GateAttemptIndexRecord | null;
	identity: RunCatalogSourceIdentity;
}

const runCatalogs = new Map<string, RunCatalog>();
const gateAttemptMarkerCatalogs = new Map<string, Map<string, GateAttemptMarkerCatalogEntry>>();

function gateAttemptIndexDirectory(projectRoot: string): string {
	return join(runsDir(projectRoot), GATE_ATTEMPT_INDEX_DIR);
}

function gateAttemptIndexPath(projectRoot: string, runId: string): string {
	return join(gateAttemptIndexDirectory(projectRoot), `${runId}.json`);
}

function gateAttemptOrderDirectory(projectRoot: string): string {
	return join(runsDir(projectRoot), GATE_ATTEMPT_ORDER_DIR);
}

function gateAttemptOrderFileName(sequence: number): string {
	return `${String(sequence).padStart(16, "0")}.json`;
}

async function syncGateAttemptIndexDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function parseGateAttemptIndexRecord(value: unknown, runId: string): GateAttemptIndexRecord | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const version = raw.schema_version;
	const expectedKeys = version === GATE_ATTEMPT_INDEX_SCHEMA_VERSION_V2
		? "attempt_sequence,recipe,registered_at,run_id,schema_version,started_at"
		: "recipe,registered_at,run_id,schema_version,started_at";
	if (Object.keys(raw).sort().join(",") !== expectedKeys) return null;
	if (
		(version !== GATE_ATTEMPT_INDEX_SCHEMA_VERSION && version !== GATE_ATTEMPT_INDEX_SCHEMA_VERSION_V2)
		|| raw.recipe !== "gate"
		|| raw.run_id !== runId
		|| typeof raw.started_at !== "string"
		|| !Number.isFinite(Date.parse(raw.started_at))
		|| typeof raw.registered_at !== "string"
		|| !Number.isFinite(Date.parse(raw.registered_at))
		|| (version === GATE_ATTEMPT_INDEX_SCHEMA_VERSION_V2
			&& (typeof raw.attempt_sequence !== "number" || !Number.isSafeInteger(raw.attempt_sequence) || raw.attempt_sequence <= 0))
	) return null;
	return {
		schema_version: version,
		recipe: "gate",
		run_id: runId,
		started_at: raw.started_at,
		registered_at: raw.registered_at,
		...(version === GATE_ATTEMPT_INDEX_SCHEMA_VERSION_V2 ? { attempt_sequence: raw.attempt_sequence as number } : {}),
	};
}

function parseGateAttemptOrderRecord(value: unknown, sequence: number, runId: string): GateAttemptOrderRecord | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (Object.keys(raw).sort().join(",") !== "attempt_sequence,recipe,registered_at,run_id,schema_version,started_at") return null;
	if (raw.schema_version !== GATE_ATTEMPT_ORDER_SCHEMA_VERSION || raw.recipe !== "gate"
		|| raw.run_id !== runId || raw.attempt_sequence !== sequence
		|| typeof raw.started_at !== "string" || !Number.isFinite(Date.parse(raw.started_at))
		|| typeof raw.registered_at !== "string" || !Number.isFinite(Date.parse(raw.registered_at))) return null;
	return {
		schema_version: GATE_ATTEMPT_ORDER_SCHEMA_VERSION,
		recipe: "gate",
		run_id: runId,
		attempt_sequence: sequence,
		started_at: raw.started_at,
		registered_at: raw.registered_at,
	};
}

function parseGateAttemptOrderFileName(name: string): { sequence: number } | null {
	const match = /^(\d{16})\.json$/.exec(name);
	if (!match) return null;
	const sequence = Number(match[1]);
	return Number.isSafeInteger(sequence) && sequence > 0 ? { sequence } : null;
}

async function allocateGateAttemptOrder(
	projectRoot: string,
	runId: string,
	startedAt: Date,
	registeredAt: Date,
): Promise<GateAttemptOrderRecord | null> {
	const directory = gateAttemptOrderDirectory(projectRoot);
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
	} catch {
		return null;
	}
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return null;
	}
	let sequence = 0;
	for (const entry of entries) {
		const parsed = parseGateAttemptOrderFileName(entry.name);
		if (parsed && parsed.sequence > sequence) sequence = parsed.sequence;
	}
	for (let attempt = 0; attempt < 1_024 && sequence < Number.MAX_SAFE_INTEGER; attempt += 1) {
		sequence += 1;
		const record: GateAttemptOrderRecord = {
			schema_version: GATE_ATTEMPT_ORDER_SCHEMA_VERSION,
			recipe: "gate",
			run_id: runId,
			attempt_sequence: sequence,
			started_at: startedAt.toISOString(),
			registered_at: registeredAt.toISOString(),
		};
		const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
		if (bytes.length > GATE_ATTEMPT_ORDER_MAX_BYTES) return null;
		const path = join(directory, gateAttemptOrderFileName(sequence));
		let handle;
		try {
			handle = await open(path, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			return null;
		}
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} catch {
			await handle.close().catch(() => {});
			return null;
		}
		await handle.close().catch(() => {});
		const reread = await readJsonFileBounded<unknown>(path, GATE_ATTEMPT_ORDER_MAX_BYTES);
		if (!reread.ok || !parseGateAttemptOrderRecord(reread.value.value, sequence, runId)) return null;
		try {
			await syncGateAttemptIndexDirectory(directory);
		} catch {
			return null;
		}
		return record;
	}
	return null;
}

/**
 * Register an immutable gate-attempt marker before transaction creation or
 * check evaluation. A crash after registration therefore leaves an explicit
 * newest UNKNOWN candidate instead of exposing an older PASS. The final path
 * is installed with an atomic hard link from a fully synced temporary file.
 */
export async function registerGateRunAttemptIndex(
	projectRoot: string,
	runId: string,
	startedAt: Date,
	registeredAt = new Date(),
	hooks: GateAttemptIndexRegistrationHooks = {},
): Promise<GateAttemptIndexRegistration> {
	if (
		!isValidRunId(runId)
		|| !Number.isFinite(startedAt.getTime())
		|| !Number.isFinite(registeredAt.getTime())
	) return { ok: false, reason: "invalid_input" };
	const directory = gateAttemptIndexDirectory(projectRoot);
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
	} catch {
		return { ok: false, reason: "index_unavailable" };
	}
	const finalPath = gateAttemptIndexPath(projectRoot, runId);
	try {
		await lstat(finalPath);
		return { ok: false, reason: "already_registered" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: "index_unavailable" };
	}
	const order = await allocateGateAttemptOrder(projectRoot, runId, startedAt, registeredAt);
	if (!order) return { ok: false, reason: "index_unavailable" };
	const record: GateAttemptIndexRecord = {
		schema_version: GATE_ATTEMPT_INDEX_SCHEMA_VERSION_V2,
		recipe: "gate",
		run_id: runId,
		started_at: startedAt.toISOString(),
		registered_at: registeredAt.toISOString(),
		attempt_sequence: order.attempt_sequence,
	};
	const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
	if (bytes.length > GATE_ATTEMPT_INDEX_MAX_BYTES) return { ok: false, reason: "invalid_input" };
	const tempPath = join(directory, `.${runId}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	let linked = false;
	try {
		const handle = await open(tempPath, "wx", 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await link(tempPath, finalPath);
			linked = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, reason: "already_registered" };
			return { ok: false, reason: "index_unavailable" };
		}
		const reread = await readJsonFileBounded<unknown>(finalPath, GATE_ATTEMPT_INDEX_MAX_BYTES);
		if (!reread.ok || !parseGateAttemptIndexRecord(reread.value.value, runId)) {
			return { ok: false, reason: "index_unavailable" };
		}
		// Best-effort durable publication on Linux/filesystems which support
		// directory fsync. Failure is fail-closed for the caller even though the
		// hard-linked marker may already be visible; this is not a cross-platform
		// guarantee against every power-loss/filesystem behavior.
		await (hooks.syncDirectory ?? syncGateAttemptIndexDirectory)(directory);
		return { ok: true, path: finalPath };
	} catch {
		return { ok: false, reason: "index_unavailable" };
	} finally {
		await unlink(tempPath).catch(() => {});
		if (!linked) gateAttemptMarkerCatalogs.get(projectRoot)?.delete(runId);
	}
}

async function listGateAttemptMarkers(
	projectRoot: string,
	hooks?: GateRunCandidateHooks,
): Promise<Array<{ run_id: string; record: GateAttemptIndexRecord | null }>> {
	let entries: Dirent[];
	try {
		entries = await readdir(gateAttemptIndexDirectory(projectRoot), { withFileTypes: true });
	} catch {
		entries = [];
	}
	const ids = entries
		// A same-name symlink/directory is still a marker candidate, but strict
		// lstat validation below classifies it as invalid instead of hiding it.
		.filter((entry) => entry.name.endsWith(".json") && isValidRunId(entry.name.slice(0, -5)))
		.map((entry) => entry.name.slice(0, -5));
	let catalog = gateAttemptMarkerCatalogs.get(projectRoot);
	if (!catalog) {
		catalog = new Map();
		gateAttemptMarkerCatalogs.set(projectRoot, catalog);
	}
	const markers: Array<{ run_id: string; record: GateAttemptIndexRecord | null }> = [];
	// A marker observed by this process cannot disappear back into an older
	// PASS. Preserve cached ids when the file or index directory is removed and
	// surface them as marker-invalid.
	for (const runId of new Set([...ids, ...catalog.keys()])) {
		let identity = await gateAttemptMarkerIdentity(projectRoot, runId, hooks);
		const cached = catalog.get(runId);
		let record: GateAttemptIndexRecord | null;
		if (
			cached
			&& identity.kind === "regular"
			&& cached.identity.kind === "regular"
			&& sameRunCatalogSourceIdentity(cached.identity, identity)
		) {
			record = cached.record;
		} else if (identity.kind === "regular") {
			const read = await readJsonFileBounded<unknown>(gateAttemptIndexPath(projectRoot, runId), GATE_ATTEMPT_INDEX_MAX_BYTES);
			const identityAfter = await gateAttemptMarkerIdentity(projectRoot, runId, hooks);
			record = read.ok
				&& identityAfter.kind === "regular"
				&& sameRunCatalogSourceIdentity(identity, identityAfter)
				? parseGateAttemptIndexRecord(read.value.value, runId)
				: null;
			identity = identityAfter;
		} else {
			record = null;
		}
		catalog.set(runId, { record, identity });
		markers.push({ run_id: runId, record });
	}
	markers.sort((a, b) => {
		const aSecond = a.run_id.slice(0, 15);
		const bSecond = b.run_id.slice(0, 15);
		if (aSecond !== bSecond) return bSecond.localeCompare(aSecond);
		// Within one second, a corrupt marker is conservatively newest. It may
		// represent a crash and must not be skipped for an older PASS.
		if ((a.record === null) !== (b.record === null)) return a.record === null ? -1 : 1;
		if (a.record && b.record && a.record.started_at !== b.record.started_at) {
			return a.record.started_at < b.record.started_at ? 1 : -1;
		}
		return b.run_id.localeCompare(a.run_id);
	});
	return markers;
}

async function listGateAttemptOrderClaims(
	projectRoot: string,
): Promise<Array<{ sequence: number; record: GateAttemptOrderRecord | null }>> {
	let entries: Dirent[];
	try {
		entries = await readdir(gateAttemptOrderDirectory(projectRoot), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		// A current-version order ledger which cannot be enumerated is never
		// treated as proof that no newer attempt exists.  Throwing lets the
		// authority-facing caller fail closed instead of selecting old PASS.
		throw new Error("GATE_ATTEMPT_ORDER_UNAVAILABLE");
	}
	const claims: Array<{ sequence: number; record: GateAttemptOrderRecord | null }> = [];
	for (const entry of entries) {
		const identity = parseGateAttemptOrderFileName(entry.name);
		if (!identity) continue;
		let record: GateAttemptOrderRecord | null = null;
		if (entry.isFile()) {
			const read = await readJsonFileBounded<unknown>(join(gateAttemptOrderDirectory(projectRoot), entry.name), GATE_ATTEMPT_ORDER_MAX_BYTES);
			if (read.ok && plainRecord(read.value.value) && typeof read.value.value.run_id === "string" && isValidRunId(read.value.value.run_id)) {
				record = parseGateAttemptOrderRecord(read.value.value, identity.sequence, read.value.value.run_id);
			}
		}
		claims.push({ sequence: identity.sequence, record });
	}
	claims.sort((a, b) => b.sequence - a.sequence);
	return claims;
}

function commitInventoryAdvertisesGate(value: unknown, runId: string): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const raw = value as Record<string, unknown>;
	if (raw.schema_version !== 2 || raw.run_id !== runId || !Array.isArray(raw.files)) return false;
	return raw.files.some((candidate) => {
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
		return (candidate as Record<string, unknown>).path === "gates.json";
	});
}

function commandAdvertisesRecipe(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const recipe = (value as Record<string, unknown>).recipe;
	return typeof recipe === "string" && recipe.length > 0 && recipe.length <= 256 ? recipe : undefined;
}

function runCatalogSourcePath(projectRoot: string, runId: string, source: RunCatalogSource): string {
	const directory = runDirFor(projectRoot, runId);
	switch (source) {
		case "manifest": return join(directory, "manifest.json");
		case "command": return join(directory, "command.json");
		case "commit-inventory": return join(directory, "run-commit.json");
	}
}

async function cachedFileIdentity(
	path: string,
	runId: string,
	source: RunIdentityProbeSource,
	hooks?: GateRunCandidateHooks,
): Promise<RunCatalogSourceIdentity> {
	hooks?.onSourceIdentityProbe?.(runId, source);
	try {
		const stats = await lstat(path, { bigint: true });
		return {
			kind: stats.isFile() ? "regular" : "non-regular",
			dev: stats.dev.toString(10),
			ino: stats.ino.toString(10),
			size: stats.size.toString(10),
			mtimeNs: stats.mtimeNs.toString(10),
			ctimeNs: stats.ctimeNs.toString(10),
		};
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { kind: "missing" }
			: { kind: "unavailable" };
	}
}

async function runCatalogSourceIdentity(
	projectRoot: string,
	runId: string,
	source: RunCatalogSource,
	hooks?: GateRunCandidateHooks,
): Promise<RunCatalogSourceIdentity> {
	return cachedFileIdentity(runCatalogSourcePath(projectRoot, runId, source), runId, source, hooks);
}

async function gateAttemptMarkerIdentity(
	projectRoot: string,
	runId: string,
	hooks?: GateRunCandidateHooks,
): Promise<RunCatalogSourceIdentity> {
	return cachedFileIdentity(gateAttemptIndexPath(projectRoot, runId), runId, "gate-marker", hooks);
}

function sameRunCatalogSourceIdentity(a: RunCatalogSourceIdentity, b: RunCatalogSourceIdentity): boolean {
	// Permission and transient I/O failures are never a reusable cache identity.
	if (a.kind === "unavailable" || b.kind === "unavailable") return false;
	if (a.kind !== b.kind) return false;
	if (a.kind === "missing" || b.kind === "missing") return true;
	return a.dev === b.dev
		&& a.ino === b.ino
		&& a.size === b.size
		&& a.mtimeNs === b.mtimeNs
		&& a.ctimeNs === b.ctimeNs;
}

async function changedRunCatalogSources(
	projectRoot: string,
	runId: string,
	entry: RunCatalogEntry,
	hooks?: GateRunCandidateHooks,
): Promise<Set<RunCatalogSource>> {
	const changed = new Set<RunCatalogSource>();
	const sources = Object.keys(entry.sourceIdentities) as RunCatalogSource[];
	if (sources.length === 0) changed.add("manifest");
	for (const source of sources) {
		const cached = entry.sourceIdentities[source];
		if (!cached) {
			changed.add(source);
			continue;
		}
		const current = await runCatalogSourceIdentity(projectRoot, runId, source, hooks);
		if (!sameRunCatalogSourceIdentity(cached, current)) changed.add(source);
	}
	return changed;
}

async function classifyRunCandidate(
	projectRoot: string,
	runId: string,
	hooks?: GateRunCandidateHooks,
): Promise<RunCatalogEntry> {
	const manifestBefore = await runCatalogSourceIdentity(projectRoot, runId, "manifest", hooks);
	hooks?.onManifestProbe?.(runId);
	const manifest = manifestBefore.kind === "regular" ? await readManifest(projectRoot, runId) : null;
	const manifestAfter = await runCatalogSourceIdentity(projectRoot, runId, "manifest", hooks);
	if (!sameRunCatalogSourceIdentity(manifestBefore, manifestAfter)) {
		return { sourceIdentities: { manifest: manifestAfter }, uncertain: true };
	}
	if (manifest) {
		return {
			recipe: manifest.recipe,
			startedAt: typeof manifest.started_at === "string" && Number.isFinite(Date.parse(manifest.started_at))
				? manifest.started_at
				: undefined,
			source: "manifest",
			sourceIdentities: { manifest: manifestAfter },
		};
	}
	hooks?.onCommitInventoryProbe?.(runId);
	try {
		const commandBefore = await runCatalogSourceIdentity(projectRoot, runId, "command", hooks);
		const command = commandBefore.kind === "regular"
			? await readJsonFileBounded<unknown>(join(runDirFor(projectRoot, runId), "command.json"), RUN_JSON_INPUT_MAX_BYTES)
			: null;
		const commandAfter = await runCatalogSourceIdentity(projectRoot, runId, "command", hooks);
		if (!sameRunCatalogSourceIdentity(commandBefore, commandAfter)) {
			return {
				sourceIdentities: { manifest: manifestAfter, command: commandAfter },
				uncertain: true,
			};
		}
		const recipe = command?.ok ? commandAdvertisesRecipe(command.value.value) : undefined;
		if (recipe) {
			return {
				recipe,
				source: "command",
				sourceIdentities: { manifest: manifestAfter, command: commandAfter },
			};
		}
		const commitBefore = await runCatalogSourceIdentity(projectRoot, runId, "commit-inventory", hooks);
		const read = commitBefore.kind === "regular"
			? await readJsonFileBounded<unknown>(join(runDirFor(projectRoot, runId), "run-commit.json"), RUN_JSON_INPUT_MAX_BYTES)
			: null;
		const commitAfter = await runCatalogSourceIdentity(projectRoot, runId, "commit-inventory", hooks);
		if (!sameRunCatalogSourceIdentity(commitBefore, commitAfter)) {
			return {
				sourceIdentities: {
					manifest: manifestAfter,
					command: commandAfter,
					"commit-inventory": commitAfter,
				},
				uncertain: true,
			};
		}
		if (read?.ok && commitInventoryAdvertisesGate(read.value.value, runId)) {
			return {
				recipe: "gate",
				source: "commit-inventory",
				sourceIdentities: {
					manifest: manifestAfter,
					command: commandAfter,
					"commit-inventory": commitAfter,
				},
			};
		}
		return {
			sourceIdentities: {
				manifest: manifestAfter,
				command: commandAfter,
				"commit-inventory": commitAfter,
			},
		};
	} catch {
		// An unreadable diagnostic directory is not silently classified as a
		// recipe. It remains conservative because this may be a changed newest
		// attempt whose recipe identity can no longer be recovered.
		return { sourceIdentities: { manifest: manifestAfter }, uncertain: true };
	}
}

/**
 * Lazily enumerate candidates for one recipe, newest first. Directory
 * membership is cached per process, so an old repository is classified once
 * rather than on every status/widget/authority refresh. Classification is a
 * lookup optimization only; consumers must re-read the yielded attempt.
 *
 * `includeRunIds` inserts a valid hint even when its directory is missing so
 * a damaged newest run becomes an explicit obstruction instead of allowing a
 * fallback to an older PASS.
 */
export async function* iterateRunAttemptCandidatesByRecipe(
	projectRoot: string,
	recipe: string,
	options: {
		includeRunIds?: readonly string[];
		excludeRunIds?: readonly string[];
		hooks?: GateRunCandidateHooks;
	} = {},
): AsyncGenerator<GateRunCandidate> {
	if (recipe.length === 0 || recipe.length > 256) return;
	let entries: Dirent[];
	try {
		entries = await readdir(runsDir(projectRoot), { withFileTypes: true });
	} catch {
		entries = [];
	}
	const actualIds = entries
		.filter((entry) => entry.isDirectory() && isValidRunId(entry.name))
		.map((entry) => entry.name);
	const actual = new Set(actualIds);
	const included = new Set((options.includeRunIds ?? []).filter(isValidRunId));
	const excluded = new Set((options.excludeRunIds ?? []).filter(isValidRunId));
	const ids = [...new Set([...actualIds, ...included])]
		.filter((runId) => !excluded.has(runId))
		.sort((a, b) => b.localeCompare(a));
	let catalog = runCatalogs.get(projectRoot);
	if (!catalog) {
		catalog = { entries: new Map() };
		runCatalogs.set(projectRoot, catalog);
	}
	for (const cached of [...catalog.entries.keys()]) {
		if (!actual.has(cached)) catalog.entries.delete(cached);
	}
	for (let offset = 0; offset < ids.length;) {
		const second = ids[offset]!.slice(0, 15);
		const group: Array<GateRunCandidate & { hinted: boolean }> = [];
		while (offset < ids.length && ids[offset]!.slice(0, 15) === second) {
			const runId = ids[offset++]!;
			if (included.has(runId) && !actual.has(runId)) {
				group.push({ run_id: runId, source: "hint", hinted: true });
				continue;
			}
			let classification = catalog.entries.get(runId);
			let changedSources = new Set<RunCatalogSource>();
			if (classification) {
				changedSources = await changedRunCatalogSources(projectRoot, runId, classification, options.hooks);
			}
			if (!classification || changedSources.size > 0) {
				classification = await classifyRunCandidate(projectRoot, runId, options.hooks);
				if (
					changedSources.size > 0
					&& (
						classification.recipe === undefined
						|| (changedSources.has("manifest") && classification.source !== "manifest")
					)
				) {
					classification.uncertain = true;
				}
				catalog.entries.set(runId, classification);
			}
			if (classification.recipe === recipe || classification.uncertain) {
				group.push({
					run_id: runId,
					source: classification.uncertain ? "classification-uncertain" : (classification.source ?? "manifest"),
					started_at: classification.startedAt,
					hinted: included.has(runId),
				});
			} else if (included.has(runId)) {
				// A hint that no longer names the recipe is still surfaced as an
				// obstruction; it can never authorize an older successful attempt.
				group.push({ run_id: runId, source: "hint", hinted: true });
			}
		}
		group.sort((a, b) => {
			if (a.hinted !== b.hinted) return a.hinted ? -1 : 1;
			if (a.started_at && b.started_at && a.started_at !== b.started_at) return a.started_at < b.started_at ? 1 : -1;
			// A same-second candidate whose manifest timestamp is unavailable
			// may be the newest corrupt attempt; conservatively inspect it first.
			if (a.started_at !== b.started_at) return a.started_at ? 1 : -1;
			return b.run_id.localeCompare(a.run_id);
		});
		for (const { hinted: _hinted, ...candidate } of group) {
			yield candidate;
		}
	}
}

/** Gate-specialized compatibility wrapper around the recipe iterator. */
function newestGateCandidateFirst(a: GateRunCandidate, b: GateRunCandidate): number {
	const aSecond = a.run_id.slice(0, 15);
	const bSecond = b.run_id.slice(0, 15);
	if (aSecond !== bSecond) return bSecond.localeCompare(aSecond);
	const aUnknown = a.source === "marker-invalid" || a.started_at === undefined;
	const bUnknown = b.source === "marker-invalid" || b.started_at === undefined;
	if (aUnknown !== bUnknown) return aUnknown ? -1 : 1;
	if (a.started_at && b.started_at && a.started_at !== b.started_at) {
		return a.started_at < b.started_at ? 1 : -1;
	}
	return b.run_id.localeCompare(a.run_id);
}

export async function* iterateGateRunCandidates(
	projectRoot: string,
	options: {
		includeRunIds?: readonly string[];
		excludeRunIds?: readonly string[];
		hooks?: GateRunCandidateHooks;
	} = {},
): AsyncGenerator<GateRunCandidate> {
	const excluded = new Set((options.excludeRunIds ?? []).filter(isValidRunId));
	const orderClaims = await listGateAttemptOrderClaims(projectRoot);
	const markers = await listGateAttemptMarkers(projectRoot, options.hooks);
	const markerById = new Map(markers.map((marker) => [marker.run_id, marker]));
	const resolvedClaims = orderClaims.map((claim) => {
		const matchingMarkers = markers.filter((marker) => marker.record?.attempt_sequence === claim.sequence);
		const runId = claim.record?.run_id ?? matchingMarkers[0]?.run_id
			?? `00010101-000000-${claim.sequence.toString(36).slice(-4).padStart(4, "0")}`;
		return { ...claim, run_id: runId, matchingMarkers };
	});
	const orderedIds = new Set(resolvedClaims.map((claim) => claim.run_id));
	const markerIds = new Set<string>();
	const markerCandidates: GateRunCandidate[] = [];
	for (const marker of markers) {
		markerIds.add(marker.run_id);
		if (!orderedIds.has(marker.run_id) && !excluded.has(marker.run_id)) {
			markerCandidates.push({
				run_id: marker.run_id,
				source: marker.record?.schema_version === GATE_ATTEMPT_INDEX_SCHEMA_VERSION ? "marker" : "marker-invalid",
				started_at: marker.record?.started_at,
			});
		}
	}
	markerCandidates.sort(newestGateCandidateFirst);

	// Every current-version registration first publishes one immutable sequence
	// claim.  Sequence order is the freshness authority; wall time and the run
	// id are identity facts only.  A missing compatibility marker is recoverable
	// from the claim after restart, while a present-but-invalid/mismatched marker
	// remains a fail-closed obstruction.
	for (const claim of resolvedClaims) {
		if (excluded.has(claim.run_id)) continue;
		const marker = markerById.get(claim.run_id);
		const markerMatches = marker === undefined || (
			marker.record !== null
			&& marker.record.schema_version === GATE_ATTEMPT_INDEX_SCHEMA_VERSION_V2
			&& marker.record.attempt_sequence === claim.sequence
			&& marker.record.started_at === claim.record?.started_at
		);
		yield {
			run_id: claim.run_id,
			source: claim.record !== null && claim.matchingMarkers.length <= 1 && markerMatches ? "marker" : "marker-invalid",
			started_at: claim.record?.started_at,
			attempt_sequence: claim.sequence,
		};
	}

	// Markers are an optimization, never freshness authority. Merge them with
	// every unmarked same-recipe candidate so a deleted marker, version switch,
	// or interrupted upgrade cannot make an older indexed PASS hide a newer
	// diagnostic FAIL/corruption. The generic side caches directory
	// classification, so repeated refreshes revalidate candidates without
	// reparsing unrelated manifests.
	const unmarked = iterateRunAttemptCandidatesByRecipe(projectRoot, "gate", {
		includeRunIds: markers.length === 0 && orderClaims.length === 0 ? options.includeRunIds : undefined,
		excludeRunIds: [...excluded, ...markerIds, ...orderedIds],
		hooks: options.hooks,
	});
	let markerOffset = 0;
	let unmarkedNext = await unmarked.next();
	while (markerOffset < markerCandidates.length || !unmarkedNext.done) {
		const marker = markerCandidates[markerOffset];
		if (marker && (unmarkedNext.done || newestGateCandidateFirst(marker, unmarkedNext.value) <= 0)) {
			yield marker;
			markerOffset += 1;
			continue;
		}
		if (!unmarkedNext.done) {
			yield unmarkedNext.value;
			unmarkedNext = await unmarked.next();
		}
	}
}

export type LatestRunAttemptForRecipe =
	| { state: "FOUND"; run_id: string; manifest: RunRecord }
	| { state: "CORRUPT"; run_id: string; reason: "manifest_unavailable" | "run_identity_mismatch" | "recipe_identity_mismatch" }
	| { state: "NOT_FOUND" };

/**
 * Resolve the newest diagnostic attempt for one recipe. The selected
 * candidate is re-read every time; a damaged newest same-recipe attempt is an
 * explicit CORRUPT result and never permits fallback to an older success.
 */
export async function latestRunAttemptForRecipe(
	projectRoot: string,
	recipe: string,
	hooks?: GateRunCandidateHooks,
): Promise<LatestRunAttemptForRecipe> {
	for await (const candidate of iterateRunAttemptCandidatesByRecipe(projectRoot, recipe, { hooks })) {
		const identityBefore = await runCatalogSourceIdentity(projectRoot, candidate.run_id, "manifest", hooks);
		if (identityBefore.kind !== "regular") {
			return { state: "CORRUPT", run_id: candidate.run_id, reason: "manifest_unavailable" };
		}
		const manifest = await readManifest(projectRoot, candidate.run_id);
		if (!manifest) return { state: "CORRUPT", run_id: candidate.run_id, reason: "manifest_unavailable" };
		const identityAfter = await runCatalogSourceIdentity(projectRoot, candidate.run_id, "manifest", hooks);
		if (identityAfter.kind !== "regular" || !sameRunCatalogSourceIdentity(identityBefore, identityAfter)) {
			return { state: "CORRUPT", run_id: candidate.run_id, reason: "manifest_unavailable" };
		}
		if (manifest.run_id !== candidate.run_id) {
			return { state: "CORRUPT", run_id: candidate.run_id, reason: "run_identity_mismatch" };
		}
		if (manifest.recipe !== recipe) return { state: "CORRUPT", run_id: candidate.run_id, reason: "recipe_identity_mismatch" };
		return { state: "FOUND", run_id: candidate.run_id, manifest };
	}
	return { state: "NOT_FOUND" };
}

/** Test-only cache reset; production freshness still strictly revalidates candidates. */
export function clearGateRunCandidateCacheForTests(projectRoot?: string): void {
	if (projectRoot === undefined) {
		runCatalogs.clear();
		gateAttemptMarkerCatalogs.clear();
	} else {
		runCatalogs.delete(projectRoot);
		gateAttemptMarkerCatalogs.delete(projectRoot);
	}
}

export async function readManifest(projectRoot: string, runId: string): Promise<RunRecord | null> {
	const dir = runDirFor(projectRoot, runId);
	try {
		const read = await readJsonFileBounded<RunRecord>(join(dir, "manifest.json"), RUN_JSON_INPUT_MAX_BYTES);
		if (!read.ok) return null;
		const parsed = read.value.value;
		if (parsed.schema_version === RUN_SCHEMA_VERSION) {
			return parsed.run_transaction_schema_version === undefined ? parsed : null;
		}
		if (parsed.schema_version === RUN_MANIFEST_SCHEMA_VERSION_V2) {
			return parsed.run_transaction_schema_version === 2 ? parsed : null;
		}
		return null;
	} catch {
		return null;
	}
}

function minimallyValidLegacyRunRecord(value: RunRecord, runId: string): boolean {
	return value.schema_version === RUN_SCHEMA_VERSION &&
		value.run_transaction_schema_version === undefined &&
		value.run_outcome === undefined &&
		value.artifact_manifest_path === undefined &&
		value.run_id === runId &&
		typeof value.recipe === "string" && value.recipe.length > 0 &&
		typeof value.started_at === "string" && Number.isFinite(Date.parse(value.started_at)) &&
		typeof value.finished_at === "string" && Number.isFinite(Date.parse(value.finished_at)) &&
		typeof value.duration_ms === "number" && Number.isFinite(value.duration_ms) && value.duration_ms >= 0 &&
		(value.exit_code === null || (typeof value.exit_code === "number" && Number.isInteger(value.exit_code))) &&
		typeof value.timed_out === "boolean" &&
		typeof value.cancelled === "boolean" &&
		Array.isArray(value.artifact_paths) && value.artifact_paths.every((path) => typeof path === "string");
}

async function v2RunMarkerState(projectRoot: string, runId: string): Promise<"absent" | "present" | "unavailable"> {
	const directory = runDirFor(projectRoot, runId);
	// Keep these literals local: run-transaction.ts imports this module, so a
	// static import of its constants would introduce a runtime cycle.
	for (const name of ["run-commit.json", "artifact-manifest.json"] as const) {
		try {
			await lstat(join(directory, name));
			return "present";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unavailable";
		}
	}
	return "absent";
}

/**
 * Diagnostic-only legacy discriminator. It never grants run or Gate
 * authority: callers may use it only to replace a generic unavailable reason
 * with an actionable upgrade message. Any v2 marker, mixed fields, invalid
 * identity, or I/O uncertainty stays on the ordinary fail-closed path.
 */
export async function isPureLegacyRunForDiagnostic(projectRoot: string, runId: string): Promise<boolean> {
	if (!isValidRunId(runId)) return false;
	if (await v2RunMarkerState(projectRoot, runId) !== "absent") return false;
	const manifest = await readManifest(projectRoot, runId);
	if (!manifest || !minimallyValidLegacyRunRecord(manifest, runId)) return false;
	// A concurrently appearing v2 marker must not be described as legacy even
	// though the result remains non-authoritative either way.
	return await v2RunMarkerState(projectRoot, runId) === "absent";
}

/** Strict authority read: requires an atomically committed v2 run directory. */
export async function readCommittedManifest(projectRoot: string, runId: string): Promise<RunRecord | null> {
	const { readCommittedRunTransaction } = await import("./run-transaction.ts");
	const transaction = await readCommittedRunTransaction(projectRoot, runId);
	if (!transaction.ok) return null;
	const manifest = await readManifest(projectRoot, runId);
	return parseCommittedRunManifestV2(manifest, runId);
}

export interface RunSummaryRecord {
	run_id: string;
	recipe: string;
	profile: string | undefined;
	started_at: string;
	finished_at: string;
	duration_ms: number;
	cwd: string;
	argv: string[];
	exit_code: number | null;
	timed_out: boolean;
	cancelled: boolean;
	git_commit: string | null;
	git_dirty: boolean;
	artifact_paths: string[];
	stdout_truncated: boolean;
	stderr_truncated: boolean;
	stdout: string;
	stderr: string;
	stdout_log: string;
	stderr_log: string;
	command_effect_status?: CommandEffectStatus;
	command_effect_path?: string;
}

export async function readSummary(projectRoot: string, runId: string): Promise<RunSummaryRecord | null> {
	const dir = runDirFor(projectRoot, runId);
	try {
		const read = await readJsonFileBounded<RunSummaryRecord>(join(dir, "summary.json"), RUN_JSON_INPUT_MAX_BYTES);
		return read.ok ? read.value.value : null;
	} catch {
		return null;
	}
}

async function listRunDirectoryIds(projectRoot: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(runsDir(projectRoot), { withFileTypes: true });
	} catch {
		return [];
	}
	// makeRunId's fixed-width prefix is the start second. Callers open only one
	// same-second group at a time, then use exact manifest timestamps inside it.
	return entries
		.filter((entry) => entry.isDirectory() && isValidRunId(entry.name))
		.map((entry) => entry.name)
		.sort((a, b) => b.localeCompare(a));
}

function sameSecondGroups(runIds: readonly string[]): string[][] {
	const groups: string[][] = [];
	for (const runId of runIds) {
		const prior = groups.at(-1);
		if (prior && prior[0]!.slice(0, 15) === runId.slice(0, 15)) prior.push(runId);
		else groups.push([runId]);
	}
	return groups;
}

function newestRunRecordFirst(a: RunRecord, b: RunRecord): number {
	if (a.started_at !== b.started_at) return a.started_at < b.started_at ? 1 : -1;
	return b.run_id.localeCompare(a.run_id);
}

/**
 * Diagnostic inventory of readable run attempts, newest first. This may
 * include an uncommitted v2 manifest so callers can explain a failed attempt;
 * it must never be used as success authority.
 */
export async function listRunAttempts(projectRoot: string, limit = 10): Promise<RunRecord[]> {
	if (!Number.isFinite(limit) || limit <= 0) return [];
	const records: RunRecord[] = [];
	for (const group of sameSecondGroups(await listRunDirectoryIds(projectRoot))) {
		const candidates: RunRecord[] = [];
		for (const runId of group) {
			const manifest = await readManifest(projectRoot, runId);
			if (manifest?.run_id === runId) candidates.push(manifest);
		}
		candidates.sort(newestRunRecordFirst);
		records.push(...candidates.slice(0, limit - records.length));
		if (records.length >= limit) break;
	}
	return records;
}

/**
 * Consumable run listing. Legacy v1 manifests remain visible for read-only
 * compatibility; every manifest that advertises the v2 transaction contract
 * is listed only after its complete directory identity verifies.
 */
export async function listRuns(projectRoot: string, limit = 10): Promise<RunRecord[]> {
	if (!Number.isFinite(limit) || limit <= 0) return [];
	const records: RunRecord[] = [];
	for (const group of sameSecondGroups(await listRunDirectoryIds(projectRoot))) {
		const candidates: RunRecord[] = [];
		for (const runId of group) {
			const attempt = await readManifest(projectRoot, runId);
			if (!attempt || attempt.run_id !== runId) continue;
			if (attempt.run_transaction_schema_version === 2) {
				const committed = await readCommittedManifest(projectRoot, attempt.run_id);
				if (committed) candidates.push(committed);
			} else {
				candidates.push(attempt);
			}
		}
		candidates.sort(newestRunRecordFirst);
		records.push(...candidates.slice(0, limit - records.length));
		if (records.length >= limit) break;
	}
	return records;
}

/** List only atomically committed v2 runs. Partial and legacy runs are excluded. */
export async function listCommittedRuns(projectRoot: string, limit = 10): Promise<RunRecord[]> {
	if (!Number.isFinite(limit) || limit <= 0) return [];
	const records: RunRecord[] = [];
	for (const group of sameSecondGroups(await listRunDirectoryIds(projectRoot))) {
		const candidates: RunRecord[] = [];
		for (const runId of group) {
			const manifest = await readCommittedManifest(projectRoot, runId);
			if (manifest) candidates.push(manifest);
		}
		candidates.sort(newestRunRecordFirst);
		records.push(...candidates.slice(0, limit - records.length));
		if (records.length >= limit) break;
	}
	return records;
}

export interface LogSnippetOptions {
	maxLines?: number;
	maxBytes?: number;
}

export const DEFAULT_SNIPPET_LINES = 200;
export const DEFAULT_SNIPPET_BYTES = 20 * 1024;
export const RUN_LOG_MAX_LINES = 400 as const;
export const RUN_LOG_MAX_BYTES = 32_768 as const;
export const RUN_LOG_MIN_BYTES = 1_024 as const;

export type RunLogSelection = "stdout" | "stderr" | "both";
export type RunLogStreamName = "stdout" | "stderr";
export type RunLogStreamState = "missing" | "empty" | "content";

export interface RunLogPageStream {
	stream: RunLogStreamName;
	path: string;
	state: RunLogStreamState;
	text: string;
	startByte: number;
	endExclusive: number;
	fileSize: number;
	shownBytes: number;
	shownLines: number;
	completeBefore: boolean;
	lineSegment: boolean;
}

export interface RunLogPage {
	runId: string;
	selection: RunLogSelection;
	sourceId: string;
	sourceStateId: string;
	stdout: RunLogPageStream;
	stderr: RunLogPageStream;
	maxBytes: number;
	maxLines: number;
}

export type RunLogPageErrorCode = BoundedFileErrorCode;
export type RunLogPageResult =
	| { ok: true; value: RunLogPage }
	| { ok: false; error: { code: RunLogPageErrorCode; message: string } };

export interface ReadRunLogPageOptions {
	logStream?: RunLogSelection;
	cursor?: string;
	maxBytes?: number;
	maxLines?: number;
	/** Failed/timed-out/cancelled/killed runs give stderr the 60% share. */
	preferStderr?: boolean;
	hooks?: Partial<Record<RunLogStreamName, BoundedFileIoHooks>>;
}

const RUN_LOG_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
	invalid_cursor: "The run-log cursor is invalid.",
	stale_cursor: "The run-log cursor is stale.",
	source_mismatch: "The run-log cursor belongs to a different run or stream selection.",
	source_changed_during_read: "A run log changed during the bounded read.",
	invalid_pagination: "The run-log pagination request is invalid.",
	source_oversized: "The run log exceeds the bounded input limit.",
	source_not_regular: "A run log is not a regular file.",
	io_error: "The bounded run-log read failed.",
	invalid_utf8: "A run log is not valid UTF-8.",
	invalid_json: "The run-log source is not valid JSON.",
});

function runLogFailure(code: RunLogPageErrorCode): RunLogPageResult {
	return { ok: false, error: { code, message: RUN_LOG_ERROR_MESSAGES[code] ?? "The bounded run-log read failed." } };
}

function exactSnapshot(a: FileSourceSnapshot | null, b: FileSourceSnapshot | null): boolean {
	if (a === null || b === null) return a === b;
	return a.fileSize === b.fileSize && a.mtimeMs === b.mtimeMs && a.mtimeNs === b.mtimeNs && a.dev === b.dev && a.ino === b.ino;
}

async function snapshotLog(path: string): Promise<{ ok: true; value: FileSourceSnapshot | null } | { ok: false }> {
	let handle;
	try {
		handle = await open(path, "r");
		const stats = await handle.stat({ bigint: true });
		if (!stats.isFile()) return { ok: false };
		const snapshot = fileSourceSnapshotFromStats(stats);
		return snapshot.ok ? { ok: true, value: snapshot.value } : { ok: false };
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { ok: true, value: null } : { ok: false };
	} finally {
		try { await handle?.close(); } catch { /* read-only snapshot already failed/succeeded */ }
	}
}

async function snapshotPair(stdoutPath: string, stderrPath: string): Promise<{ ok: true; value: RunLogSourceState } | { ok: false }> {
	const [stdout, stderr] = await Promise.all([snapshotLog(stdoutPath), snapshotLog(stderrPath)]);
	if (!stdout.ok || !stderr.ok) return { ok: false };
	return { ok: true, value: { stdout: stdout.value, stderr: stderr.value } };
}

function normalizedInt(value: unknown, fallback: number, min: number, max: number): number | undefined {
	if (value === undefined) return fallback;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

function emptyStream(stream: RunLogStreamName, path: string, snapshot: FileSourceSnapshot | null): RunLogPageStream {
	return {
		stream,
		path,
		state: snapshot === null ? "missing" : snapshot.fileSize === 0 ? "empty" : "content",
		text: "",
		startByte: 0,
		endExclusive: 0,
		fileSize: snapshot?.fileSize ?? 0,
		shownBytes: 0,
		shownLines: 0,
		completeBefore: true,
		lineSegment: false,
	};
}

async function pageOne(input: {
	stream: RunLogStreamName;
	path: string;
	snapshot: FileSourceSnapshot | null;
	endExclusive: number;
	maxBytes: number;
	maxLines: number;
	hooks?: BoundedFileIoHooks;
}): Promise<RunLogPageResult | RunLogPageStream> {
	if (input.snapshot === null || input.snapshot.fileSize === 0 || input.endExclusive === 0) return emptyStream(input.stream, input.path, input.snapshot);
	const page = await readTailPage(input.path, {
		endExclusive: input.endExclusive,
		maxBytes: Math.max(1, input.maxBytes),
		maxLines: Math.max(1, input.maxLines),
		...(input.hooks ? { hooks: input.hooks } : {}),
	});
	if (!page.ok) return runLogFailure(page.error.code);
	if (!exactSnapshot(input.snapshot, page.value.source)) return runLogFailure("source_changed_during_read");
	return {
		stream: input.stream,
		path: input.path,
		state: "content",
		text: page.value.text,
		startByte: page.value.startByte,
		endExclusive: page.value.endExclusive,
		fileSize: page.value.source.fileSize,
		shownBytes: page.value.shownBytes,
		shownLines: page.value.shownLines,
		completeBefore: page.value.completeBefore,
		lineSegment: page.value.lineSegment,
	};
}

function isPageFailure(value: RunLogPageResult | RunLogPageStream): value is Extract<RunLogPageResult, { ok: false }> {
	return "ok" in value && value.ok === false;
}

/**
 * Seek-based, shared-budget reverse page over stdout/stderr. The function
 * allocates at most maxBytes plus a four-byte UTF-8 alignment window per
 * stream, validates one combined cursor state, and performs at most one
 * bounded redistribution reread when a stream cannot use its share.
 */
export async function readRunLogPage(projectRoot: string, runId: string, options: ReadRunLogPageOptions = {}): Promise<RunLogPageResult> {
	const selection = options.logStream ?? "both";
	const maxBytes = normalizedInt(options.maxBytes, DEFAULT_SNIPPET_BYTES, 1, RUN_LOG_MAX_BYTES);
	const maxLines = normalizedInt(options.maxLines, DEFAULT_SNIPPET_LINES, 1, RUN_LOG_MAX_LINES);
	if ((selection !== "stdout" && selection !== "stderr" && selection !== "both") || maxBytes === undefined || maxLines === undefined) {
		return runLogFailure("invalid_pagination");
	}
	const dir = runDirFor(projectRoot, runId);
	const stdoutPath = join(dir, "stdout.log");
	const stderrPath = join(dir, "stderr.log");
	const before = await snapshotPair(stdoutPath, stderrPath);
	if (!before.ok) return runLogFailure("io_error");
	const sourceId = computeRunLogSourceId(runId, selection);
	const sourceStateId = computeRunLogSourceStateId(before.value);
	if (!sourceId.ok || !sourceStateId.ok) return runLogFailure("invalid_cursor");

	let cursorPayload: RunLogCursorPayloadV1 | undefined;
	if (options.cursor !== undefined) {
		const decoded = decodeContinuationCursor(options.cursor);
		if (!decoded.ok) return runLogFailure(decoded.error.code);
		const valid = validateRunLogCursorSource({ payload: decoded.value, expectedSourceId: sourceId.value, currentSourceStateId: sourceStateId.value });
		if (!valid.ok) return runLogFailure(valid.error.code);
		cursorPayload = valid.value;
	}
	const endFor = (stream: RunLogStreamName): number => {
		if ((selection === "stdout" && stream === "stderr") || (selection === "stderr" && stream === "stdout")) return 0;
		const fromCursor = stream === "stdout" ? cursorPayload?.stdoutEndExclusive : cursorPayload?.stderrEndExclusive;
		return fromCursor ?? before.value[stream]?.fileSize ?? 0;
	};
	const stdoutEnd = endFor("stdout");
	const stderrEnd = endFor("stderr");
	if (stdoutEnd > (before.value.stdout?.fileSize ?? 0) || stderrEnd > (before.value.stderr?.fileSize ?? 0)) return runLogFailure("invalid_cursor");

	const only = selection === "stdout" || selection === "stderr";
	const stderrShare = options.preferStderr === true ? 0.6 : 0.5;
	const stdoutByteCap = only ? (selection === "stdout" ? maxBytes : 0) : Math.floor(maxBytes * (1 - stderrShare));
	const stderrByteCap = only ? (selection === "stderr" ? maxBytes : 0) : maxBytes - stdoutByteCap;
	const stdoutLineCap = only ? (selection === "stdout" ? maxLines : 0) : Math.floor(maxLines * (1 - stderrShare));
	const stderrLineCap = only ? (selection === "stderr" ? maxLines : 0) : maxLines - stdoutLineCap;

	let stdout: RunLogPageStream = emptyStream("stdout", stdoutPath, before.value.stdout);
	let stderr: RunLogPageStream = emptyStream("stderr", stderrPath, before.value.stderr);
	if (stdoutByteCap > 0 && stdoutLineCap > 0) {
		const page = await pageOne({ stream: "stdout", path: stdoutPath, snapshot: before.value.stdout, endExclusive: stdoutEnd, maxBytes: stdoutByteCap, maxLines: stdoutLineCap, hooks: options.hooks?.stdout });
		if (isPageFailure(page)) return page;
		stdout = page as RunLogPageStream;
	}
	if (stderrByteCap > 0 && stderrLineCap > 0) {
		const page = await pageOne({ stream: "stderr", path: stderrPath, snapshot: before.value.stderr, endExclusive: stderrEnd, maxBytes: stderrByteCap, maxLines: stderrLineCap, hooks: options.hooks?.stderr });
		if (isPageFailure(page)) return page;
		stderr = page as RunLogPageStream;
	}

	// One deterministic bounded redistribution: an under-used share is lent
	// to the other, still from the same cursor endpoint and under global caps.
	if (selection === "both") {
		const target = options.preferStderr === true
			? (!stderr.completeBefore ? "stderr" : !stdout.completeBefore ? "stdout" : undefined)
			: (!stdout.completeBefore ? "stdout" : !stderr.completeBefore ? "stderr" : undefined);
		const lentBytes = target === "stdout"
			? Math.max(0, stderrByteCap - stderr.shownBytes)
			: target === "stderr" ? Math.max(0, stdoutByteCap - stdout.shownBytes) : 0;
		const lentLines = target === "stdout"
			? Math.max(0, stderrLineCap - stderr.shownLines)
			: target === "stderr" ? Math.max(0, stdoutLineCap - stdout.shownLines) : 0;
		if (target && (lentBytes > 0 || lentLines > 0)) {
			const originalByteCap = target === "stdout" ? stdoutByteCap : stderrByteCap;
			const originalLineCap = target === "stdout" ? stdoutLineCap : stderrLineCap;
			const page = await pageOne({
				stream: target,
				path: target === "stdout" ? stdoutPath : stderrPath,
				snapshot: before.value[target],
				endExclusive: target === "stdout" ? stdoutEnd : stderrEnd,
				maxBytes: Math.min(maxBytes, originalByteCap + lentBytes),
				maxLines: Math.min(maxLines, originalLineCap + lentLines),
				hooks: options.hooks?.[target],
			});
			if (isPageFailure(page)) return page;
			if (target === "stdout") stdout = page as RunLogPageStream;
			else stderr = page as RunLogPageStream;
		}
	}

	const after = await snapshotPair(stdoutPath, stderrPath);
	if (!after.ok || !exactSnapshot(before.value.stdout, after.value.stdout) || !exactSnapshot(before.value.stderr, after.value.stderr)) {
		return runLogFailure("source_changed_during_read");
	}
	if (stdout.shownBytes + stderr.shownBytes > maxBytes || stdout.shownLines + stderr.shownLines > maxLines) return runLogFailure("invalid_pagination");
	return { ok: true, value: { runId, selection, sourceId: sourceId.value, sourceStateId: sourceStateId.value, stdout, stderr, maxBytes, maxLines } };
}

/**
 * Read a bounded tail of a run log — never the full log — for model/UI
 * display. The full log stays on disk at the returned path.
 */
export async function readLogSnippet(
	projectRoot: string,
	runId: string,
	stream: "stdout" | "stderr",
	options?: LogSnippetOptions,
): Promise<{ content: string; truncated: boolean; path: string }> {
	const path = join(runDirFor(projectRoot, runId), `${stream}.log`);
	const result = await readRunLogPage(projectRoot, runId, {
		logStream: stream,
		maxLines: Math.min(RUN_LOG_MAX_LINES, Math.max(1, Math.floor(options?.maxLines ?? DEFAULT_SNIPPET_LINES))),
		maxBytes: Math.min(RUN_LOG_MAX_BYTES, Math.max(1, Math.floor(options?.maxBytes ?? DEFAULT_SNIPPET_BYTES))),
	});
	if (!result.ok) return { content: "", truncated: false, path };
	const page = result.value[stream];
	return { content: page.text, truncated: !page.completeBefore, path };
}
