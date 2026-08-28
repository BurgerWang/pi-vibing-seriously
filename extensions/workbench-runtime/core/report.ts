/**
 * Persisted run/gate report readers.
 *
 * Domain records are authoritative, but every read is size-preflighted on one
 * file handle and every presentation produced here is globally bounded.
 */

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { readJsonFileBounded, type BoundedFileErrorCode, type BoundedFileIoHooks } from "./bounded-file-io.ts";
import {
	computeFileSourceId,
	decodeContinuationCursor,
	encodeContinuationCursor,
	validateFileCursorSource,
	type FileSourceSnapshot,
} from "./continuation-cursor.ts";
import { runsDir } from "./config.ts";
import {
	GATE_AUTHORITY_RECORD_MAX_BYTES,
	GATE_SCHEMA_VERSION,
	readPersistedGateRunFacts,
	validatePersistedGateRunRecords,
} from "./gate-engine.ts";
import type { Gate, GateStatus } from "./gate-schema.ts";
import { runStatusLabel } from "./format.ts";
import { validateQuantResult, type QuantResultValidation } from "./quant-result.ts";
import { parseGateCandidateBindingV1, type GateCandidateBindingV1 } from "./candidate-binding.ts";
import { displayRelative } from "./recipe-runner.ts";
import {
	isValidRunId,
	isPureLegacyRunForDiagnostic,
	iterateGateRunCandidates,
	listRuns,
	readCommittedManifest,
	readManifest,
	type GateRunCandidate,
	type GateRunCandidateHooks,
	type RunRecord,
} from "./runs.ts";
import { DEFAULT_RESULT_MAX_BYTES, DEFAULT_RESULT_MAX_LINES, clampWholeResultText } from "./output-policy.ts";

export const GATE_RECORD_MAX_BYTES = 1_048_576 as const;
export const GATE_READ_MAX_BYTES = 24_576 as const;
export const GATE_READ_MAX_LINES = 320 as const;
export const RUN_REPORT_MAX_BYTES = 24_576 as const;
export const RUN_REPORT_MAX_LINES = 320 as const;
export const GATE_EVIDENCE_RECORD_MAX_BYTES = 1_048_576 as const;
export const GATE_EVIDENCE_OUTPUT_MAX_BYTES = DEFAULT_RESULT_MAX_BYTES;
export const GATE_EVIDENCE_OUTPUT_MAX_LINES = DEFAULT_RESULT_MAX_LINES;

const GATE_EVIDENCE_MAX_SHOWN_CHECKS = 96;
const GATE_EVIDENCE_MAX_ITEMS_PER_CHECK = 4;

const GATE_SOURCE = ".pi/workbench/gates.yaml + builtin ladder";
const LEGACY_GATE_RERUN_REASON = "historical pre-transaction Gate run (schema v1) is read-only and has no committed v2 identity; rerun /q-gate all";
const STATUS = new Set<GateStatus>(["PASS", "FAIL", "BLOCKED", "NOT_RUN"]);
const CONTROL = /[\x00-\x1f\x7f]/g;

export interface GateRecordCheck {
	check_id: string;
	status: GateStatus;
	kind: string;
	failure_reason: string | null;
	blocked_reason: string | null;
}

export interface GateRecordGate {
	id: string;
	status: GateStatus;
	title: string;
	failure_reason: string | null;
	blocked_reason: string | null;
	checks: GateRecordCheck[];
}

export interface GateFileRecord {
	schema_version: number;
	run_id: string;
	requested: string[];
	profile: string | undefined;
	mode: string;
	candidate_binding?: GateCandidateBindingV1;
	gates: GateRecordGate[];
}

export type GateRecordUnavailableCode =
	| "gate_record_unavailable"
	| "source_oversized"
	| "source_not_regular"
	| "invalid_record";

export type GateFileRecordRead =
	| { ok: true; record: GateFileRecord; source: FileSourceSnapshot; bytes: number; sourcePath: string }
	| { ok: false; code: GateRecordUnavailableCode; reason: string };

export interface GateRunSummary {
	run_id: string;
	status: GateStatus;
	record_state: "AVAILABLE" | "UNAVAILABLE";
	requested: string[];
	profile: string | undefined;
	candidate_identity: string | null;
	counts: { pass: number; fail: number; blocked: number; not_run: number };
	gates: { id: string; status: GateStatus; title: string; failure_reason: string | null; blocked_reason: string | null }[];
	worst_gate: { id: string; status: GateStatus } | null;
	blocking_reason: string | null;
}

export type LatestGateStatusView = GateStatus | "UNKNOWN";

export interface LatestGateStatusRecord {
	status: LatestGateStatusView;
	run_id: string;
	unavailable_reason?: string;
}

export interface LatestGateQueryHooks extends GateRunCandidateHooks {
	/** Test/diagnostic hook: a candidate is undergoing strict authority validation. */
	onCandidateValidation?(runId: string): void;
}

export type GateReadInclude = "summary" | "failures" | "checks";

export interface GateReadPageDetails {
	run_id?: string;
	gate_id?: string;
	latest_status?: LatestGateStatusView;
	latest_run?: string | null;
	include: GateReadInclude;
	shown_count: number;
	remaining_count: number;
	next_cursor?: string;
	source_path: string;
	authority_kind?: "committed-v2" | "diagnostic";
}

export type GateReadPageResult =
	| { ok: true; text: string; details: GateReadPageDetails }
	| { ok: false; code: string; text: string; details: { error: string; source_path?: string } };

