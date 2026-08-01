/**
 * P4 widget — the compact workbench widget above the editor (P4 spec §2).
 *
 * Rules:
 *   - shown only while a task is active, when the latest gate run is not a
 *     PASS, or when the user forced it on via `/q-widget on`
 *   - cleared (never left occupying terminal space) when none of those hold
 *   - in print/json modes the widget is a no-op: `widgetAction` returns
 *     "noop" when there is no UI, so no TUI-only API is ever reached
 *
 * Pure logic, no Pi imports; the extension wires this into `ctx.ui.setWidget`.
 */

import { fitToWidth } from "./format.ts";

export interface WidgetState {
	/** Current task (from the active agent prompt), truncated. */
	task?: string;
	/** Current phase, e.g. "running workbench_run_gate" or "idle". */
	phase?: string;
	/** Active gate summary, e.g. "Q3 FAIL (run 20260801-004)". */
	activeGate?: string;
	/** Last run summary, e.g. "20260801-004 npm test exit=1". */
	lastRun?: string;
	/** Blocking reason of the latest gate run, if any. */
	blockingReason?: string;
	/** A task is currently active (agent turn in progress). */
	taskActive: boolean;
	/** The latest gate run is not a PASS (FAIL / BLOCKED / NOT_RUN). */
	gateFailed: boolean;
	/** User forced the widget on with /q-widget on. */
	forced: boolean;
}

/** Whether the widget should be visible at all. */
export function shouldShowWidget(state: WidgetState): boolean {
	return state.forced || state.taskActive || state.gateFailed;
}

export type WidgetAction = "show" | "hide" | "noop";

/**
 * Decide what to do with the widget for a given UI availability.
 * Without UI (print/json modes) the widget is never touched ("noop").
 */
export function widgetAction(state: WidgetState, hasUI: boolean): WidgetAction {
	if (!hasUI) return "noop";
	return shouldShowWidget(state) ? "show" : "hide";
}

/** Labels used by the widget (P4 spec §2 content). Plain ASCII, no emoji. */
export const WIDGET_LABELS = ["task", "phase", "gate", "last run", "blocking"] as const;

/**
 * Build the widget lines. Missing fields are skipped (never "undefined").
 * When `width` is given, every line is fitted to it (narrow terminals).
 */
export function buildWidgetLines(state: WidgetState, options?: { width?: number }): string[] {
	const width = options?.width;
	const lines: string[] = [];
	const push = (label: string, value: string | undefined): void => {
		if (value === undefined || value.trim().length === 0) return;
		const line = `${label}: ${value}`;
		lines.push(width !== undefined ? fitToWidth(line, width) : line);
	};
	push("task", state.task);
	push("phase", state.phase);
	push("gate", state.activeGate);
	push("last run", state.lastRun);
	push("blocking", state.blockingReason);
	return lines;
}
