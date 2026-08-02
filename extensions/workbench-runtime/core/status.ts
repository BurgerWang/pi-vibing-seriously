/**
 * P4 status bar — the workbench footer status line (P4 spec §1).
 *
 * Uses `ctx.ui.setStatus` (a persistent footer status slot) — the whole Pi
 * footer is never replaced. Pure line construction, no Pi imports.
 *
 * Example:
 *   WB:VERIFY | quant-research/stock-selection | Q3:FAIL | run:20260801-004
 */

import type { WorkbenchMode } from "./mode-policy.ts";
import { fitToWidth } from "./format.ts";

export interface StatusLineInput {
	mode: WorkbenchMode;
	/** Selected profile from project.yaml, e.g. "quant-research/stock-selection". */
	profile?: string;
	/**
	 * Active gate — the most relevant gate of the latest gate run
	 * (worst status; the gate that blocks progress, if any).
	 */
	activeGate?: { id: string; status: string; run_id?: string };
	/** Latest run record (recipe or gate). */
	latestRun?: { run_id: string; status: string; ok: boolean };
	/**
	 * P6-A compact cache segment, e.g. "CACHE 72% | read 184k | miss 71k"
	 * (or "CACHE N/A" when the usage semantics are not verified). Appended
	 * as-is when present — only shown when the data is valid.
	 */
	cache?: string;
}

const MAX_PROFILE_WIDTH = 32;

/**
 * Build the status line. Missing parts are skipped; every present part is
 * shown. The latest-run status is implied by `ok` (OK runs show only the id,
 * like the P4 example; non-OK runs append ":<STATUS>").
 */
export function buildStatusLine(input: StatusLineInput): string {
	const parts = [`WB:${input.mode}`];
	if (input.profile) parts.push(fitToWidth(input.profile, MAX_PROFILE_WIDTH));
	if (input.activeGate) parts.push(`${input.activeGate.id}:${input.activeGate.status}`);
	if (input.latestRun) {
		parts.push(`run:${input.latestRun.run_id}${input.latestRun.ok ? "" : `:${input.latestRun.status}`}`);
	}
	if (input.cache) parts.push(input.cache);
	return parts.join(" | ");
}
