/**
 * P5 milestone handoff — pure logic, no Pi imports.
 *
 * The user-only `/q-milestone-handoff <next step>` command is the ONLY path
 * that carries workbench state into a fresh session. It waits for idle,
 * persists a bounded/redacted `prepared` milestone record in the current
 * (source) session, then starts a fresh parent-linked session whose setup
 * appends a `resumed` record, a hidden pointer-only note and copies of the
 * mode / bounded compact state / delegation state — never the commander
 * write lease (the target write authority stays locked).
 *
 * Lifecycle: `prepared` (source, before replacement) → `resumed` (target,
 * on success) | `cancelled` (source, when the replacement is cancelled).
 *
 * This module defines the additive schema-v1 records, the explicit bounded
 * next-step parser, the bounded/redacted CompactState snapshot, and the
 * deterministic pointers/status-only hidden note. `prepare` normalizes the
 * explicit next step EXACTLY once — trim, env-secret redaction, re-cap
 * (code-point and UTF-8 safe) — and stores the SAME value in
 * `record.next_step` and the copied `state.nextStep`, so an env-secret
 * value can never persist in the explicit step and the copied snapshot
 * never carries a stale/undefined nextStep. Every externally supplied
 * record string (milestone id, next step, session pointer, timestamp) is
 * bounded/redacted by `prepare`, so it can never build a record that its
 * own fail-closed loader rejects. The hidden note is pointers/status only
 * and NEVER carries the absolute source session path (only the fixed
 * parent-linked fact; the pointer lives outside model context). Loading is
 * fail-closed: unknown schemas and malformed records are ignored, other
 * custom-entry types are never touched, and there is no legacy migration
 * or rewrite.
 */

import {
	COMPACT_STATE_ENTRY_TYPE,
	emptyCompactState,
	MAX_DO_NOT_RETRY,
	MAX_EVIDENCE_PATHS,
	MAX_GATES,
	MAX_MODIFIED_FILES,
	mergeCompactState,
	type CompactState,
} from "./compact.ts";
import { DEFAULT_MODE, normalizeMode } from "./mode-policy.ts";
import { redactText } from "./redact.ts";

/** customType of the persisted additive milestone lifecycle records. */
export const MILESTONE_HANDOFF_ENTRY_TYPE = "workbench-milestone-handoff";
/** customType of the hidden in-context milestone note (display: false). */
export const MILESTONE_HANDOFF_NOTE_ENTRY_TYPE = "workbench-milestone-handoff-note";
/** The only supported schema version (additive; unknown versions are ignored). */
export const MILESTONE_HANDOFF_SCHEMA_VERSION = 1;
/** Closed lifecycle union. */
export const MILESTONE_HANDOFF_LIFECYCLES = ["prepared", "resumed", "cancelled"] as const;
export type MilestoneHandoffLifecycle = (typeof MILESTONE_HANDOFF_LIFECYCLES)[number];

// ---------------------------------------------------------------------------
// Explicit bounds
// ---------------------------------------------------------------------------

/** Next-step character cap (code units) — empty and overlong values are rejected. */
export const MAX_NEXT_STEP_CHARS = 240;
/** Next-step UTF-8 byte cap (defense in depth on top of the char cap). */
export const MAX_NEXT_STEP_BYTES = 1024;
export const MAX_MILESTONE_ID_LENGTH = 64;
export const MAX_SESSION_POINTER_LENGTH = 512;
export const MAX_TIMESTAMP_LENGTH = 32;
/** Hidden-note caps: lines → chars → UTF-8 bytes (marker space reserved inside). */
export const MAX_HANDOFF_NOTE_LINES = 40;
export const MAX_HANDOFF_NOTE_CHARS = 2400;
export const MAX_HANDOFF_NOTE_BYTES = 4096;

/** Minimal structural shape of a Pi custom session entry (mirrors state.ts). */
export interface MilestoneHandoffEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Additive schema-v1 milestone lifecycle record (JSON-safe). */
export interface MilestoneHandoffRecord {
	schema_version: 1;
	lifecycle: MilestoneHandoffLifecycle;
	/** Bounded deterministic milestone id (shared by prepared/resumed/cancelled). */
	milestone_id: string;
	/** Bounded explicit next step (never empty, never overlong). */
	next_step: string;
	/** Bounded session pointer (the source session file; the parent link). */
	session: string;
	/** Bounded ISO timestamp of this lifecycle record. */
	updated_at: string;
	/** Bounded/redacted CompactState snapshot (prepared/resumed only). */
	state?: CompactState;
}

