/**
 * ChangeSet v2 workspace guard.
 *
 * The guard binds Git HEAD and exact porcelain status paths to lstat-only
 * identities. Workbench-owned runtime artifacts are reported separately and
 * intentionally do not affect the guard hash.
 */

import { createHash } from "node:crypto";
import { type BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, posix, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import type { ExecFn } from "./config.ts";

export const WORKSPACE_GUARD_SCHEMA_VERSION = 2 as const;
export const WORKSPACE_GUARD_MAX_RELEVANT_PATHS = 500;
export const WORKSPACE_GUARD_MAX_IRRELEVANT_PATHS = 500;
export const WORKSPACE_GUARD_MAX_STATUS_BYTES = 1024 * 1024;
export const WORKSPACE_GUARD_MAX_PATH_BYTES = 400;

export const WORKSPACE_GUARD_FAULT_POINTS = [
	"head_before",
	"head_after",
	"status_before",
	"status_after",
	"stat_before",
	"stat_after",
] as const;

export type WorkspaceGuardFaultPoint = typeof WORKSPACE_GUARD_FAULT_POINTS[number];

export type WorkspaceGuardErrorCode =
	| "invalid_input"
	| "git_failure"
	| "invalid_path"
	| "path_overflow"
	| "status_overflow"
	| "stat_failure"
	| "unstable";

export interface WorkspaceGuardError {
	code: WorkspaceGuardErrorCode;
	message: string;
}

export interface WorkspaceGuardMeter {
	status_bytes: number;
	relevant_paths: number;
	irrelevant_paths: number;
	stat_calls: number;
	content_bytes_read: 0;
}

export interface WorkspaceGuardStat {
	dev: string;
	ino: string;
	mtime_ns: string;
	ctime_ns: string;
}

export interface WorkspaceGuardMissingIdentity {
	kind: "missing";
}

export interface WorkspaceGuardPresentIdentity {
	kind: "file" | "directory" | "symlink" | "other";
	byte_size: number;
	stat: WorkspaceGuardStat;
}

export type WorkspaceGuardIdentity = WorkspaceGuardMissingIdentity | WorkspaceGuardPresentIdentity;

export interface WorkspaceGuardEntry {
	path: string;
	status: string;
	identity: WorkspaceGuardIdentity;
}

export interface WorkspaceGuardRecord {
	schema_version: typeof WORKSPACE_GUARD_SCHEMA_VERSION;
	git_head: string | null;
	entries: readonly WorkspaceGuardEntry[];
	irrelevant_artifact_paths: readonly string[];
	meter: Readonly<WorkspaceGuardMeter>;
	workspace_guard_hash: string;
}

export interface WorkspaceGuardLimits {
	max_relevant_paths?: number;
	max_irrelevant_paths?: number;
	max_status_bytes?: number;
	max_path_bytes?: number;
}

export interface WorkspaceGuardStatAdapter {
	lstat(path: string): Promise<BigIntStats | null>;
}

export interface WorkspaceGuardFaultContext {
	path?: string;
}

export interface WorkspaceGuardHooks {
	fault?(
		point: WorkspaceGuardFaultPoint,
		context: Readonly<WorkspaceGuardFaultContext>,
	): void | Promise<void>;
}

export interface CollectWorkspaceGuardInput {
	project_root: string;
	exec: ExecFn;
	limits?: Readonly<WorkspaceGuardLimits>;
	stat_adapter?: WorkspaceGuardStatAdapter;
	hooks?: WorkspaceGuardHooks;
}

export type CollectWorkspaceGuardResult =
	| { ok: true; guard: Readonly<WorkspaceGuardRecord> }
	| { ok: false; error: WorkspaceGuardError; meter: Readonly<WorkspaceGuardMeter> };

const ERROR_MESSAGES: Readonly<Record<WorkspaceGuardErrorCode, string>> = Object.freeze({
	invalid_input: "workspace guard input is invalid",
	git_failure: "workspace guard git operation failed",
	invalid_path: "workspace guard path or status is invalid",
	path_overflow: "workspace guard path-count limit exceeded",
	status_overflow: "workspace guard status-byte limit exceeded",
	stat_failure: "workspace guard stat operation failed",
	unstable: "workspace guard source changed during capture",
});

const STATUS_CHARS = new Set([" ", "M", "A", "D", "R", "C", "U", "?", "!"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const CONTROL_PREFIXES = [
	".pi/workbench/delegations/",
	".pi/workbench/tool-results/",
	".pi/workbench/runs/",
] as const;

interface NormalizedLimits {
	max_relevant_paths: number;
	max_irrelevant_paths: number;
	max_status_bytes: number;
	max_path_bytes: number;
}

interface ParsedStatusPath {
	path: string;
	status: string;
}

function emptyMeter(): WorkspaceGuardMeter {
	return { status_bytes: 0, relevant_paths: 0, irrelevant_paths: 0, stat_calls: 0, content_bytes_read: 0 };
}

function snapshotMeter(meter: WorkspaceGuardMeter): Readonly<WorkspaceGuardMeter> {
	return Object.freeze({ ...meter });
}

function failure(
	code: WorkspaceGuardErrorCode,
	meter: WorkspaceGuardMeter,
): CollectWorkspaceGuardResult {
	return {
		ok: false,
		error: Object.freeze({ code, message: ERROR_MESSAGES[code] }),
		meter: snapshotMeter(meter),
	};
}

function exactKeys(value: object, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedPositive(value: unknown, hardMaximum: number): value is number {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value > 0
		&& value <= hardMaximum;
}

function normalizeLimits(limits: Readonly<WorkspaceGuardLimits> | undefined): NormalizedLimits | undefined {
	if (limits !== undefined && (limits === null || typeof limits !== "object" || Array.isArray(limits))) return undefined;
	if (limits !== undefined && !exactKeys(limits, Object.keys(limits).filter((key) => [
		"max_relevant_paths", "max_irrelevant_paths", "max_status_bytes", "max_path_bytes",
	].includes(key)))) return undefined;
	if (limits !== undefined && Object.keys(limits).some((key) => ![
		"max_relevant_paths", "max_irrelevant_paths", "max_status_bytes", "max_path_bytes",
	].includes(key))) return undefined;
	const max_relevant_paths = limits?.max_relevant_paths ?? WORKSPACE_GUARD_MAX_RELEVANT_PATHS;
	const max_irrelevant_paths = limits?.max_irrelevant_paths ?? WORKSPACE_GUARD_MAX_IRRELEVANT_PATHS;
	const max_status_bytes = limits?.max_status_bytes ?? WORKSPACE_GUARD_MAX_STATUS_BYTES;
	const max_path_bytes = limits?.max_path_bytes ?? WORKSPACE_GUARD_MAX_PATH_BYTES;
	if (!boundedPositive(max_relevant_paths, WORKSPACE_GUARD_MAX_RELEVANT_PATHS)
		|| !boundedPositive(max_irrelevant_paths, WORKSPACE_GUARD_MAX_IRRELEVANT_PATHS)
		|| !boundedPositive(max_status_bytes, WORKSPACE_GUARD_MAX_STATUS_BYTES)
		|| !boundedPositive(max_path_bytes, WORKSPACE_GUARD_MAX_PATH_BYTES)) return undefined;
	return { max_relevant_paths, max_irrelevant_paths, max_status_bytes, max_path_bytes };
}

/** Strict portable project-relative path. Newlines and spaces are valid Git path bytes. */
export function isStrictWorkspaceGuardPath(path: unknown): path is string {
	if (typeof path !== "string" || path.length === 0) return false;
	if (Buffer.byteLength(path, "utf8") > WORKSPACE_GUARD_MAX_PATH_BYTES) return false;
	if (path.includes("\0") || path.includes("\\") || isAbsolute(path)) return false;
	if (path === "." || path.startsWith("./") || path.endsWith("/") || path.includes("//")) return false;
	if (posix.normalize(path) !== path) return false;
	return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isStatus(status: unknown): status is string {
	if (typeof status !== "string" || status.length !== 2) return false;
	const [x, y] = status;
	if (!x || !y || !STATUS_CHARS.has(x) || !STATUS_CHARS.has(y)) return false;
	if (x === "?" || y === "?") return status === "??";
	if (x === "!" || y === "!") return status === "!!";
	return status !== "  ";
}

function bufferFromOutput(value: unknown): Buffer | undefined {
	return typeof value === "string" ? Buffer.from(value, "utf8") : undefined;
}

function decodePath(bytes: Buffer, maxPathBytes: number): string | undefined {
	if (bytes.length === 0 || bytes.length > maxPathBytes) return undefined;
	try {
		const decoded = UTF8_DECODER.decode(bytes);
		return Buffer.from(decoded, "utf8").equals(bytes) ? decoded : undefined;
	} catch {
		return undefined;
	}
}

function nextNul(bytes: Buffer, from: number): number {
	return bytes.indexOf(0, from);
}

function parseStatus(bytes: Buffer, maxPathBytes: number): ParsedStatusPath[] | undefined {
	if (bytes.length === 0) return [];
	const parsed: ParsedStatusPath[] = [];
	let offset = 0;
	while (offset < bytes.length) {
		const end = nextNul(bytes, offset);
		if (end < 0 || end - offset < 4) return undefined;
		const status = bytes.subarray(offset, offset + 2).toString("ascii");
		if (!isStatus(status) || bytes[offset + 2] !== 0x20) return undefined;
		const primary = decodePath(bytes.subarray(offset + 3, end), maxPathBytes);
		if (primary === undefined || !isStrictWorkspaceGuardPath(primary)) return undefined;
		parsed.push({ path: primary, status });
		offset = end + 1;
		if (status.includes("R") || status.includes("C")) {
			const originalEnd = nextNul(bytes, offset);
			if (originalEnd < 0) return undefined;
			const original = decodePath(bytes.subarray(offset, originalEnd), maxPathBytes);
			if (original === undefined || !isStrictWorkspaceGuardPath(original)) return undefined;
			parsed.push({ path: original, status });
			offset = originalEnd + 1;
		}
	}
	return parsed;
}

function isIrrelevantArtifactPath(path: string): boolean {
	return CONTROL_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function nodeErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

export function createNodeWorkspaceGuardStatAdapter(): WorkspaceGuardStatAdapter {
	return {
		async lstat(path) {
			try {
				return await lstat(path, { bigint: true });
			} catch (error) {
				if (nodeErrorCode(error) === "ENOENT") return null;
				throw error;
			}
		},
	};
}

function normalizedStat(stats: BigIntStats): WorkspaceGuardStat | undefined {
	if (stats.dev < 0n || stats.ino < 0n || stats.mtimeNs < 0n || stats.ctimeNs < 0n) return undefined;
	return Object.freeze({
		dev: stats.dev.toString(10),
		ino: stats.ino.toString(10),
		mtime_ns: stats.mtimeNs.toString(10),
		ctime_ns: stats.ctimeNs.toString(10),
	});
}

function kindOf(stats: BigIntStats): WorkspaceGuardPresentIdentity["kind"] {
	if (stats.isSymbolicLink()) return "symlink";
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	return "other";
}

function identityFromStat(stats: BigIntStats | null): WorkspaceGuardIdentity | undefined {
	if (stats === null) return Object.freeze({ kind: "missing" });
	if (stats.size < 0n || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
	const stat = normalizedStat(stats);
	if (!stat) return undefined;
	return Object.freeze({ kind: kindOf(stats), byte_size: Number(stats.size), stat });
}

function identityEqual(left: WorkspaceGuardIdentity, right: WorkspaceGuardIdentity): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "missing" || right.kind === "missing") return left.kind === right.kind;
	return left.byte_size === right.byte_size
		&& left.stat.dev === right.stat.dev
		&& left.stat.ino === right.stat.ino
		&& left.stat.mtime_ns === right.stat.mtime_ns
		&& left.stat.ctime_ns === right.stat.ctime_ns;
}

function canonicalHashIdentity(identity: WorkspaceGuardIdentity): WorkspaceGuardIdentity {
	if (identity.kind === "missing") return { kind: identity.kind };
	return {
		kind: identity.kind,
		byte_size: identity.byte_size,
		stat: {
			dev: identity.stat.dev,
			ino: identity.stat.ino,
			mtime_ns: identity.stat.mtime_ns,
			ctime_ns: identity.stat.ctime_ns,
		},
	};
}

function canonicalHashEntry(entry: WorkspaceGuardEntry): WorkspaceGuardEntry {
	return {
		path: entry.path,
		status: entry.status,
		identity: canonicalHashIdentity(entry.identity),
	};
}

function canonicalHashPayload(gitHead: string | null, entries: readonly WorkspaceGuardEntry[]): string {
	return JSON.stringify({
		schema_version: WORKSPACE_GUARD_SCHEMA_VERSION,
		git_head: gitHead,
		entries: entries.map(canonicalHashEntry),
	});
}

/** Hash only Git HEAD and relevant entries. Runtime artifact drift is excluded. */
export function computeWorkspaceGuardHash(
	gitHead: string | null,
	entries: readonly WorkspaceGuardEntry[],
): string {
	return createHash("sha256").update(canonicalHashPayload(gitHead, entries)).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isDecimal(value: unknown): value is string {
	return typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value);
}

function validateIdentity(value: unknown): value is WorkspaceGuardIdentity {
	if (!isPlainObject(value) || typeof value.kind !== "string") return false;
	if (value.kind === "missing") return exactKeys(value, ["kind"]);
	if (!["file", "directory", "symlink", "other"].includes(value.kind)) return false;
	if (!exactKeys(value, ["kind", "byte_size", "stat"]) || !safeCounter(value.byte_size) || !isPlainObject(value.stat)) return false;
	return exactKeys(value.stat, ["dev", "ino", "mtime_ns", "ctime_ns"])
		&& isDecimal(value.stat.dev)
		&& isDecimal(value.stat.ino)
		&& isDecimal(value.stat.mtime_ns)
		&& isDecimal(value.stat.ctime_ns);
}

function validateEntry(value: unknown): value is WorkspaceGuardEntry {
	return isPlainObject(value)
		&& exactKeys(value, ["path", "status", "identity"])
		&& isStrictWorkspaceGuardPath(value.path)
		&& isStatus(value.status)
		&& validateIdentity(value.identity);
}

/** Strict closed-schema guard validator, including canonical order and digest. */
export function validateWorkspaceGuard(
	value: unknown,
	limits?: Readonly<WorkspaceGuardLimits>,
): value is WorkspaceGuardRecord {
	const normalizedLimits = normalizeLimits(limits);
	if (!normalizedLimits || !isPlainObject(value)) return false;
	if (!exactKeys(value, [
		"schema_version", "git_head", "entries", "irrelevant_artifact_paths", "meter", "workspace_guard_hash",
	])) return false;
	if (value.schema_version !== WORKSPACE_GUARD_SCHEMA_VERSION) return false;
	if (value.git_head !== null && (typeof value.git_head !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(value.git_head))) return false;
	if (!Array.isArray(value.entries) || value.entries.length > normalizedLimits.max_relevant_paths) return false;
	if (!Array.isArray(value.irrelevant_artifact_paths)
		|| value.irrelevant_artifact_paths.length > normalizedLimits.max_irrelevant_paths) return false;
	let previous: string | undefined;
	for (const entry of value.entries) {
		if (!validateEntry(entry) || isIrrelevantArtifactPath(entry.path)) return false;
		if (Buffer.byteLength(entry.path, "utf8") > normalizedLimits.max_path_bytes) return false;
		if (previous !== undefined && byteCompare(previous, entry.path) >= 0) return false;
		previous = entry.path;
	}
	previous = undefined;
	for (const path of value.irrelevant_artifact_paths) {
		if (!isStrictWorkspaceGuardPath(path) || !isIrrelevantArtifactPath(path)) return false;
		if (Buffer.byteLength(path, "utf8") > normalizedLimits.max_path_bytes) return false;
		if (previous !== undefined && byteCompare(previous, path) >= 0) return false;
		previous = path;
	}
	if (!isPlainObject(value.meter) || !exactKeys(value.meter, [
		"status_bytes", "relevant_paths", "irrelevant_paths", "stat_calls", "content_bytes_read",
	])) return false;
	if (!safeCounter(value.meter.status_bytes)
		|| value.meter.status_bytes > normalizedLimits.max_status_bytes
		|| value.meter.relevant_paths !== value.entries.length
		|| value.meter.irrelevant_paths !== value.irrelevant_artifact_paths.length
		|| value.meter.stat_calls !== value.entries.length * 2
		|| value.meter.content_bytes_read !== 0) return false;
	if (typeof value.workspace_guard_hash !== "string" || !/^[0-9a-f]{64}$/u.test(value.workspace_guard_hash)) return false;
	return value.workspace_guard_hash === computeWorkspaceGuardHash(value.git_head, value.entries);
}

async function callFault(
	hooks: WorkspaceGuardHooks | undefined,
	point: WorkspaceGuardFaultPoint,
	path?: string,
): Promise<void> {
	await hooks?.fault?.(point, Object.freeze(path === undefined ? {} : { path }));
}

function validExecResult(value: unknown): value is Awaited<ReturnType<ExecFn>> {
	return isPlainObject(value)
		&& typeof value.code === "number"
		&& Number.isSafeInteger(value.code)
		&& bufferFromOutput(value.stdout) !== undefined
		&& typeof value.stderr === "string"
		&& typeof value.killed === "boolean";
}

function parseHead(stdout: Buffer): string | undefined {
	const text = stdout.toString("ascii").trim();
	return /^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(text) ? text : undefined;
}

/** Collect a deterministic lstat-only ChangeSet v2 workspace guard. */
export async function collectWorkspaceGuard(
	input: CollectWorkspaceGuardInput,
): Promise<CollectWorkspaceGuardResult> {
	const meter = emptyMeter();
	if (!input || typeof input !== "object" || typeof input.project_root !== "string" || typeof input.exec !== "function") {
		return failure("invalid_input", meter);
	}
	const limits = normalizeLimits(input.limits);
	if (!limits) return failure("invalid_input", meter);
	const projectRoot = resolve(input.project_root);
	if (!isAbsolute(projectRoot)) return failure("invalid_input", meter);

	let gitHead: string | null = null;
	try {
		await callFault(input.hooks, "head_before");
		const headResult = await input.exec("git", ["rev-parse", "HEAD"], { cwd: projectRoot });
		await callFault(input.hooks, "head_after");
		if (!validExecResult(headResult)) return failure("git_failure", meter);
		if (headResult.killed) return failure("git_failure", meter);
		if (headResult.code === 0) {
			const headBytes = bufferFromOutput(headResult.stdout)!;
			const parsedHead = parseHead(headBytes);
			if (parsedHead === undefined) return failure("git_failure", meter);
			gitHead = parsedHead;
		}
	} catch {
		return failure("git_failure", meter);
	}

	let statusBytes: Buffer;
	try {
		await callFault(input.hooks, "status_before");
		const statusResult = await input.exec(
			"git",
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
			{ cwd: projectRoot },
		);
		await callFault(input.hooks, "status_after");
		if (!validExecResult(statusResult) || statusResult.code !== 0 || statusResult.killed) return failure("git_failure", meter);
		statusBytes = bufferFromOutput(statusResult.stdout)!;
	} catch {
		return failure("git_failure", meter);
	}
	meter.status_bytes = statusBytes.length;
	if (statusBytes.length > limits.max_status_bytes) return failure("status_overflow", meter);
	const parsed = parseStatus(statusBytes, limits.max_path_bytes);
	if (!parsed) return failure("invalid_path", meter);

	const seen = new Set<string>();
	const relevant: ParsedStatusPath[] = [];
	const irrelevant: string[] = [];
	for (const item of parsed) {
		if (seen.has(item.path)) return failure("invalid_path", meter);
		seen.add(item.path);
		if (isIrrelevantArtifactPath(item.path)) irrelevant.push(item.path);
		else relevant.push(item);
	}
	if (irrelevant.length > limits.max_irrelevant_paths) return failure("path_overflow", meter);
	if (relevant.length > limits.max_relevant_paths) return failure("path_overflow", meter);
	relevant.sort((left, right) => byteCompare(left.path, right.path));
	irrelevant.sort(byteCompare);
	meter.relevant_paths = relevant.length;
	meter.irrelevant_paths = irrelevant.length;

	const adapter = input.stat_adapter ?? createNodeWorkspaceGuardStatAdapter();
	const before = new Map<string, WorkspaceGuardIdentity>();
	for (const item of relevant) {
		const absolute = resolve(projectRoot, ...item.path.split("/"));
		if (absolute === projectRoot || !absolute.startsWith(`${projectRoot}${sep}`)) return failure("invalid_path", meter);
		try {
			await callFault(input.hooks, "stat_before", item.path);
			meter.stat_calls += 1;
			const identity = identityFromStat(await adapter.lstat(absolute));
			if (!identity) return failure("stat_failure", meter);
			before.set(item.path, identity);
		} catch {
			return failure("stat_failure", meter);
		}
	}

	const entries: WorkspaceGuardEntry[] = [];
	for (const item of relevant) {
		const absolute = resolve(projectRoot, ...item.path.split("/"));
		let after: WorkspaceGuardIdentity | undefined;
		try {
			await callFault(input.hooks, "stat_after", item.path);
			meter.stat_calls += 1;
			after = identityFromStat(await adapter.lstat(absolute));
		} catch {
			return failure("stat_failure", meter);
		}
		if (!after) return failure("stat_failure", meter);
		const prior = before.get(item.path);
		if (!prior || !identityEqual(prior, after)) return failure("unstable", meter);
		entries.push(Object.freeze({ path: item.path, status: item.status, identity: prior }));
	}

	const frozenEntries = Object.freeze(entries);
	const frozenIrrelevant = Object.freeze([...irrelevant]);
	const frozenMeter = snapshotMeter(meter);
	const guard: WorkspaceGuardRecord = Object.freeze({
		schema_version: WORKSPACE_GUARD_SCHEMA_VERSION,
		git_head: gitHead,
		entries: frozenEntries,
		irrelevant_artifact_paths: frozenIrrelevant,
		meter: frozenMeter,
		workspace_guard_hash: computeWorkspaceGuardHash(gitHead, frozenEntries),
	});
	if (!validateWorkspaceGuard(guard, input.limits)) return failure("invalid_input", meter);
	return { ok: true, guard };
}