const GATE_STATUS_ORDER: Record<GateStatus, number> = { PASS: 0, NOT_RUN: 1, BLOCKED: 2, FAIL: 3 };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function nullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function gateStatus(value: unknown): value is GateStatus {
	return typeof value === "string" && STATUS.has(value as GateStatus);
}

function parseCheck(value: unknown): GateRecordCheck | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.check_id !== "string"
		|| !gateStatus(value.status)
		|| typeof value.kind !== "string"
		|| !nullableString(value.failure_reason)
		|| !nullableString(value.blocked_reason)
	) return undefined;
	return {
		check_id: value.check_id,
		status: value.status,
		kind: value.kind,
		failure_reason: value.failure_reason,
		blocked_reason: value.blocked_reason,
	};
}

function parseGate(value: unknown): GateRecordGate | undefined {
	if (!isRecord(value) || !Array.isArray(value.checks)) return undefined;
	if (
		typeof value.id !== "string"
		|| typeof value.title !== "string"
		|| !gateStatus(value.status)
		|| !nullableString(value.failure_reason)
		|| !nullableString(value.blocked_reason)
	) return undefined;
	const checks: GateRecordCheck[] = [];
	for (const candidate of value.checks) {
		const parsed = parseCheck(candidate);
		if (!parsed) return undefined;
		checks.push(parsed);
	}
	return {
		id: value.id,
		status: value.status,
		title: value.title,
		failure_reason: value.failure_reason,
		blocked_reason: value.blocked_reason,
		checks,
	};
}

function parseGateRecord(value: unknown, runId: string): GateFileRecord | undefined {
	if (!isRecord(value) || !Array.isArray(value.gates)) return undefined;
	if (
		value.run_id !== runId
		|| value.schema_version !== GATE_SCHEMA_VERSION
		|| !stringArray(value.requested)
		|| !(value.profile === undefined || typeof value.profile === "string")
		|| typeof value.mode !== "string"
	) return undefined;
	const gates: GateRecordGate[] = [];
	const candidateBinding = value.candidate_binding === undefined ? undefined : parseGateCandidateBindingV1(value.candidate_binding);
	if (value.candidate_binding !== undefined && candidateBinding === null) return undefined;
	for (const candidate of value.gates) {
		const parsed = parseGate(candidate);
		if (!parsed) return undefined;
		gates.push(parsed);
	}
	return {
		schema_version: GATE_SCHEMA_VERSION,
		run_id: runId,
		requested: [...value.requested],
		profile: value.profile,
		mode: value.mode,
		candidate_binding: candidateBinding ?? undefined,
		gates,
	};
}

function unavailableCode(code: BoundedFileErrorCode): GateRecordUnavailableCode {
	if (code === "source_oversized") return "source_oversized";
	if (code === "source_not_regular") return "source_not_regular";
	if (code === "invalid_json" || code === "invalid_utf8") return "invalid_record";
	return "gate_record_unavailable";
}

function unavailableReason(code: GateRecordUnavailableCode): string {
	switch (code) {
		case "source_oversized": return "gate record unavailable: source_oversized";
		case "source_not_regular": return "gate record unavailable: source_not_regular";
		case "invalid_record": return "gate record unavailable: invalid_record";
		default: return "gate record unavailable";
	}
}

/** Same-open, bounded and strictly validated gates.json reader. */
export async function readGateFileRecordWithReason(projectRoot: string, runId: string): Promise<GateFileRecordRead> {
	const sourcePath = displayRelative(projectRoot, join(runsDir(projectRoot), runId, "gates.json"));
	const read = await readJsonFileBounded(join(runsDir(projectRoot), runId, "gates.json"), GATE_RECORD_MAX_BYTES);
	if (!read.ok) {
		const code = unavailableCode(read.error.code);
		return { ok: false, code, reason: unavailableReason(code) };
	}
	const record = parseGateRecord(read.value.value, runId);
	if (!record) return { ok: false, code: "invalid_record", reason: unavailableReason("invalid_record") };
	return { ok: true, record, source: read.value.source, bytes: read.value.bytes, sourcePath };
}

/** Compatibility API: callers that do not need a reason still receive null. */
export async function readGateFileRecord(projectRoot: string, runId: string): Promise<GateFileRecord | null> {
	const result = await readGateFileRecordWithReason(projectRoot, runId);
	return result.ok ? result.record : null;
}

type StrictGateCandidateRead =
	| { ok: true; record: GateFileRecord }
	| { ok: false; reason: string };

async function readStrictGateCandidate(
	projectRoot: string,
	runId: string,
	hooks?: LatestGateQueryHooks,
	source?: GateRunCandidate["source"],
	indexedStartedAt?: string,
): Promise<StrictGateCandidateRead> {
	hooks?.onCandidateValidation?.(runId);
	if (source === "marker-invalid") return { ok: false, reason: "gate attempt marker unavailable or invalid" };
	const manifest = await readCommittedManifest(projectRoot, runId);
	if (!manifest) {
		// Only an unindexed, strictly readable, marker-free schema-v1 record gets
		// the upgrade-specific diagnosis. Crash markers, corrupt/mixed v2 runs,
		// and every uncertain classification retain the generic fail-closed reason.
		if (source === "manifest" && await isPureLegacyRunForDiagnostic(projectRoot, runId)) {
			return { ok: false, reason: LEGACY_GATE_RERUN_REASON };
		}
		return { ok: false, reason: "committed run identity unavailable" };
	}
	if (manifest.recipe !== "gate") return { ok: false, reason: "indexed run is not a gate run" };
	if (source === "marker" && indexedStartedAt !== undefined && manifest.started_at !== indexedStartedAt) {
		return { ok: false, reason: "gate attempt marker start identity mismatch" };
	}
	const record = await readGateFileRecordWithReason(projectRoot, runId);
	if (!record.ok) return { ok: false, reason: record.reason };
	if (!await readPersistedGateRunFacts(projectRoot, runId, manifest)) {
		return { ok: false, reason: "gate authority semantics invalid" };
	}
	if (!await readCommittedManifest(projectRoot, runId)) {
		return { ok: false, reason: "committed run identity changed during gate authority read" };
	}
	return { ok: true, record: record.record };
}

