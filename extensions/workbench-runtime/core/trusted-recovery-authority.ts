import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";

import {
	TOOL_RESULT_INGRESS_BUDGET_BYTES,
	TRUSTED_RECOVERY_AUTHORITY_SCHEMA,
	type TrustedRecoveryAuthority,
	type TrustedRecoverySourceKind,
	type TrustedRequiredFact,
	type TrustedRequiredFactValue,
} from "./tool-result-ingress-projection.ts";

export interface BuildTrustedRecoveryAuthorityInput {
	readonly projectRoot: string;
	readonly sourceKind: TrustedRecoverySourceKind;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly sourcePath: string;
	readonly requiredFacts: readonly TrustedRequiredFact[];
	/** Test-only race injection. Runtime callers must never supply this. */
	readonly testHooks?: {
		readonly afterInitialStat?: (snapshot: Readonly<TrustedRecoverySourceSnapshot>) => void | Promise<void>;
	};
}

interface TrustedRecoverySourceSnapshot {
	readonly byteLength: number;
	readonly modifiedNs: string;
	readonly changedNs: string;
	readonly device: number;
	readonly inode: number;
}

const EXPECTED_TOOL: Readonly<Record<TrustedRecoverySourceKind, string>> = Object.freeze({
	finalized_recipe_run: "workbench_run_recipe",
	executed_gate_run: "workbench_run_gate",
	immutable_comparison: "workbench_compare_runs",
	completed_worker_report: "workbench_delegate_worker",
	finalized_run_page: "workbench_read_run",
	run_id_gate_page: "workbench_read_gate",
});

const REQUIRED_FACT_KEYS: Readonly<Record<TrustedRecoverySourceKind, readonly string[]>> = Object.freeze({
	finalized_recipe_run: Object.freeze(["duration_ms", "exit_code", "recipe", "run_id", "status"]),
	executed_gate_run: Object.freeze(["gate_count", "run_id", "status"]),
	immutable_comparison: Object.freeze(["a_run_id", "b_run_id", "comparison_id", "compatible"]),
	completed_worker_report: Object.freeze(["delegation_id", "exit_code", "status", "turns"]),
	finalized_run_page: Object.freeze(["include", "log_stream", "page", "run_id"]),
	run_id_gate_page: Object.freeze(["include", "page", "run_id"]),
});

const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,191}$/;
const COMPARISON_ID = /^cmp1-[0-9a-f]{64}$/;
const INLINE = /^[^\u0000-\u001f\u007f\u2028\u2029]+$/u;
const SOURCE_PATH = /^[A-Za-z0-9._/+\-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_TOOL_CALL_ID_BYTES = 512;
const MAX_FACT_STRING_BYTES = 256;
/**
 * The largest trusted durable artifact is comparison.json, whose persistence
 * and authorized reader are both capped at 4 MiB. Gate/run records and worker
 * reports are capped lower. Unbounded logs above this ceiling stay on the
 * ordinary paged/fail-open path rather than being hashed without bound.
 */
export const TRUSTED_RECOVERY_SOURCE_MAX_BYTES = 4_194_304 as const;
const SOURCE_HASH_CHUNK_BYTES = 64 * 1_024;

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedInline(value: unknown, maximumBytes: number): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& Buffer.byteLength(value, "utf8") <= maximumBytes
		&& INLINE.test(value);
}

function safeRecordId(value: unknown): value is string {
	return typeof value === "string" && RECORD_ID.test(value);
}

function safeNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function safeExitCode(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0));
}

