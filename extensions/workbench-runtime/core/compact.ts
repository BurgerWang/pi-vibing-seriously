/**
 * Workbench compaction supplement — pure logic, no Pi imports.
 *
 * Pi compacts long sessions with its own summarization. The workbench never
 * reimplements that: it only SUPPLEMENTS the compacted context with the
 * authoritative workbench facts that live outside the conversation, and only
 * when there is something worth carrying over (active task, gate failures,
 * runs, evidence paths, ...). The supplement is a small bounded ASCII note —
 * pointers and statuses, never run logs.
 *
 * Two persistence mechanisms are used (see index.ts):
 *   - a custom session entry (COMPACT_STATE_ENTRY_TYPE) — survives
 *     compaction and session replacement (/new /resume /fork /clone /reload)
 *     and is restored on `session_start`;
 *   - a hidden custom message (COMPACT_NOTE_MESSAGE_TYPE, display: false)
 *     delivered at the next turn via pi.sendMessage — so the model sees the
 *     facts after compaction without any log content in the context.
 */

import { redactText } from "./redact.ts";

/** customType of the persisted workbench state entry. */
export const COMPACT_STATE_ENTRY_TYPE = "workbench-state";
/** customType of the hidden in-context supplement message. */
export const COMPACT_NOTE_MESSAGE_TYPE = "workbench-compact-note";

export const MAX_MODIFIED_FILES = 20;
export const MAX_EVIDENCE_PATHS = 10;
export const MAX_DO_NOT_RETRY = 8;
export const MAX_GATES = 12;
export const MAX_NOTE_LINES = 40;
export const MAX_NOTE_CHARS = 2400;
const MAX_STRING_FIELD = 240;

/** Bound for the blocked commander write-attempt counter (mirrors delegation-state). */
export const MAX_BLOCKED_COMMANDER_WRITE_ATTEMPTS = 999;
/** Session telemetry counters saturate at safe integers, independently of the P7 audit cap. */
export const MAX_OUTPUT_CONTROL_COMPACT_COUNT = Number.MAX_SAFE_INTEGER;

/** The only write policy the workbench defines (P7 worker-first-strict). */
const WORKER_FIRST_POLICY = "worker-first-strict";

export interface CompactState {
	mode: string;
	/** Durable task objective, kept separate from the current task/phase labels. */
	objective?: string;
	task?: string;
	phase?: string;
	passedGates: string[];
	failedGates: string[];
	blockedGates: string[];
	lastRunId?: string;
	lastRecipe?: string;
	modifiedFiles: string[];
	evidencePaths: string[];
	/** Durable next action after compaction. */
	nextStep?: string;
	doNotRetry: string[];
	updatedAt: string;
	// -------------------------------------------------------------------
	// P7 worker-first write-authority facts (mirror, never authoritative —
	// the hard guards read the lease/delegation custom entries directly and
	// remain fully independent of this note text).
	// -------------------------------------------------------------------
	/** "worker-first-strict" when the fixed policy is active (approved Sol). */
	writePolicy?: string;
	/** True when commander edit/write is hard-denied (no active lease). */
	commanderWritesDenied?: boolean;
	/** Id of the latest worker delegation (undefined = none). */
	lastDelegationId?: string;
	/** True while the latest delegation needs a (re-)review (PENDING_REVIEW or STALE). */
	pendingDelegationReview?: boolean;
	/** Hash of the reviewed diff (REVIEWED/STALE states carry it). */
	reviewedDiffHash?: string;
	/** Bounded active-lease summary (status/id/reason/calls/paths — never tokens). */
	activeWriteLease?: string;
	/** Bounded audit counter of blocked strict-Sol edit/write attempts. */
	blockedCommanderWriteAttempts?: number;
	/** The next required delegation/review action (bounded pointer). */
	nextDelegationAction?: string;
	// R8 output-control observations. These numeric counters are advisory
	// only: enforcement never reads compact state or the rendered note.
	outputTruncatedResults?: number;
	outputHistoryCollapsedBundles?: number;
}