function summarizeGateRecord(record: GateFileRecord): GateRunSummary {
	const gates = record.gates;
	const counts = {
		pass: gates.filter((gate) => gate.status === "PASS").length,
		fail: gates.filter((gate) => gate.status === "FAIL").length,
		blocked: gates.filter((gate) => gate.status === "BLOCKED").length,
		not_run: gates.filter((gate) => gate.status === "NOT_RUN").length,
	};
	let worst: { id: string; status: GateStatus } | null = null;
	for (const gate of gates) {
		if (!worst || GATE_STATUS_ORDER[gate.status] > GATE_STATUS_ORDER[worst.status]) worst = { id: gate.id, status: gate.status };
	}
	const worstGate = worst ? gates.find((gate) => gate.id === worst.id) : undefined;
	return {
		run_id: record.run_id,
		status: counts.fail > 0 ? "FAIL" : counts.blocked > 0 ? "BLOCKED" : counts.not_run > 0 ? "NOT_RUN" : "PASS",
		record_state: "AVAILABLE",
		requested: record.requested,
		profile: record.profile,
		candidate_identity: record.candidate_binding?.candidate_identity ?? null,
		counts,
		gates: gates.map(({ checks: _checks, ...gate }) => gate),
		worst_gate: worst,
		blocking_reason: worstGate?.blocked_reason ?? worstGate?.failure_reason ?? null,
	};
}

function unavailableGateSummary(runId: string, reason: string): GateRunSummary {
	return {
		run_id: runId,
		status: "BLOCKED",
		record_state: "UNAVAILABLE",
		requested: [],
		profile: undefined,
		candidate_identity: null,
		counts: { pass: 0, fail: 0, blocked: 0, not_run: 0 },
		gates: [],
		worst_gate: { id: "record", status: "BLOCKED" },
		blocking_reason: `latest gate run unavailable: ${reason}; older status not used`,
	};
}

/**
 * Summary of the newest gate run. Immutable pre-execution attempt markers
 * make the normal read independent of unrelated run-history size; old
 * repositories fall back to the cached lazy catalog. A damaged newest
 * candidate is surfaced as BLOCKED and never skipped for an older PASS.
 */
export async function latestGateRunSummary(
	projectRoot: string,
	hooks?: LatestGateQueryHooks,
): Promise<GateRunSummary | null> {
	for await (const candidate of iterateGateRunCandidates(projectRoot, { hooks })) {
		const read = await readStrictGateCandidate(projectRoot, candidate.run_id, hooks, candidate.source, candidate.started_at);
		return read.ok
			? summarizeGateRecord(read.record)
			: unavailableGateSummary(candidate.run_id, read.reason);
	}
	return null;
}

/**
 * Resolve latest statuses for many ids with one bounded pass over persisted
 * gate records. This avoids the legacy per-id full-file reader.
 */
export async function latestGateStatuses(
	projectRoot: string,
	gateIds: readonly string[],
	hooks?: LatestGateQueryHooks,
): Promise<Record<string, LatestGateStatusRecord>> {
	const wanted = new Set(gateIds);
	const found: Record<string, LatestGateStatusRecord> = {};
	if (wanted.size === 0) return found;
	const markUnavailable = (runId: string, reason: string): void => {
		for (const gateId of wanted) {
			if (!Object.prototype.hasOwnProperty.call(found, gateId)) {
				found[gateId] = { status: "UNKNOWN", run_id: runId, unavailable_reason: reason };
			}
		}
	};
	const accept = (record: GateFileRecord): boolean => {
		for (const gate of record.gates) {
			if (!wanted.has(gate.id) || Object.prototype.hasOwnProperty.call(found, gate.id)) continue;
			found[gate.id] = { status: gate.status, run_id: record.run_id };
		}
		return Object.keys(found).length === wanted.size;
	};
	for await (const candidate of iterateGateRunCandidates(projectRoot, { hooks })) {
		const read = await readStrictGateCandidate(projectRoot, candidate.run_id, hooks, candidate.source, candidate.started_at);
		if (!read.ok) {
			markUnavailable(candidate.run_id, read.reason);
			return found;
		}
		if (accept(read.record)) return found;
	}
	return found;
}

// ---------------------------------------------------------------------------
// Gate evidence authority reader + bounded slash-command presentation
// ---------------------------------------------------------------------------

interface GateEvidenceItem {
	type: string;
	detail: string;
}

interface GateEvidenceCheck {
	checkId: string;
	status: GateStatus;
	kind: string;
	evidence: GateEvidenceItem[];
}

export type GateEvidenceViewResult =
	| { ok: true; text: string; sourcePath: string; checkCount: number; shownCount: number }
	| { ok: false; code: "gate_evidence_unavailable" | "source_oversized" | "source_not_regular" | "invalid_record" | "committed_run_identity_unavailable"; text: string; sourcePath: string };