function safeFactValue(value: unknown): value is TrustedRequiredFactValue {
	if (value === null || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isSafeInteger(value) && !Object.is(value, -0);
	return boundedInline(value, MAX_FACT_STRING_BYTES)
		&& !value.startsWith("/")
		&& !/^[A-Za-z]:[\\/]/.test(value)
		&& !value.startsWith("\\\\");
}

function validFactValue(sourceKind: TrustedRecoverySourceKind, key: string, value: unknown): boolean {
	if (!safeFactValue(value)) return false;
	if (key === "run_id" || key === "delegation_id" || key === "a_run_id" || key === "b_run_id") {
		return safeRecordId(value);
	}
	if (key === "comparison_id") return typeof value === "string" && COMPARISON_ID.test(value);
	if (key === "duration_ms" || key === "gate_count" || key === "turns" || key === "page") {
		return safeNonNegativeInteger(value);
	}
	if (key === "exit_code") return safeExitCode(value);
	if (key === "compatible") return typeof value === "boolean";
	if (key === "recipe") return typeof value === "string" && RECORD_ID.test(value);
	if (key === "include") {
		return sourceKind === "finalized_run_page"
			? value === "summary" || value === "manifest" || value === "logs"
			: value === "summary" || value === "failures" || value === "checks";
	}
	if (key === "log_stream") return value === null || value === "stdout" || value === "stderr";
	if (key === "status") {
		if (sourceKind === "finalized_recipe_run") {
			return value === "OK" || value === "FAILED" || value === "TIMED OUT" || value === "CANCELLED";
		}
		if (sourceKind === "executed_gate_run") {
			return value === "PASS" || value === "FAIL" || value === "BLOCKED" || value === "NOT_RUN";
		}
		return sourceKind === "completed_worker_report" && value === "success";
	}
	return false;
}

function normalizedRequiredFacts(
	sourceKind: TrustedRecoverySourceKind,
	value: unknown,
): readonly TrustedRequiredFact[] | undefined {
	try {
		if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
		const rawLength: unknown = lengthDescriptor && Object.prototype.hasOwnProperty.call(lengthDescriptor, "value")
			? lengthDescriptor.value
			: undefined;
		if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 1 || rawLength > 16) return undefined;
		const length = rawLength;
		if (Reflect.ownKeys(value).length !== length + 1) return undefined;
		const facts: TrustedRequiredFact[] = [];
		for (let index = 0; index < length; index += 1) {
			const itemDescriptor = descriptors[String(index)];
			if (!itemDescriptor || itemDescriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(itemDescriptor, "value")) return undefined;
			const item = itemDescriptor.value;
			if (item === null || typeof item !== "object" || utilTypes.isProxy(item)) return undefined;
			const prototype = Object.getPrototypeOf(item);
			if (prototype !== Object.prototype && prototype !== null) return undefined;
			const itemDescriptors = Object.getOwnPropertyDescriptors(item);
			if (Reflect.ownKeys(item).length !== 2) return undefined;
			const keyDescriptor = itemDescriptors.key;
			const valueDescriptor = itemDescriptors.value;
			if (!keyDescriptor || !valueDescriptor
				|| keyDescriptor.enumerable !== true || valueDescriptor.enumerable !== true
				|| !Object.prototype.hasOwnProperty.call(keyDescriptor, "value")
				|| !Object.prototype.hasOwnProperty.call(valueDescriptor, "value")
				|| typeof keyDescriptor.value !== "string"
				|| !validFactValue(sourceKind, keyDescriptor.value, valueDescriptor.value)) return undefined;
			facts.push(Object.freeze({ key: keyDescriptor.value, value: valueDescriptor.value as TrustedRequiredFactValue }));
		}
		facts.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
		const expected = REQUIRED_FACT_KEYS[sourceKind];
		if (facts.length !== expected.length || facts.some((fact, index) => fact.key !== expected[index])) return undefined;
		return Object.freeze(facts);
	} catch {
		return undefined;
	}
}

function sourcePathMatches(sourceKind: TrustedRecoverySourceKind, sourcePath: string): boolean {
	if (Buffer.byteLength(sourcePath, "utf8") > 512
		|| !SOURCE_PATH.test(sourcePath)
		|| sourcePath.startsWith("/")
		|| sourcePath.includes("\\")) return false;
	const parts = sourcePath.split("/");
	if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return false;
	if (sourceKind === "immutable_comparison") {
		return parts.length === 5
			&& parts[0] === ".pi" && parts[1] === "workbench" && parts[2] === "comparisons"
			&& COMPARISON_ID.test(parts[3] ?? "") && parts[4] === "comparison.json";
	}
	if (sourceKind === "completed_worker_report") {
		return parts.length === 5
			&& parts[0] === ".pi" && parts[1] === "workbench" && parts[2] === "delegations"
			&& safeRecordId(parts[3]) && parts[4] === "worker-report.md";
	}
	if (parts.length !== 5
		|| parts[0] !== ".pi" || parts[1] !== "workbench" || parts[2] !== "runs"
		|| !safeRecordId(parts[3])) return false;
	if (sourceKind === "finalized_recipe_run") return parts[4] === "summary.json";
	if (sourceKind === "executed_gate_run" || sourceKind === "run_id_gate_page") return parts[4] === "gates.json";
	return sourceKind === "finalized_run_page"
		&& (parts[4] === "manifest.json" || parts[4] === "stdout.log" || parts[4] === "stderr.log");
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
	return left.isFile() === right.isFile()
		&& left.isSymbolicLink() === right.isSymbolicLink()
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs
		&& left.dev === right.dev
		&& left.ino === right.ino;
}

