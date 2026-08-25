/**
 * Workbench mode state — persistence via Pi custom session entries.
 *
 * Pure logic, no Pi imports. The extension calls `pi.appendEntry(MODE_ENTRY_TYPE, { mode })`
 * on every mode change and restores the latest entry on `session_start` via
 * `ctx.sessionManager.getEntries()`.
 */

import {
	DEFAULT_MODE,
	normalizeMode,
	type WorkbenchMode,
} from "./mode-policy.ts";

/** customType of the Pi custom session entry that stores the current mode. */
export const MODE_ENTRY_TYPE = "workbench-mode";

/**
 * Minimal structural shape of a Pi custom session entry.
 * Mirrors `CustomEntry` from the Pi session format without importing Pi types.
 */
export interface ModeStateEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface ModeStateData {
	mode?: unknown;
}

/**
 * Reconstruct the last persisted mode from session entries.
 * No entry, no matching entry, or invalid data falls back to DEV.
 * Later entries win (the mode is re-persisted on every change).
 */
export function loadModeFromEntries(entries: readonly ModeStateEntry[]): WorkbenchMode {
	let mode: WorkbenchMode = DEFAULT_MODE;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) continue;
		const data = entry.data as ModeStateData | null | undefined;
		mode = normalizeMode(data?.mode);
	}
	return mode;
}

/** Short status-bar text, e.g. "WB:DEV". */
export function statusText(mode: WorkbenchMode): string {
	return `WB:${mode}`;
}

/** Human-readable one-liner for commands and reports. */
export function describeMode(mode: WorkbenchMode): string {
	switch (mode) {
		case "AUDIT":
			return "read-only audit: read, grep, find, ls, workbench_project_inspect, workbench_read_run (bash/edit/write/workbench_run_recipe blocked)";
		case "VERIFY":
			return "verification only: read, grep, find, ls, workbench_project_inspect, workbench_run_recipe, workbench_read_run (no free bash/edit/write; runs only declared recipes)";
		case "DEV":
			return "local development: reviewed local commits allowed (no push/publish/history rewrite)";
	}
}