// ---------------------------------------------------------------------------
// UTF-8 helpers (code-point safe)
// ---------------------------------------------------------------------------

/** Exact UTF-8 byte length (code-point safe — never splits surrogate pairs). */
export function utf8ByteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * Truncate to `maxBytes` UTF-8 bytes without ever splitting a code point
 * (surrogate pairs are kept whole). Iterates by code point, so the result
 * is always valid Unicode and its byte length is <= maxBytes.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (utf8ByteLength(text) <= maxBytes) return text;
	let out = "";
	for (const ch of text) {
		const next = out + ch;
		if (utf8ByteLength(next) > maxBytes) break;
		out = next;
	}
	return out;
}

/**
 * Truncate to `maxChars` code points without ever splitting a surrogate
 * pair (`text.length` counts UTF-16 code units, so a truncated prefix is
 * always shorter or equal in code units as well).
 */
export function truncateChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	let out = "";
	for (const ch of text) {
		const next = out + ch;
		if (next.length > maxChars) break;
		out = next;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Next-step parsing (explicit bounds, empty/overlong rejected)
// ---------------------------------------------------------------------------

export type ParseNextStepResult = { ok: true; nextStep: string } | { ok: false; error: string };

/** Parse and bound the command's `<next step>` argument. */
export function parseNextStepArg(raw: string): ParseNextStepResult {
	const nextStep = raw.trim();
	if (nextStep.length === 0) {
		return { ok: false, error: "the next step must not be empty" };
	}
	if (nextStep.length > MAX_NEXT_STEP_CHARS) {
		return { ok: false, error: `the next step is too long: ${nextStep.length} characters (max ${MAX_NEXT_STEP_CHARS})` };
	}
	const bytes = utf8ByteLength(nextStep);
	if (bytes > MAX_NEXT_STEP_BYTES) {
		return { ok: false, error: `the next step is too long: ${bytes} UTF-8 bytes (max ${MAX_NEXT_STEP_BYTES})` };
	}
	return { ok: true, nextStep };
}

// ---------------------------------------------------------------------------
// Milestone ids
// ---------------------------------------------------------------------------

/**
 * Deterministic-shaped milestone id (time-based with a random suffix,
 * mirroring delegation/run ids). Strictly bounded by MAX_MILESTONE_ID_LENGTH.
 */
export function makeMilestoneId(date: Date): string {
	const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
	const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
	return `mh-${stamp}-${rand}`;
}

// ---------------------------------------------------------------------------
// Bounded/redacted CompactState snapshot
// ---------------------------------------------------------------------------

function redactOptional(value: string | undefined, secrets: readonly string[]): string | undefined {
	return value === undefined ? undefined : redactText(value, secrets);
}

function redactList(value: readonly string[], secrets: readonly string[]): string[] {
	return value.map((v) => redactText(v, secrets));
}

/**
 * Build the bounded/redacted CompactState snapshot that travels with the
 * milestone. Sanitization re-applies the compact caps, then every string
 * field is passed through secret redaction, then the caps are applied AGAIN
 * (redaction replacements can grow strings). The mode is normalized.
 */
export function buildMilestoneSnapshot(state: CompactState, secrets: readonly string[]): CompactState {
	const sanitized = mergeCompactState(emptyCompactState(normalizeMode(state.mode)), state);
	// mergeCompactState passes string modes through verbatim, so the mode is
	// normalized EXPLICITLY (unknown values fall back to DEV, fail-closed).
	sanitized.mode = normalizeMode(sanitized.mode);
	const redacted: CompactState = {
		...sanitized,
		task: redactOptional(sanitized.task, secrets),
		phase: redactOptional(sanitized.phase, secrets),
		lastRunId: redactOptional(sanitized.lastRunId, secrets),
		lastRecipe: redactOptional(sanitized.lastRecipe, secrets),
		modifiedFiles: redactList(sanitized.modifiedFiles, secrets),
		evidencePaths: redactList(sanitized.evidencePaths, secrets),
		nextStep: redactOptional(sanitized.nextStep, secrets),
		doNotRetry: redactList(sanitized.doNotRetry, secrets),
		activeWriteLease: redactOptional(sanitized.activeWriteLease, secrets),
		nextDelegationAction: redactOptional(sanitized.nextDelegationAction, secrets),
	};
	// Re-cap after redaction: `[REDACTED]` replacements can grow fields.
	const recapped = mergeCompactState(emptyCompactState(normalizeMode(redacted.mode)), redacted);
	recapped.mode = normalizeMode(recapped.mode);
	return recapped;
}

// ---------------------------------------------------------------------------
// Lifecycle records
// ---------------------------------------------------------------------------

export interface PrepareMilestoneHandoffInput {
	milestoneId: string;
	nextStep: string;
	session: string;
	state: CompactState;
	secrets: readonly string[];
	now: string;
}

/**
 * Normalize the explicit next step exactly once: trim, redact env-secret
 * values and credential shapes, then RE-CAP after redaction (a
 * `[REDACTED]` replacement can grow the text) — code-point and UTF-8
 * safe. The command parser has already rejected empty/overlong raw input;
 * the result is never empty and always within both next-step caps, so the
 * SAME value can be stored in `record.next_step` and the copied
 * `state.nextStep`. Whitespace-only input is a contract violation (the
 * parser rejects it before prepare is ever called) and fails closed.
 */
export function normalizeNextStep(nextStep: string, secrets: readonly string[]): string {
	const trimmed = nextStep.trim();
	if (trimmed.length === 0) {
		throw new TypeError(
			"prepareMilestoneHandoff requires a non-empty next step (the command parser rejects empty input before prepare is called)",
		);
	}
	let out = redactText(trimmed, secrets);
	out = truncateChars(out, MAX_NEXT_STEP_CHARS);
	out = truncateUtf8(out, MAX_NEXT_STEP_BYTES);
	return out;
}

/**
 * Bound/redact a defensively supplied record string (source session
 * pointer, milestone id, timestamp): env-secret values are redacted, then
 * the field is truncated code-point-safely to its persisted cap, so
 * `prepare` can never build a record that its own fail-closed loader
 * rejects or that violates record bounds. Parent linkage keeps using the
 * ORIGINAL full value; only the persisted record string is bounded.
 */
export function boundRecordString(value: string, maxChars: number, secrets: readonly string[]): string {
	return truncateChars(redactText(value.trim(), secrets), maxChars);
}

/** Build the additive `prepared` record persisted in the SOURCE session. */
export function prepareMilestoneHandoff(input: PrepareMilestoneHandoffInput): MilestoneHandoffRecord {
	// The explicit next step is authoritative: it is normalized (trim,
	// redact, re-cap) ONCE and stored identically in `record.next_step` and
	// the copied `state.nextStep` — a pre-existing snapshot nextStep
	// (possibly stale or undefined) never reaches the record or the target.
	const nextStep = normalizeNextStep(input.nextStep, input.secrets);
	const state = buildMilestoneSnapshot(input.state, input.secrets);
	state.nextStep = nextStep;
	return {
		schema_version: MILESTONE_HANDOFF_SCHEMA_VERSION,
		lifecycle: "prepared",
		milestone_id: boundRecordString(input.milestoneId, MAX_MILESTONE_ID_LENGTH, input.secrets),
		next_step: nextStep,
		session: boundRecordString(input.session, MAX_SESSION_POINTER_LENGTH, input.secrets),
		updated_at: boundRecordString(input.now, MAX_TIMESTAMP_LENGTH, input.secrets),
		state,
	};
}

/** Additive `resumed` record appended by the TARGET session setup. */
export function toResumedRecord(prepared: MilestoneHandoffRecord, now: string): MilestoneHandoffRecord {
	return { ...prepared, lifecycle: "resumed", updated_at: now };
}

/** Additive `cancelled` record appended to the still-valid SOURCE session. */
export function toCancelledRecord(prepared: MilestoneHandoffRecord, now: string): MilestoneHandoffRecord {
	return {
		schema_version: MILESTONE_HANDOFF_SCHEMA_VERSION,
		lifecycle: "cancelled",
		milestone_id: prepared.milestone_id,
		next_step: prepared.next_step,
		session: prepared.session,
		updated_at: now,
	};
}

// ---------------------------------------------------------------------------
// Fail-closed restore / load
// ---------------------------------------------------------------------------

/**
 * Restore a persisted milestone record, fail-closed. Unknown schema
 * versions, unknown lifecycles, missing/empty/overlong required fields
 * (milestone id, next step — chars and UTF-8 bytes —, session pointer,
 * timestamp) and a malformed state snapshot all yield `undefined` (the
 * record is ignored). Unknown extra fields inside an otherwise valid
 * schema-v1 record are tolerated (the schema is additive).
 */
export function restoreMilestoneHandoff(raw: unknown): MilestoneHandoffRecord | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	if (r.schema_version !== MILESTONE_HANDOFF_SCHEMA_VERSION) return undefined;
	const lifecycle = r.lifecycle;
	if (!MILESTONE_HANDOFF_LIFECYCLES.includes(lifecycle as MilestoneHandoffLifecycle)) return undefined;
	const milestoneId = typeof r.milestone_id === "string" ? r.milestone_id.trim() : "";
	const nextStep = typeof r.next_step === "string" ? r.next_step.trim() : "";
	const session = typeof r.session === "string" ? r.session.trim() : "";
	const updatedAt = typeof r.updated_at === "string" ? r.updated_at.trim() : "";
	if (!milestoneId || milestoneId.length > MAX_MILESTONE_ID_LENGTH) return undefined;
	if (!nextStep || nextStep.length > MAX_NEXT_STEP_CHARS) return undefined;
	if (utf8ByteLength(nextStep) > MAX_NEXT_STEP_BYTES) return undefined;
	if (!session || session.length > MAX_SESSION_POINTER_LENGTH) return undefined;
	if (!updatedAt || updatedAt.length > MAX_TIMESTAMP_LENGTH) return undefined;
	let state: CompactState | undefined;
	if (r.state !== undefined) {
		if (typeof r.state !== "object" || r.state === null) return undefined;
		state = mergeCompactState(emptyCompactState(DEFAULT_MODE), r.state);
		state.mode = normalizeMode(state.mode);
		// The record's next_step is authoritative: a restored snapshot always
		// carries the SAME explicit handoff next step as the validated record
		// (the persisted snapshot's nextStep may be stale or absent), so later
		// compaction/restoration retains the explicit handoff step.
		state.nextStep = nextStep;
	}
	return {
		schema_version: MILESTONE_HANDOFF_SCHEMA_VERSION,
		lifecycle: lifecycle as MilestoneHandoffLifecycle,
		milestone_id: milestoneId,
		next_step: nextStep,
		session,
		updated_at: updatedAt,
		state,
	};
}