function safeIdentityPair(device: bigint, inode: bigint): { device: number; inode: number } | undefined {
	const maximum = BigInt(Number.MAX_SAFE_INTEGER);
	if (device < 0n || inode < 0n || device > maximum || inode > maximum) return undefined;
	return { device: Number(device), inode: Number(inode) };
}

function normalizedSourceSnapshot(stats: BigIntStats): TrustedRecoverySourceSnapshot | undefined {
	if (!stats.isFile()
		|| stats.isSymbolicLink()
		|| stats.size < 0n
		|| stats.size > BigInt(TRUSTED_RECOVERY_SOURCE_MAX_BYTES)
		|| stats.mtimeNs < 0n
		|| stats.ctimeNs < 0n) return undefined;
	const identity = safeIdentityPair(stats.dev, stats.ino);
	if (!identity) return undefined;
	const modifiedNs = stats.mtimeNs.toString(10);
	const changedNs = stats.ctimeNs.toString(10);
	if (modifiedNs.length > 32 || changedNs.length > 32) return undefined;
	return Object.freeze({
		byteLength: Number(stats.size),
		modifiedNs,
		changedNs,
		device: identity.device,
		inode: identity.inode,
	});
}

async function safeSourcePathSnapshot(
	realProjectRoot: string,
	sourcePath: string,
): Promise<{ absolutePath: string; stat: BigIntStats } | undefined> {
	const segments = sourcePath.split("/");
	let current = realProjectRoot;
	let targetStat: BigIntStats | undefined;
	for (let index = 0; index < segments.length; index += 1) {
		current = resolve(current, segments[index]!);
		if (current !== realProjectRoot && !current.startsWith(`${realProjectRoot}${sep}`)) return undefined;
		const stat = await lstat(current, { bigint: true });
		if (stat.isSymbolicLink()) return undefined;
		if (index < segments.length - 1) {
			if (!stat.isDirectory()) return undefined;
		} else {
			if (!stat.isFile()) return undefined;
			targetStat = stat;
		}
	}
	if (!targetStat || await realpath(current) !== current) return undefined;
	return { absolutePath: current, stat: targetStat };
}

async function openNoFollow(path: string): Promise<FileHandle | undefined> {
	const noFollow = constants.O_NOFOLLOW;
	const nonBlock = constants.O_NONBLOCK;
	if (typeof noFollow !== "number" || noFollow === 0
		|| typeof nonBlock !== "number" || nonBlock === 0) return undefined;
	try {
		// O_NOFOLLOW rejects a final symlink; O_NONBLOCK prevents an attacker
		// swapping the prechecked regular file to a FIFO and stalling this open.
		// The immediate same-handle fstat below still requires a regular file.
		return await open(path, constants.O_RDONLY | noFollow | nonBlock);
	} catch {
		return undefined;
	}
}

async function hashStableSource(
	handle: FileHandle,
	initialStat: BigIntStats,
	testHooks: BuildTrustedRecoveryAuthorityInput["testHooks"],
): Promise<{ digest: string; finalStat: BigIntStats; snapshot: TrustedRecoverySourceSnapshot } | undefined> {
	const snapshot = normalizedSourceSnapshot(initialStat);
	if (!snapshot) return undefined;
	await testHooks?.afterInitialStat?.(snapshot);
	const digest = createHash("sha256");
	const chunk = Buffer.allocUnsafe(Math.min(SOURCE_HASH_CHUNK_BYTES, Math.max(snapshot.byteLength, 1)));
	let offset = 0;
	while (offset < snapshot.byteLength) {
		const remaining = snapshot.byteLength - offset;
		const read = await handle.read(chunk, 0, Math.min(chunk.length, remaining), offset);
		if (read.bytesRead <= 0) return undefined;
		digest.update(chunk.subarray(0, read.bytesRead));
		offset += read.bytesRead;
	}
	const finalStat = await handle.stat({ bigint: true });
	if (!sameSnapshot(initialStat, finalStat) || !normalizedSourceSnapshot(finalStat)) return undefined;
	return { digest: digest.digest("hex"), finalStat, snapshot };
}

/**
 * Build one private recovery authority from an already-finalized durable
 * artifact. No absolute path, file content, command, payload, or prose is
 * retained: the source identity is a content-bound stable snapshot hash.
 */