export function emptyCompactState(mode: string): CompactState {
	return {
		mode,
		passedGates: [],
		failedGates: [],
		blockedGates: [],
		modifiedFiles: [],
		evidencePaths: [],
		doNotRetry: [],
		updatedAt: "",
	};
}

function cleanString(value: unknown, cap = MAX_STRING_FIELD): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.slice(0, cap);
}

function cleanList(value: unknown, cap: number): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
		.map((v) => v.trim().slice(0, MAX_STRING_FIELD))
		.slice(0, cap);
}

function cleanBoolean(value: unknown, fallback: boolean | undefined): boolean | undefined {
	return typeof value === "boolean" ? value : fallback;
}

function cleanBoundedCounter(value: unknown, max = MAX_BLOCKED_COMMANDER_WRITE_ATTEMPTS): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
	return Math.min(value, max);
}

/** Sanitize an unknown persisted payload into a valid CompactState. */
export function mergeCompactState(base: CompactState, raw: unknown): CompactState {
	if (typeof raw !== "object" || raw === null) return base;
	const r = raw as Record<string, unknown>;
	return {
		mode: typeof r.mode === "string" ? r.mode : base.mode,
		objective: cleanString(r.objective) ?? base.objective,
		task: cleanString(r.task) ?? base.task,
		phase: cleanString(r.phase) ?? base.phase,
		passedGates: cleanList(r.passedGates, MAX_GATES),
		failedGates: cleanList(r.failedGates, MAX_GATES),
		blockedGates: cleanList(r.blockedGates, MAX_GATES),
		lastRunId: cleanString(r.lastRunId, 64) ?? base.lastRunId,
		lastRecipe: cleanString(r.lastRecipe, 64) ?? base.lastRecipe,
		modifiedFiles: cleanList(r.modifiedFiles, MAX_MODIFIED_FILES),
		evidencePaths: cleanList(r.evidencePaths, MAX_EVIDENCE_PATHS),
		nextStep: cleanString(r.nextStep) ?? base.nextStep,
		doNotRetry: cleanList(r.doNotRetry, MAX_DO_NOT_RETRY),
		updatedAt: typeof r.updatedAt === "string" ? r.updatedAt.slice(0, 32) : base.updatedAt,
		// P7 worker-first facts: sanitized (typed/bounded), mirrored, never
		// authoritative — the guards read the lease/delegation entries.
		writePolicy: cleanString(r.writePolicy, 64) === WORKER_FIRST_POLICY ? WORKER_FIRST_POLICY : base.writePolicy,
		commanderWritesDenied: cleanBoolean(r.commanderWritesDenied, base.commanderWritesDenied),
		lastDelegationId: cleanString(r.lastDelegationId, 64) ?? base.lastDelegationId,
		pendingDelegationReview: cleanBoolean(r.pendingDelegationReview, base.pendingDelegationReview),
		reviewedDiffHash: cleanString(r.reviewedDiffHash, 128) ?? base.reviewedDiffHash,
		activeWriteLease: cleanString(r.activeWriteLease) ?? base.activeWriteLease,
		blockedCommanderWriteAttempts: cleanBoundedCounter(r.blockedCommanderWriteAttempts) ?? base.blockedCommanderWriteAttempts,
		nextDelegationAction: cleanString(r.nextDelegationAction) ?? base.nextDelegationAction,
		outputTruncatedResults: cleanBoundedCounter(r.outputTruncatedResults, MAX_OUTPUT_CONTROL_COMPACT_COUNT) ?? base.outputTruncatedResults,
		outputHistoryCollapsedBundles: cleanBoundedCounter(r.outputHistoryCollapsedBundles, MAX_OUTPUT_CONTROL_COMPACT_COUNT) ?? base.outputHistoryCollapsedBundles,
	};
}

