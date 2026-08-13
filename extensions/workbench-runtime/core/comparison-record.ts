import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { sha256Hex } from "../cache/canonical-hash.ts";
import {
	BOUNDED_FILE_AUTHORIZED_MAX_BYTES,
	COMPARISON_RECORD_READ_AUTHORITY,
	readUtf8FileBounded,
	readUtf8FileWithExplicitHardCeiling,
} from "./bounded-file-io.ts";
import { workbenchDir } from "./config.ts";

export const COMPARISON_RECORD_MAX_BYTES = 4_194_304 as const;
export const COMPARISON_SUMMARY_RECORD_MAX_BYTES = 32_768 as const;
export const COMPARISON_RECORD_SCHEMA = "workbench-comparison-v1" as const;
export const COMPARISON_PERSIST_ERROR = "comparison_persist_error" as const;

const COMPARISONS_DIR = "comparisons";
const MAX_CANONICAL_DEPTH = 128;

if (COMPARISON_RECORD_MAX_BYTES !== BOUNDED_FILE_AUTHORIZED_MAX_BYTES) {
	throw new Error("comparison record read/write ceilings must remain identical");
}

export interface ComparisonRecordInput {
	a_identity: { run_id: string; recipe: string; started_at: string };
	b_identity: { run_id: string; recipe: string; started_at: string };
	a_manifest_digest: string;
	b_manifest_digest: string;
	report: unknown;
	summary: unknown;
}

export interface CompiledComparisonRecord {
	canonical: string;
	bytes: number;
	content_hash: string;
	comparison_id: string;
	summary_canonical: string;
	summary_bytes: number;
}

export type CompileComparisonRecordResult =
	| { ok: true; value: CompiledComparisonRecord }
	| { ok: false; code: typeof COMPARISON_PERSIST_ERROR };

export type PersistComparisonRecordResult =
	| {
		ok: true;
		comparison_id: string;
		content_hash: string;
		comparison_path: string;
		summary_path: string;
		bytes: number;
		summary_bytes: number;
		replayed: boolean;
	}
	| { ok: false; code: typeof COMPARISON_PERSIST_ERROR };

interface CanonicalWriter {
	chunks: string[];
	bytes: number;
	maxBytes: number;
	active: WeakSet<object>;
}

class CanonicalLimitError extends Error {}

function append(writer: CanonicalWriter, value: string): void {
	const bytes = Buffer.byteLength(value, "utf8");
	if (writer.bytes + bytes > writer.maxBytes) throw new CanonicalLimitError();
	writer.chunks.push(value);
	writer.bytes += bytes;
}

function serializeCanonical(value: unknown, writer: CanonicalWriter, depth: number): void {
	if (depth > MAX_CANONICAL_DEPTH) throw new CanonicalLimitError();
	if (value === null) { append(writer, "null"); return; }
	switch (typeof value) {
		case "string":
			append(writer, JSON.stringify(value));
			return;
		case "boolean":
			append(writer, value ? "true" : "false");
			return;
		case "number":
			if (!Number.isFinite(value)) throw new CanonicalLimitError();
			append(writer, JSON.stringify(value));
			return;
		case "object": {
			const object = value as object;
			if (writer.active.has(object)) throw new CanonicalLimitError();
			writer.active.add(object);
			try {
				if (Array.isArray(value)) {
					append(writer, "[");
					for (let index = 0; index < value.length; index += 1) {
						if (index > 0) append(writer, ",");
						serializeCanonical(value[index], writer, depth + 1);
					}
					append(writer, "]");
					return;
				}
				const descriptors = Object.getOwnPropertyDescriptors(value);
				const keys = Object.keys(descriptors)
					.filter((key) => descriptors[key]?.enumerable === true)
					.sort();
				append(writer, "{");
				for (let index = 0; index < keys.length; index += 1) {
					const key = keys[index];
					if (key === undefined) throw new CanonicalLimitError();
					const descriptor = descriptors[key];
					if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
						throw new CanonicalLimitError();
					}
					if (index > 0) append(writer, ",");
					append(writer, JSON.stringify(key));
					append(writer, ":");
					serializeCanonical(descriptor.value, writer, depth + 1);
				}
				append(writer, "}");
				return;
			} finally {
				writer.active.delete(object);
			}
		}
		default:
			throw new CanonicalLimitError();
	}
}

/** Deterministic, valid JSON that aborts before crossing the supplied byte cap. */
export function canonicalJsonWithin(value: unknown, maxBytes: number): { text: string; bytes: number } | null {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null;
	const writer: CanonicalWriter = { chunks: [], bytes: 0, maxBytes, active: new WeakSet<object>() };
	try {
		serializeCanonical(value, writer, 0);
		return { text: writer.chunks.join(""), bytes: writer.bytes };
	} catch {
		return null;
	}
}