function parseEvidenceChecks(value: unknown, runId: string): GateEvidenceCheck[] | undefined {
	if (!isRecord(value) || value.schema_version !== GATE_SCHEMA_VERSION || value.run_id !== runId) return undefined;
	if (!stringArray(value.requested) || value.requested.length > 500 || value.requested.some((entry) => entry.length > 200)) return undefined;
	if (!(value.profile === undefined || (typeof value.profile === "string" && value.profile.length <= 200))) return undefined;
	if (typeof value.mode !== "string" || value.mode.length > 200 || !isRecord(value.checks)) return undefined;
	const checks: GateEvidenceCheck[] = [];
	for (const [key, candidate] of Object.entries(value.checks)) {
		if (!isRecord(candidate) || candidate.check_id !== key || key.length === 0 || key.length > 200) return undefined;
		if (!gateStatus(candidate.status) || typeof candidate.kind !== "string" || candidate.kind.length > 200 || !Array.isArray(candidate.evidence)) return undefined;
		const evidence: GateEvidenceItem[] = [];
		for (const raw of candidate.evidence) {
			if (!isRecord(raw) || typeof raw.type !== "string" || typeof raw.detail !== "string") return undefined;
			evidence.push({ type: raw.type, detail: raw.detail });
		}
		checks.push({ checkId: key, status: candidate.status, kind: candidate.kind, evidence });
	}
	return checks;
}

function gateEvidenceUnavailableCode(code: BoundedFileErrorCode): "gate_evidence_unavailable" | "source_oversized" | "source_not_regular" | "invalid_record" {
	if (code === "source_oversized") return "source_oversized";
	if (code === "source_not_regular") return "source_not_regular";
	if (code === "invalid_json" || code === "invalid_utf8") return "invalid_record";
	return "gate_evidence_unavailable";
}

function fixedEvidenceFailure(
	code: "gate_evidence_unavailable" | "source_oversized" | "source_not_regular" | "invalid_record" | "committed_run_identity_unavailable",
	sourcePath: string,
): GateEvidenceViewResult {
	const text = clampWholeResultText(
		`gate evidence unavailable: ${code}\nfull record: ${sourcePath}`,
		{ maxBytes: GATE_EVIDENCE_OUTPUT_MAX_BYTES, maxLines: GATE_EVIDENCE_OUTPUT_MAX_LINES },
	).text;
	return { ok: false, code, text, sourcePath };
}

/** Same-open bounded evidence.json reader with a strict schema and whole-result clamp. */
export async function readGateEvidenceView(
	projectRoot: string,
	runId: string,
	hooks?: BoundedFileIoHooks,
	options: { requireCommittedAuthority?: boolean } = {},
): Promise<GateEvidenceViewResult> {
	const sourcePath = displayRelative(projectRoot, join(runsDir(projectRoot), runId, "evidence.json"));
	if (!isValidRunId(runId)) return fixedEvidenceFailure("invalid_record", sourcePath);
	const manifest = options.requireCommittedAuthority === true
		? await readCommittedManifest(projectRoot, runId)
		: null;
	if (options.requireCommittedAuthority === true && (!manifest || manifest.recipe !== "gate")) {
		return fixedEvidenceFailure("committed_run_identity_unavailable", sourcePath);
	}
	const read = await readJsonFileBounded(join(runsDir(projectRoot), runId, "evidence.json"), GATE_EVIDENCE_RECORD_MAX_BYTES, hooks);
	if (!read.ok) return fixedEvidenceFailure(gateEvidenceUnavailableCode(read.error.code), sourcePath);
	if (manifest) {
		const gatesRead = await readJsonFileBounded(
			join(runsDir(projectRoot), runId, "gates.json"),
			GATE_AUTHORITY_RECORD_MAX_BYTES,
		);
		if (!gatesRead.ok || !validatePersistedGateRunRecords(runId, manifest, gatesRead.value.value, read.value.value)) {
			return fixedEvidenceFailure("invalid_record", sourcePath);
		}
		// The final inventory verification covers both exact files read above;
		// an in-place change can never turn their diagnostic contents into v2
		// authority after the initial transaction check.
		if (!await readCommittedManifest(projectRoot, runId)) {
			return fixedEvidenceFailure("committed_run_identity_unavailable", sourcePath);
		}
	}
	const checks = parseEvidenceChecks(read.value.value, runId);
	if (!checks) return fixedEvidenceFailure("invalid_record", sourcePath);

	const rows: string[] = [];
	for (const check of checks.slice(0, GATE_EVIDENCE_MAX_SHOWN_CHECKS)) {
		const items = check.evidence.slice(0, GATE_EVIDENCE_MAX_ITEMS_PER_CHECK).map((entry) => `${inline(entry.type, 64)}:${inline(entry.detail, 256)}`);
		const omitted = check.evidence.length - items.length;
		rows.push(`  ${inline(check.checkId, 128).padEnd(8)} ${check.status.padEnd(8)} ${inline(check.kind, 64).padEnd(8)} ${items.join(" | ") || "(no evidence)"}${omitted > 0 ? ` | (+${omitted} evidence item(s) omitted)` : ""}`);
	}
	// Reuse the single whole-result clamp as a fit predicate so the emitted
	// shown/omitted facts describe actual rows, never a pre-clamp estimate.
	for (let shownCount = rows.length; shownCount >= 0; shownCount -= 1) {
		const lines = [
			`evidence for gate run ${runId} (${checks.length} check record(s)):` ,
			`full record: ${sourcePath}`,
			`display: shown=${shownCount} omitted=${checks.length - shownCount} max_evidence_items_per_check=${GATE_EVIDENCE_MAX_ITEMS_PER_CHECK}`,
			"",
			...rows.slice(0, shownCount),
		];
		const clamped = clampWholeResultText(lines.join("\n"), {
			maxBytes: GATE_EVIDENCE_OUTPUT_MAX_BYTES,
			maxLines: GATE_EVIDENCE_OUTPUT_MAX_LINES,
		});
		if (!clamped.truncated && !clamped.failed) {
			return { ok: true, text: clamped.text, sourcePath, checkCount: checks.length, shownCount };
		}
	}
	return fixedEvidenceFailure("gate_evidence_unavailable", sourcePath);
}