export async function buildTrustedRecoveryAuthority(
	input: BuildTrustedRecoveryAuthorityInput,
): Promise<TrustedRecoveryAuthority | undefined> {
	try {
		if (!input || typeof input !== "object" || utilTypes.isProxy(input)) return undefined;
		const { projectRoot, sourceKind, toolCallId, toolName, sourcePath } = input;
		if (!boundedInline(projectRoot, 4_096)
			|| !Object.prototype.hasOwnProperty.call(EXPECTED_TOOL, sourceKind)
			|| EXPECTED_TOOL[sourceKind] !== toolName
			|| !boundedInline(toolCallId, MAX_TOOL_CALL_ID_BYTES)
			|| !sourcePathMatches(sourceKind, sourcePath)) return undefined;
		const requiredFacts = normalizedRequiredFacts(sourceKind, input.requiredFacts);
		if (!requiredFacts) return undefined;

		const realProjectRoot = await realpath(projectRoot);
		const rootStat = await lstat(realProjectRoot, { bigint: true });
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;
		const beforePath = await safeSourcePathSnapshot(realProjectRoot, sourcePath);
		if (!beforePath || !normalizedSourceSnapshot(beforePath.stat)) return undefined;
		const handle = await openNoFollow(beforePath.absolutePath);
		if (!handle) return undefined;
		try {
			const openedStat = await handle.stat({ bigint: true });
			if (!sameSnapshot(beforePath.stat, openedStat)) return undefined;
			const hashed = await hashStableSource(handle, openedStat, input.testHooks);
			if (!hashed || !SHA256.test(hashed.digest)) return undefined;
			const afterPath = await safeSourcePathSnapshot(realProjectRoot, sourcePath);
			if (!afterPath
				|| afterPath.absolutePath !== beforePath.absolutePath
				|| !sameSnapshot(hashed.finalStat, afterPath.stat)) return undefined;
			const { byteLength, modifiedNs, changedNs, device, inode } = hashed.snapshot;
			const snapshotId = sha256(JSON.stringify([
				"trusted-recovery-source-v2",
				sourcePath,
				hashed.digest,
				byteLength,
				modifiedNs,
				changedNs,
				device,
				inode,
			]));
			if (!SHA256.test(snapshotId)) return undefined;
			return Object.freeze({
				schema: TRUSTED_RECOVERY_AUTHORITY_SCHEMA,
				sourceKind,
				toolCallId,
				toolName,
				sourcePath,
				sourceIdentity: Object.freeze({
					kind: "snapshot" as const,
					snapshotId,
					byteLength,
					modifiedNs,
					device,
					inode,
				}),
				finalized: 1 as const,
				budgetBytes: TOOL_RESULT_INGRESS_BUDGET_BYTES,
				requiredFacts,
			});
		} finally {
			// Descriptor closure is part of successful authority construction; a
			// close failure overrides any pending result and fails closed.
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

/**
 * Strict private digest of the exact text-only provider content. The joined
 * LF text and the complete ordered block sequence are both bound, so block
 * replacement, insertion, removal, reordering, or segmentation fails closed.
 */
export function toolResultTextContentDigest(content: unknown): string | undefined {
	try {
		if (!Array.isArray(content) || utilTypes.isProxy(content) || Object.getPrototypeOf(content) !== Array.prototype) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(content);
		const lengthDescriptor = Object.getOwnPropertyDescriptor(content, "length");
		const rawLength: unknown = lengthDescriptor && Object.prototype.hasOwnProperty.call(lengthDescriptor, "value")
			? lengthDescriptor.value
			: undefined;
		if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 1 || rawLength > 1_024 || Reflect.ownKeys(content).length !== rawLength + 1) return undefined;
		const length = rawLength;
		const blocks: Array<readonly ["text", string]> = [];
		for (let index = 0; index < length; index += 1) {
			const descriptor = descriptors[String(index)];
			if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return undefined;
			const block = descriptor.value;
			if (block === null || typeof block !== "object" || utilTypes.isProxy(block)) return undefined;
			const prototype = Object.getPrototypeOf(block);
			if (prototype !== Object.prototype && prototype !== null) return undefined;
			const blockDescriptors = Object.getOwnPropertyDescriptors(block);
			if (Reflect.ownKeys(block).length !== 2) return undefined;
			const type = blockDescriptors.type;
			const text = blockDescriptors.text;
			if (!type || !text
				|| type.enumerable !== true || text.enumerable !== true
				|| !Object.prototype.hasOwnProperty.call(type, "value")
				|| !Object.prototype.hasOwnProperty.call(text, "value")
				|| type.value !== "text" || typeof text.value !== "string") return undefined;
			blocks.push(Object.freeze(["text", text.value] as const));
		}
		const joined = blocks.map((block) => block[1]).join("\n");
		return sha256(JSON.stringify({ joined, blocks }));
	} catch {
		return undefined;
	}
}