export interface CompactStateEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Restore the latest persisted state entry; the last entry wins. */
export function loadCompactStateFromEntries(entries: readonly CompactStateEntry[], fallbackMode: string): CompactState {
	let latest: unknown;
	let found = false;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== COMPACT_STATE_ENTRY_TYPE) continue;
		latest = entry.data;
		found = true;
	}
	// A persisted entry is a complete snapshot. Sanitizing the newest snapshot
	// against an empty state prevents fields from different historical records
	// being combined into a state that never existed.
	const state = found
		? mergeCompactState(emptyCompactState(fallbackMode), latest)
		: emptyCompactState(fallbackMode);
	if (state.mode !== fallbackMode) state.mode = fallbackMode; // mode is authoritative from MODE_ENTRY_TYPE
	return state;
}

export interface ReviewedWorkerChangedPathsInput {
	reviewStatus?: unknown;
	changedPaths?: unknown;
}

function cleanProjectRelativePosixPath(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const path = value.trim();
	if (path.length === 0 || path.length > MAX_STRING_FIELD || path.startsWith("/")) return undefined;
	if (path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path)) return undefined;
	const segments = path.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return undefined;
	return segments.join("/");
}

/**
 * Return a bounded path-only summary for a worker diff after review. Pending,
 * stale, rejected, or malformed review records intentionally disclose no paths.
 */
export function summarizeReviewedWorkerChangedPaths(input: ReviewedWorkerChangedPathsInput): string[] {
	if (input.reviewStatus !== "REVIEWED" || !Array.isArray(input.changedPaths)) return [];
	const result: string[] = [];
	const seen = new Set<string>();
	// Bound both the amount inspected and the amount returned.
	for (const value of input.changedPaths.slice(0, MAX_MODIFIED_FILES * 4)) {
		const path = cleanProjectRelativePosixPath(value);
		if (!path || seen.has(path)) continue;
		seen.add(path);
		result.push(path);
		if (result.length === MAX_MODIFIED_FILES) break;
	}
	return result;
}