// ---------------------------------------------------------------------------
// Gate semantic paging
// ---------------------------------------------------------------------------

function scalarPrefix(value: string, maxBytes: number): string {
	let output = "";
	let used = 0;
	for (const scalar of value) {
		const size = Buffer.byteLength(scalar, "utf8");
		if (used + size > maxBytes) break;
		output += scalar;
		used += size;
	}
	return output;
}

function inline(value: unknown, maxBytes = 512): string {
	const clean = (typeof value === "string" ? value : "").replace(CONTROL, " ");
	if (Buffer.byteLength(clean, "utf8") <= maxBytes) return clean;
	if (maxBytes < 3) return scalarPrefix(clean, maxBytes);
	return `${scalarPrefix(clean, maxBytes - 3)}…`;
}

function byteLength(lines: readonly string[]): number {
	return Buffer.byteLength(lines.join("\n"), "utf8");
}

function fixedPageFailure(code: string, sourcePath?: string): GateReadPageResult {
	const text = `workbench_read_gate: ${inline(code, 128)}${sourcePath ? ` source=${inline(sourcePath, 512)}` : ""}`;
	return { ok: false, code, text, details: { error: code, ...(sourcePath ? { source_path: sourcePath } : {}) } };
}

function makeCursor(input: {
	sourceId: string;
	source: FileSourceSnapshot;
	offset: number;
}): string | undefined {
	const encoded = encodeContinuationCursor({
		v: input.source.mtimeNs === undefined ? 1 : 2,
		kind: "gate-read",
		sourceId: input.sourceId,
		byteOffset: input.offset,
		lineNumber: input.offset + 1,
		fileSize: input.source.fileSize,
		mtimeMs: input.source.mtimeMs,
		...(input.source.mtimeNs === undefined ? {} : { mtimeNs: input.source.mtimeNs }),
		...(input.source.dev === undefined ? {} : { dev: input.source.dev, ino: input.source.ino }),
	});
	return encoded.ok ? encoded.value : undefined;
}

function resolvePageOffset(input: {
	cursor?: string;
	sourceId: string;
	source: FileSourceSnapshot;
	totalRows: number;
}): { ok: true; offset: number } | { ok: false; code: string } {
	if (input.cursor === undefined) return { ok: true, offset: 0 };
	const decoded = decodeContinuationCursor(input.cursor);
	if (!decoded.ok) return { ok: false, code: decoded.error.code };
	const validated = validateFileCursorSource({
		payload: decoded.value,
		expectedKind: "gate-read",
		expectedSourceId: input.sourceId,
		currentSnapshot: input.source,
	});
	if (!validated.ok) return { ok: false, code: validated.error.code };
	if (validated.value.lineNumber !== validated.value.byteOffset + 1 || validated.value.byteOffset > input.totalRows) {
		return { ok: false, code: "invalid_cursor" };
	}
	return { ok: true, offset: validated.value.byteOffset };
}

function packSemanticPage(input: {
	headerLines: string[];
	compactHeader: string;
	rows: string[];
	offset: number;
	maxBytes: number;
	maxLines: number;
	sourcePath: string;
	sourceId: string;
	source: FileSourceSnapshot;
}): { text: string; shown: number; remaining: number; nextCursor?: string } | undefined {
	const remainingRows = Math.max(0, input.rows.length - input.offset);
	const source = inline(input.sourcePath, 512);
	// Tiny caller line caps still make forward progress when one COMPLETE
	// semantic row plus every replay fact fits the exact allocation. Never
	// prefix-cut this line and then advance past a partially visible row.
	if (input.maxLines <= input.headerLines.length + 2) {
		for (const shown of remainingRows > 0 ? [1] : [0]) {
			const nextOffset = input.offset + shown;
			const nextCursor = nextOffset < input.rows.length
				? makeCursor({ sourceId: input.sourceId, source: input.source, offset: nextOffset })
				: undefined;
			if (nextOffset < input.rows.length && !nextCursor) return undefined;
			const row = shown > 0 ? ` row=${input.rows[input.offset]}` : "";
			const line = `${inline(input.compactHeader, 768)}${row} page_offset=${input.offset} shown=${shown} remaining=${input.rows.length - nextOffset}${nextCursor ? ` next_cursor=${nextCursor}` : ""} source=${source}`;
			if (Buffer.byteLength(line, "utf8") <= input.maxBytes) {
				return { text: line, shown, remaining: input.rows.length - nextOffset, ...(nextCursor ? { nextCursor } : {}) };
			}
		}
		return undefined;
	}

	const maximum = Math.min(remainingRows, input.maxLines - input.headerLines.length - 2);
	for (let shown = maximum; shown >= 0; shown -= 1) {
		if (shown === 0 && remainingRows > 0) continue;
		const nextOffset = input.offset + shown;
		const nextCursor = nextOffset < input.rows.length
			? makeCursor({ sourceId: input.sourceId, source: input.source, offset: nextOffset })
			: undefined;
		if (nextOffset < input.rows.length && !nextCursor) return undefined;
		const pageLine = `page: offset=${input.offset} shown=${shown} omitted_before=${input.offset} remaining=${input.rows.length - nextOffset}${nextCursor ? ` next_cursor=${nextCursor}` : ""}`;
		const lines = [
			...input.headerLines,
			...input.rows.slice(input.offset, nextOffset),
			pageLine,
			`source: ${source}`,
		];
		if (lines.length <= input.maxLines && byteLength(lines) <= input.maxBytes) {
			return { text: lines.join("\n"), shown, remaining: input.rows.length - nextOffset, ...(nextCursor ? { nextCursor } : {}) };
		}
	}
	return undefined;
}