/**
 * Load every valid milestone record from session entries, in entry order.
 * Only entries whose customType matches are considered; malformed/unknown
 * records are skipped, every other custom-entry type is left untouched, and
 * nothing is migrated or rewritten.
 */
export function loadMilestoneHandoffs(entries: readonly MilestoneHandoffEntry[]): MilestoneHandoffRecord[] {
	const records: MilestoneHandoffRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MILESTONE_HANDOFF_ENTRY_TYPE) continue;
		const restored = restoreMilestoneHandoff(entry.data);
		if (restored) records.push(restored);
	}
	return records;
}

/** The last valid milestone record (or undefined when none exists). */
export function latestMilestoneHandoff(entries: readonly MilestoneHandoffEntry[]): MilestoneHandoffRecord | undefined {
	const records = loadMilestoneHandoffs(entries);
	return records[records.length - 1];
}

// ---------------------------------------------------------------------------
// Deterministic pointers/status-only hidden note
// ---------------------------------------------------------------------------

/**
 * Build the bounded hidden note injected into the TARGET session. The note
 * carries only deterministic pointers and statuses from the record — the
 * milestone id, lifecycle, the fixed parent-link fact (the absolute source
 * session path NEVER enters model context; the pointer is persisted in the
 * record outside LLM context), the bounded next step, mode,
 * delegation/run/gate/evidence pointers and the copied-state facts. It
 * never contains run-log content and never the source session path.
 *
 * Cap accounting: a pre-pass decides whether ANY cap binds on the full
 * content (lines → chars → UTF-8 bytes, including redaction growth —
 * `[REDACTED]` replacements can grow the text); when it does, the
 * `[truncated]` marker's space is reserved INSIDE every cap from the start
 * (one line, MARKER chars, MARKER bytes) and every truncation mode
 * (dropped lines, char cuts, byte cuts) is explicitly marked, so the
 * final output never exceeds any of the three bounds.
 */