/** Append an item to a bounded list, deduplicated, oldest dropped first. */
export function pushBounded(list: readonly string[], item: string, cap: number): string[] {
	const next = [...list, item].filter((v, i, arr) => arr.indexOf(v) === i);
	return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Track repeated identical failures: when the two most recent outcomes are
 * the same failure signature, produce a "do not retry" note. Signatures:
 *   recipe:<name>:exit:<code>   — failed recipe run
 *   gate:FAIL | gate:BLOCKED    — failed/blocked gate run
 * Repeated successes are never flagged.
 */
export function collectDoNotRetry(recent: readonly string[], cap = MAX_DO_NOT_RETRY): string[] {
	const notes: string[] = [];
	if (recent.length >= 2 && recent[recent.length - 1] === recent[recent.length - 2]) {
		const last = recent[recent.length - 1] ?? "";
		const recipe = last.match(/^recipe:([^:]+):exit:(.+)$/);
		if (recipe) {
			notes.push(`recipe "${recipe[1]}" failed twice with exit ${recipe[2]} — do not blindly re-run it; investigate the failure first`);
		}
		const gate = last.match(/^gate:(FAIL|BLOCKED)$/);
		if (gate) {
			notes.push(`gate runs ended ${gate[1]} twice in a row — do not blindly re-run the same gates; fix the failing checks first`);
		}
	}
	return notes.slice(0, cap);
}

/** Only supplement when there is real workbench state worth carrying over. */
export function shouldSupplement(state: CompactState): boolean {
	return Boolean(
		state.objective ||
			state.task ||
			state.phase ||
			state.lastRunId ||
			state.nextStep ||
			state.failedGates.length > 0 ||
			state.blockedGates.length > 0 ||
			state.modifiedFiles.length > 0 ||
			state.doNotRetry.length > 0 ||
			// P7 worker-first facts are worth carrying across compaction.
			state.writePolicy !== undefined ||
			state.commanderWritesDenied === true ||
			state.lastDelegationId !== undefined ||
			state.pendingDelegationReview === true ||
			state.blockedCommanderWriteAttempts !== undefined ||
			state.nextDelegationAction !== undefined ||
			(state.outputTruncatedResults ?? 0) > 0 ||
			(state.outputHistoryCollapsedBundles ?? 0) > 0,
	);
}

function line(label: string, value: string | undefined): string[] {
	if (!value) return [];
	return [`${label}: ${value}`];
}

/**
 * Build the bounded ASCII supplement note. Contains only pointers and
 * statuses (run ids, gate ids, file paths) — never run log content. Output
 * is hard-capped (MAX_NOTE_LINES lines / MAX_NOTE_CHARS chars) and passed
 * through secret-shape redaction.
 */
export function buildCompactNote(state: CompactState): string {
	const lines: string[] = [
		"workbench state (pi-dev-workbench)",
		`mode: ${state.mode}`,
	];
	lines.push(...line("objective", state.objective));
	lines.push(...line("task", state.task));
	lines.push(...line("phase", state.phase));
	// Compatibility facts: fixed Sol/Luna authority, temporary lease
	// exception, delegation state, and the next action. These
	// are pointers/statuses only — the hard guards never read this text.
	if (state.writePolicy === "worker-first-strict") lines.push("development writes: Sol plans, Luna implements");
	if (state.commanderWritesDenied === true) lines.push("commander writes: locked (temporary lease required)");
	if (state.lastDelegationId) {
		const reviewState =
			state.pendingDelegationReview === true
				? "PENDING_REVIEW"
				: state.reviewedDiffHash
					? "REVIEWED"
					: "?";
		lines.push(`delegation: ${state.lastDelegationId} ${reviewState}${state.reviewedDiffHash ? ` (hash ${state.reviewedDiffHash.slice(0, 12)})` : ""}`);
	}
	if (state.blockedCommanderWriteAttempts !== undefined && state.blockedCommanderWriteAttempts > 0) {
		lines.push(`blocked commander writes: ${state.blockedCommanderWriteAttempts}`);
	}
	if (state.activeWriteLease) lines.push(`write lease: ${state.activeWriteLease}`);
	lines.push(...line("next delegation action", state.nextDelegationAction));
	if ((state.outputTruncatedResults ?? 0) > 0 || (state.outputHistoryCollapsedBundles ?? 0) > 0) {
		lines.push(
			`context output: ${state.outputTruncatedResults ?? 0} results truncated, ${state.outputHistoryCollapsedBundles ?? 0} history bundles collapsed`,
		);
	}
	if (state.lastRunId) lines.push(`last run: ${state.lastRunId}${state.lastRecipe ? ` (${state.lastRecipe})` : ""}`);
	if (state.passedGates.length > 0) lines.push(`gates passed: ${state.passedGates.join(", ")}`);
	if (state.failedGates.length > 0) lines.push(`gates failed: ${state.failedGates.join(", ")}`);
	if (state.blockedGates.length > 0) lines.push(`gates blocked: ${state.blockedGates.join(", ")}`);
	if (state.modifiedFiles.length > 0) lines.push(`modified files: ${state.modifiedFiles.join(", ")}`);
	if (state.evidencePaths.length > 0) lines.push(`evidence: ${state.evidencePaths.join(", ")}`);
	lines.push(...line("next step", state.nextStep ?? (state.task ? `continue "${state.task}"` : undefined)));
	if (state.doNotRetry.length > 0) {
		lines.push("do not retry:");
		for (const note of state.doNotRetry) lines.push(`  - ${note}`);
	}
	const bounded = lines.slice(0, MAX_NOTE_LINES);
	let text = bounded.join("\n");
	if (text.length > MAX_NOTE_CHARS) text = text.slice(0, MAX_NOTE_CHARS) + "\n[truncated]";
	// Defense in depth: never let credential shapes through into context.
	return redactText(text, []);
}