function normalizedInclude(value: unknown): GateReadInclude | undefined {
	return value === "summary" || value === "failures" || value === "checks" ? value : undefined;
}

function normalizedMaxLines(value: unknown): number | undefined {
	if (value === undefined) return GATE_READ_MAX_LINES;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= GATE_READ_MAX_LINES ? value : undefined;
}

function normalizedMaxBytes(value: unknown): number | undefined {
	if (value === undefined) return GATE_READ_MAX_BYTES;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= GATE_READ_MAX_BYTES ? value : undefined;
}

function runRows(record: GateFileRecord, include: GateReadInclude): string[] {
	const rows: string[] = record.candidate_binding === undefined
		? []
		: [`candidate ${record.candidate_binding.candidate_identity} source ${record.candidate_binding.candidate_source_run_id}`];
	for (const gate of record.gates) {
		const nonPass = gate.status !== "PASS";
		if (include === "checks" || nonPass) {
			const reason = gate.failure_reason ?? gate.blocked_reason;
			rows.push(`gate ${inline(gate.id, 96)} ${gate.status} ${inline(gate.title, 256)}${reason ? ` — ${inline(reason, 512)}` : ""}`);
		}
		if (include === "summary") continue;
		for (const check of gate.checks) {
			if (include !== "checks" && check.status === "PASS") continue;
			const reason = check.failure_reason ?? check.blocked_reason;
			rows.push(`check ${inline(gate.id, 96)}/${inline(check.check_id, 128)} ${check.status} ${inline(check.kind, 64)}${reason ? ` — ${inline(reason, 512)}` : ""}`);
		}
	}
	return rows;
}

export async function readGateRunPage(input: {
	projectRoot: string;
	runId: string;
	include?: GateReadInclude;
	cursor?: string;
	/** Internal exact turn allocation; not part of the public tool schema. */
	maxBytes?: number;
	maxLines?: number;
	/** Authority-bearing tool reads require a complete committed v2 identity. */
	requireCommittedAuthority?: boolean;
}): Promise<GateReadPageResult> {
	const include = normalizedInclude(input.include ?? "failures");
	const maxBytes = normalizedMaxBytes(input.maxBytes);
	const maxLines = normalizedMaxLines(input.maxLines);
	if (!include || maxBytes === undefined || maxLines === undefined) return fixedPageFailure("invalid_pagination");
	if (input.requireCommittedAuthority === true) {
		const manifest = await readCommittedManifest(input.projectRoot, input.runId);
		if (!manifest || manifest.recipe !== "gate") return fixedPageFailure("committed_run_identity_unavailable");
		if (!await readPersistedGateRunFacts(input.projectRoot, input.runId, manifest)) return fixedPageFailure("invalid_record");
	}
	const read = await readGateFileRecordWithReason(input.projectRoot, input.runId);
	if (!read.ok) return fixedPageFailure(read.code);
	if (input.requireCommittedAuthority === true && !await readCommittedManifest(input.projectRoot, input.runId)) {
		return fixedPageFailure("committed_run_identity_changed");
	}
	const sourceIdResult = computeFileSourceId("gate-read", `gate-run:${input.runId}:${include}`);
	if (!sourceIdResult.ok) return fixedPageFailure(sourceIdResult.error.code, read.sourcePath);
	const rows = runRows(read.record, include);
	const offset = resolvePageOffset({ cursor: input.cursor, sourceId: sourceIdResult.value, source: read.source, totalRows: rows.length });
	if (!offset.ok) return fixedPageFailure(offset.code, read.sourcePath);
	const counts = {
		pass: read.record.gates.filter((gate) => gate.status === "PASS").length,
		fail: read.record.gates.filter((gate) => gate.status === "FAIL").length,
		blocked: read.record.gates.filter((gate) => gate.status === "BLOCKED").length,
		notRun: read.record.gates.filter((gate) => gate.status === "NOT_RUN").length,
	};
	const page = packSemanticPage({
		headerLines: [
			`gate run ${input.runId} profile=${inline(read.record.profile ?? "(none)", 128)} include=${include}`,
			`summary: gates=${read.record.gates.length} pass=${counts.pass} fail=${counts.fail} blocked=${counts.blocked} not_run=${counts.notRun}`,
			`rows: total=${rows.length} (summary/failure rows are presentation; gates.json remains authoritative)`,
		],
		compactHeader: `gate run ${input.runId} include=${include} total=${rows.length}`,
		rows,
		offset: offset.offset,
		maxBytes,
		maxLines,
		sourcePath: read.sourcePath,
		sourceId: sourceIdResult.value,
		source: read.source,
	});
	if (!page) return fixedPageFailure("invalid_pagination", read.sourcePath);
	return {
		ok: true,
		text: page.text,
		details: {
			run_id: input.runId,
			include,
			shown_count: page.shown,
			remaining_count: page.remaining,
			...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
			source_path: read.sourcePath,
			authority_kind: input.requireCommittedAuthority === true ? "committed-v2" : "diagnostic",
		},
	};
}