export function compileComparisonRecord(input: ComparisonRecordInput): CompileComparisonRecordResult {
	const sources = {
		a: { identity: input.a_identity, manifest_digest: input.a_manifest_digest },
		b: { identity: input.b_identity, manifest_digest: input.b_manifest_digest },
	};
	const identity = canonicalJsonWithin({ schema: COMPARISON_RECORD_SCHEMA, sources }, 32_768);
	if (!identity) return { ok: false, code: COMPARISON_PERSIST_ERROR };
	const identityHash = sha256Hex(identity.text);
	const comparisonId = `cmp1-${identityHash}`;
	const payload = {
		schema: COMPARISON_RECORD_SCHEMA,
		schema_version: 1,
		comparison_id: comparisonId,
		sources,
		report: input.report,
	};
	const canonical = canonicalJsonWithin(payload, COMPARISON_RECORD_MAX_BYTES);
	if (!canonical) return { ok: false, code: COMPARISON_PERSIST_ERROR };
	const summary = canonicalJsonWithin({
		schema: "workbench-comparison-summary-v1",
		schema_version: 1,
		comparison_id: comparisonId,
		sources,
		comparison_file: "comparison.json",
		summary: input.summary,
	}, COMPARISON_SUMMARY_RECORD_MAX_BYTES);
	if (!summary) return { ok: false, code: COMPARISON_PERSIST_ERROR };
	return {
		ok: true,
		value: {
			canonical: canonical.text,
			bytes: canonical.bytes,
			content_hash: sha256Hex(canonical.text),
			comparison_id: comparisonId,
			summary_canonical: summary.text,
			summary_bytes: summary.bytes,
		},
	};
}

function relativeRecordPath(projectRoot: string, comparisonId: string, fileName: string): string {
	return relative(resolve(projectRoot), join(workbenchDir(projectRoot), COMPARISONS_DIR, comparisonId, fileName))
		.split("\\")
		.join("/");
}

function isNodeError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error
		&& (error as { code?: unknown }).code === code;
}

/**
 * Publish comparison.json + summary.json by atomically renaming one complete
 * temporary directory. An existing target is accepted only when both files
 * are regular and byte-identical; every other failure returns one fixed code.
 */
export async function persistComparisonRecord(
	projectRoot: string,
	input: ComparisonRecordInput,
): Promise<PersistComparisonRecordResult> {
	const compiled = compileComparisonRecord(input);
	if (!compiled.ok) return compiled;
	const parent = join(workbenchDir(projectRoot), COMPARISONS_DIR);
	const targetDir = join(parent, compiled.value.comparison_id);
	const comparisonTarget = join(targetDir, "comparison.json");
	const summaryTarget = join(targetDir, "summary.json");
	let tmpDir: string | undefined;
	const success = (replayed: boolean): PersistComparisonRecordResult => ({
		ok: true,
		comparison_id: compiled.value.comparison_id,
		content_hash: compiled.value.content_hash,
		comparison_path: relativeRecordPath(projectRoot, compiled.value.comparison_id, "comparison.json"),
		summary_path: relativeRecordPath(projectRoot, compiled.value.comparison_id, "summary.json"),
		bytes: compiled.value.bytes,
		summary_bytes: compiled.value.summary_bytes,
		replayed,
	});
	const existingReplay = async (): Promise<PersistComparisonRecordResult> => {
		const [comparisonStats, summaryStats] = await Promise.all([
			lstat(comparisonTarget).catch(() => null),
			lstat(summaryTarget).catch(() => null),
		]);
		if (!comparisonStats?.isFile() || !summaryStats?.isFile()
			|| (comparisonStats.mode & 0o777) !== 0o600
			|| (summaryStats.mode & 0o777) !== 0o600) {
			return { ok: false, code: COMPARISON_PERSIST_ERROR };
		}
		const [comparison, summary] = await Promise.all([
			readUtf8FileWithExplicitHardCeiling(
				comparisonTarget,
				COMPARISON_RECORD_MAX_BYTES,
				COMPARISON_RECORD_READ_AUTHORITY,
			),
			readUtf8FileBounded(summaryTarget, COMPARISON_SUMMARY_RECORD_MAX_BYTES),
		]);
		return comparison.ok && summary.ok
			&& comparison.value.text === compiled.value.canonical
			&& summary.value.text === compiled.value.summary_canonical
			? success(true)
			: { ok: false, code: COMPARISON_PERSIST_ERROR };
	};
	try {
		await mkdir(parent, { recursive: true, mode: 0o700 });
		const targetStats = await lstat(targetDir).catch(() => null);
		if (targetStats !== null) return targetStats.isDirectory()
			? await existingReplay()
			: { ok: false, code: COMPARISON_PERSIST_ERROR };
		tmpDir = join(parent, `.${compiled.value.comparison_id}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
		await mkdir(tmpDir, { mode: 0o700 });
		await Promise.all([
			writeFile(join(tmpDir, "comparison.json"), compiled.value.canonical, { encoding: "utf8", mode: 0o600 }),
			writeFile(join(tmpDir, "summary.json"), compiled.value.summary_canonical, { encoding: "utf8", mode: 0o600 }),
		]);
		try {
			await rename(tmpDir, targetDir);
			tmpDir = undefined;
			return success(false);
		} catch (error) {
			if (!isNodeError(error, "EEXIST") && !isNodeError(error, "ENOTEMPTY")) {
				return { ok: false, code: COMPARISON_PERSIST_ERROR };
			}
			return await existingReplay();
		}
	} catch {
		return { ok: false, code: COMPARISON_PERSIST_ERROR };
	} finally {
		if (tmpDir !== undefined) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}
