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

export interface CompactState {
	mode: string;
	task?: string;
	phase?: string;
	passedGates: string[];
	failedGates: string[];
	blockedGates: string[];
	lastRunId?: string;
	lastRecipe?: string;
	modifiedFiles: string[];
	evidencePaths: string[];
	nextStep?: string;
	doNotRetry: string[];
	updatedAt: string;
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

/** Sanitize an unknown persisted payload into a valid CompactState. */
export function mergeCompactState(base: CompactState, raw: unknown): CompactState {
	if (typeof raw !== "object" || raw === null) return base;
	const r = raw as Record<string, unknown>;
	return {
		mode: typeof r.mode === "string" ? r.mode : base.mode,
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
	};
}

export interface CompactStateEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Restore the latest persisted state entry; the last entry wins. */
export function loadCompactStateFromEntries(entries: readonly CompactStateEntry[], fallbackMode: string): CompactState {
	let state = emptyCompactState(fallbackMode);
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== COMPACT_STATE_ENTRY_TYPE) continue;
		state = mergeCompactState(state, entry.data);
	}
	if (state.mode !== fallbackMode) state.mode = fallbackMode; // mode is authoritative from MODE_ENTRY_TYPE
	return state;
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
		state.task ||
			state.phase ||
			state.lastRunId ||
			state.nextStep ||
			state.failedGates.length > 0 ||
			state.blockedGates.length > 0 ||
			state.modifiedFiles.length > 0 ||
			state.doNotRetry.length > 0,
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
	lines.push(...line("task", state.task));
	lines.push(...line("phase", state.phase));
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