function gateDefinitionSnapshot(gate: Gate): FileSourceSnapshot {
	const canonical = JSON.stringify({
		id: gate.id,
		title: gate.title,
		description: gate.description,
		profiles: gate.profiles,
		prerequisites: gate.prerequisites,
		required: gate.required,
		blocking: gate.blocking,
		evidence: gate.evidence,
		acceptance: gate.acceptance,
		checks: gate.checks,
		source: gate.source,
	});
	const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
	return { fileSize: Buffer.byteLength(canonical, "utf8"), mtimeMs: Number.parseInt(hash.slice(0, 12), 16) };
}

/** Bounded gate-definition view; checks are available only through include=checks paging. */
export function renderGateDefinitionPage(input: {
	gate: Gate;
	latestStatus?: LatestGateStatusView;
	latestRunId?: string;
	include?: GateReadInclude;
	cursor?: string;
	/** Internal exact turn allocation; not part of the public tool schema. */
	maxBytes?: number;
	maxLines?: number;
}): GateReadPageResult {
	const include = normalizedInclude(input.include ?? "failures");
	const maxBytes = normalizedMaxBytes(input.maxBytes);
	const maxLines = normalizedMaxLines(input.maxLines);
	if (!include || maxBytes === undefined || maxLines === undefined) return fixedPageFailure("invalid_pagination", GATE_SOURCE);
	const source = gateDefinitionSnapshot(input.gate);
	const sourceIdResult = computeFileSourceId("gate-read", `gate-definition:${input.gate.id}:${include}`);
	if (!sourceIdResult.ok) return fixedPageFailure(sourceIdResult.error.code, GATE_SOURCE);
	const rows = include === "checks"
		? input.gate.checks.map((check) => {
			const target = check.recipe ?? check.recipes?.join("|") ?? check.path ?? check.any_of?.join("|")
				?? (check.json_file ? `${check.json_file}#${check.json_path ?? check.json_any_of_paths?.join("|") ?? ""}` : undefined)
				?? (check.artifact_recipe ? `artifacts of ${check.artifact_recipe}` : undefined)
				?? (check.kind === "manual" ? "manual evidence" : check.kind === "config" ? "config" : check.schema_name ?? "");
			return `check ${inline(check.id, 128)} kind=${inline(check.kind, 64)} required=${check.required} blocking=${check.blocking} ${inline(check.title, 256)}${target ? ` — ${inline(target, 384)}` : ""}`;
		})
		: [];
	const offset = resolvePageOffset({ cursor: input.cursor, sourceId: sourceIdResult.value, source, totalRows: rows.length });
	if (!offset.ok) return fixedPageFailure(offset.code, GATE_SOURCE);
	const page = packSemanticPage({
		headerLines: [
			`gate: ${inline(input.gate.id, 128)} — ${inline(input.gate.title, 256)}`,
			`description: ${inline(input.gate.description, 512) || "(none)"}`,
			`profiles: ${inline(input.gate.profiles.join(", ") || "(all)", 384)}`,
			`prerequisites: ${inline(input.gate.prerequisites.join(", ") || "(none)", 384)}`,
			`required=${input.gate.required} blocking=${input.gate.blocking} latest=${input.latestStatus ?? "NOT_RUN"}${input.latestRunId ? ` run=${inline(input.latestRunId, 96)}` : ""}`,
			`acceptance: ${inline(input.gate.acceptance, 512) || "(not declared)"}`,
			`checks: total=${input.gate.checks.length} include=${include}`,
		],
		compactHeader: `gate ${inline(input.gate.id, 128)} latest=${input.latestStatus ?? "NOT_RUN"} checks=${input.gate.checks.length} include=${include}`,
		rows,
		offset: offset.offset,
		maxBytes,
		maxLines,
		sourcePath: GATE_SOURCE,
		sourceId: sourceIdResult.value,
		source,
	});
	if (!page) return fixedPageFailure("invalid_pagination", GATE_SOURCE);
	return {
		ok: true,
		text: page.text,
		details: {
			gate_id: input.gate.id,
			latest_status: input.latestStatus ?? "NOT_RUN",
			latest_run: input.latestRunId ?? null,
			include,
			shown_count: page.shown,
			remaining_count: page.remaining,
			...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
			source_path: GATE_SOURCE,
		},
	};
}

// ---------------------------------------------------------------------------
// Quant artifacts (run-attributed only)
// ---------------------------------------------------------------------------

export interface QuantArtifact {
	path: string;
	value: Record<string, unknown>;
	validation: QuantResultValidation;
}

async function tryReadQuantArtifact(absolutePath: string): Promise<QuantArtifact | null> {
	const read = await readJsonFileBounded(absolutePath, 512 * 1024);
	if (!read.ok) return null;
	const validation = validateQuantResult(read.value.value);
	if (!validation.valid || !isRecord(read.value.value)) return null;
	return { path: absolutePath, value: read.value.value, validation };
}

export async function loadQuantArtifact(projectRoot: string, manifest: RunRecord): Promise<QuantArtifact | null> {
	const dir = join(runsDir(projectRoot), manifest.run_id, "artifacts");
	try {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith("quant-result.json")) continue;
			const found = await tryReadQuantArtifact(join(dir, entry.name));
			if (found) return found;
		}
	} catch {
		// no artifacts directory
	}
	for (const relativePath of manifest.artifact_paths) {
		if (!relativePath.endsWith("quant-result.json")) continue;
		const found = await tryReadQuantArtifact(join(projectRoot, relativePath));
		if (found) return found;
	}
	return null;
}