export function buildMilestoneHandoffNote(record: MilestoneHandoffRecord): string {
	const state = record.state;
	const lines = [
		"milestone handoff (pi-dev-workbench)",
		`milestone: ${record.milestone_id}`,
		`lifecycle: ${record.lifecycle}`,
		// Fixed fact only: the parent link is persisted outside model context
		// (custom entry + session parent linkage); the absolute source
		// session path is never rendered into LLM context.
		"source session: parent-linked (pointer persisted outside model context)",
		`next step: ${record.next_step}`,
		`mode: ${state?.mode ?? DEFAULT_MODE}`,
	];
	if (state?.task) lines.push(`task: ${state.task}`);
	if (state?.phase) lines.push(`phase: ${state.phase}`);
	if (state?.lastDelegationId) {
		const reviewState =
			state.pendingDelegationReview === true
				? "PENDING_REVIEW"
				: state.reviewedDiffHash
					? "REVIEWED"
					: "?";
		lines.push(`delegation: ${state.lastDelegationId} ${reviewState}`);
	} else {
		lines.push("delegation: none");
	}
	if (state?.nextDelegationAction) lines.push(`next delegation action: ${state.nextDelegationAction}`);
	// Pointers/status only: the source lease summary is a bounded pointer
	// (never tokens). The target lock is a FIXED handoff invariant — the
	// target never carries a lease, so the fact is always rendered.
	if (state?.activeWriteLease) lines.push(`source write lease: ${state.activeWriteLease}`);
	lines.push("commander writes: denied in target (write lease never carried)");
	if (state?.lastRunId) lines.push(`last run: ${state.lastRunId}${state.lastRecipe ? ` (${state.lastRecipe})` : ""}`);
	if (state && state.passedGates.length > 0) lines.push(`gates passed: ${state.passedGates.join(", ")}`);
	if (state && state.failedGates.length > 0) lines.push(`gates failed: ${state.failedGates.join(", ")}`);
	if (state && state.blockedGates.length > 0) lines.push(`gates blocked: ${state.blockedGates.join(", ")}`);
	if (state && state.modifiedFiles.length > 0) lines.push(`modified files: ${state.modifiedFiles.join(", ")}`);
	if (state && state.evidencePaths.length > 0) lines.push(`evidence: ${state.evidencePaths.join(", ")}`);
	if (state && state.doNotRetry.length > 0) {
		lines.push("do not retry:");
		for (const item of state.doNotRetry) lines.push(`  - ${item}`);
	}
	lines.push(`updated at: ${record.updated_at}`);

	const MARKER = "\n[truncated]";
	const joined = lines.join("\n");
	// Pre-pass: when ANY cap binds on the full content the marker WILL be
	// appended, so its space is reserved inside every cap (one line, MARKER
	// chars, MARKER bytes) from the start. Redaction growth is included.
	const redactedJoined = redactText(joined, []);
	const needsMarker =
		lines.length > MAX_HANDOFF_NOTE_LINES ||
		joined.length > MAX_HANDOFF_NOTE_CHARS ||
		utf8ByteLength(joined) > MAX_HANDOFF_NOTE_BYTES ||
		redactedJoined.length > MAX_HANDOFF_NOTE_CHARS ||
		utf8ByteLength(redactedJoined) > MAX_HANDOFF_NOTE_BYTES;
	const maxLines = needsMarker ? MAX_HANDOFF_NOTE_LINES - 1 : MAX_HANDOFF_NOTE_LINES;
	const charCap = needsMarker ? MAX_HANDOFF_NOTE_CHARS - MARKER.length : MAX_HANDOFF_NOTE_CHARS;
	const byteCap = needsMarker ? MAX_HANDOFF_NOTE_BYTES - MARKER.length : MAX_HANDOFF_NOTE_BYTES;
	let text = lines.slice(0, maxLines).join("\n");
	// Bytes first, chars last: char truncation only shrinks, so the final
	// text stays within BOTH reserved caps (code-point safe throughout).
	if (utf8ByteLength(text) > byteCap) text = truncateUtf8(text, byteCap);
	if (text.length > charCap) text = truncateChars(text, charCap);
	// Defense in depth: credential SHAPES are scrubbed even though the
	// snapshot was already redacted at prepare time.
	text = redactText(text, []);
	if (utf8ByteLength(text) > byteCap) text = truncateUtf8(text, byteCap);
	if (text.length > charCap) text = truncateChars(text, charCap);
	return needsMarker ? `${text}${MARKER}` : text;
}

/** Deterministic usage/help text for the user-only command. */
export function milestoneHandoffUsage(): string {
	return "usage: /q-milestone-handoff <next step> — user-only; waits for idle, persists a bounded/redacted prepared record, then starts a fresh parent-linked session resuming mode/compact/delegation state with a hidden note (commander write leases are never carried; no model/provider call, no agent turn)";
}

// Re-exported compact caps so the snapshot contract is visible at one place
// (the snapshot uses the SAME caps as the compaction supplement).
export { COMPACT_STATE_ENTRY_TYPE, MAX_DO_NOT_RETRY, MAX_EVIDENCE_PATHS, MAX_GATES, MAX_MODIFIED_FILES };