export async function resolveRunTarget(projectRoot: string, arg: string): Promise<string | null> {
	const target = arg.trim();
	if (target === "latest") return (await listRuns(projectRoot, 1))[0]?.run_id ?? null;
	if (!isValidRunId(target)) return null;
	return (await readManifest(projectRoot, target)) ? target : null;
}

function boundedList(values: readonly string[], maxItems: number, maxItemBytes: number, label: string): string {
	const shown = values.slice(0, maxItems).map((value) => inline(value, maxItemBytes));
	const omitted = values.length - shown.length;
	return `${shown.join(", ") || "(none)"}${omitted > 0 ? ` (+${omitted} ${label} omitted)` : ""}`;
}

function capReportLines(lines: string[], sourceLine: string): string[] {
	const safeSource = inline(sourceLine, 768);
	const normalized = lines.map((line) => inline(line, 1_024));
	const withSource = [...normalized, safeSource];
	if (withSource.length <= RUN_REPORT_MAX_LINES && byteLength(withSource) <= RUN_REPORT_MAX_BYTES) return withSource;
	const maximum = Math.min(normalized.length, RUN_REPORT_MAX_LINES - 2);
	for (let keep = maximum; keep >= 0; keep -= 1) {
		const marker = `... ${normalized.length - keep} report line(s) omitted; ${safeSource}`;
		const candidate = [...normalized.slice(0, keep), marker, safeSource];
		if (byteLength(candidate) <= RUN_REPORT_MAX_BYTES) return candidate;
	}
	return ["run report unavailable (bounded presentation)", safeSource];
}

/** Globally bounded report; full records remain authoritative on disk. */
export async function buildRunReport(projectRoot: string, runId: string): Promise<string[] | null> {
	const manifest = await readManifest(projectRoot, runId);
	if (!manifest) return null;
	const rel = (path: string): string => displayRelative(projectRoot, path);
	const logBase = join(runsDir(projectRoot), runId);
	const recordSource = `full record: ${rel(join(logBase, "manifest.json"))}`;
	const lines = [
		`run       : ${inline(manifest.run_id, 128)}`,
		`recipe    : ${inline(manifest.recipe, 256)}${manifest.recipe === "gate" ? " (gate run)" : ""}`,
		`profile   : ${inline(manifest.profile ?? "(none)", 256)}`,
		`mode      : ${inline(manifest.mode, 64)}`,
		`started   : ${inline(manifest.started_at, 128)}`,
		`finished  : ${inline(manifest.finished_at, 128)}`,
		`duration  : ${manifest.duration_ms} ms`,
		`exit code : ${manifest.exit_code ?? "killed"}`,
		`status    : ${runStatusLabel(manifest)}`,
		`git       : ${manifest.git_commit ? manifest.git_commit.slice(0, 12) : "(no git)"}${manifest.git_dirty ? " (dirty)" : ""}`,
		`artifacts : ${boundedList(manifest.artifact_paths, 24, 256, "artifact path(s)")}`,
		`stdout log: ${inline(rel(join(logBase, "stdout.log")), 512)}`,
		`stderr log: ${inline(rel(join(logBase, "stderr.log")), 512)}`,
	];

	if (manifest.recipe === "gate") {
		const read = await readGateFileRecordWithReason(projectRoot, runId);
		if (!read.ok) {
			lines.push("", read.reason);
		} else {
			lines.push("", `gates (${read.record.gates.length}):`);
			for (const gate of read.record.gates) {
				const reason = gate.failure_reason ?? gate.blocked_reason;
				lines.push(`  ${inline(gate.id, 96).padEnd(4)} ${gate.status.padEnd(8)} ${inline(gate.title, 256)}${reason ? ` — ${inline(reason, 512)}` : ""}`);
			}
			const failed = read.record.gates.filter((gate) => gate.failure_reason).map((gate) => `${inline(gate.id, 96)}: ${inline(gate.failure_reason, 512)}`);
			if (failed.length > 0) lines.push("", "failed checks:", ...failed.map((failure) => `  ${failure}`));
		}
	}

	const quant = await loadQuantArtifact(projectRoot, manifest);
	if (quant) {
		const metrics = isRecord(quant.value.metrics) ? quant.value.metrics : undefined;
		const folds = Array.isArray(quant.value.folds) ? quant.value.folds.filter(isRecord) : undefined;
		lines.push("", `quant result (${inline(displayRelative(projectRoot, quant.path), 512)}):`);
		lines.push(`  return          : ${typeof metrics?.return === "number" ? metrics.return : "n/a"}`);
		lines.push(`  benchmark delta : ${typeof metrics?.benchmark_delta === "number" ? metrics.benchmark_delta : "n/a"}`);
		lines.push(`  drawdown        : ${typeof metrics?.drawdown === "number" ? metrics.drawdown : "n/a"}`);
		lines.push(`  turnover        : ${typeof metrics?.turnover === "number" ? metrics.turnover : "n/a"}`);
		if (folds) {
			const failed = folds.filter((fold) => fold.status === "failed").map((fold) => typeof fold.id === "string" ? fold.id : "?");
			const passed = folds.filter((fold) => fold.status === "passed").length;
			lines.push(`  folds           : ${passed} passed, ${folds.length - passed} not passed${failed.length > 0 ? ` (failed: ${boundedList(failed, 16, 96, "fold id(s)")})` : ""}`);
		}
		const parameters = isRecord(quant.value.parameters) ? Object.keys(quant.value.parameters) : [];
		lines.push(`  parameters      : ${boundedList(parameters, 24, 128, "parameter name(s)")}`);
	}

	return capReportLines(lines, recordSource);
}
