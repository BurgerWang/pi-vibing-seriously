/**
 * P4 TUI tool renderers — theme-colored Text components for the workbench
 * custom tools (P4 spec §3).
 *
 * The renderers only ever display the structured `details` payloads built by
 * the tool implementations (`core/render.ts` line builders); they never
 * re-read run files and never recompute metrics. Colors are an overlay on
 * the plain text — every fact is also available in the tool `content`
 * (print/json modes) and every semantic is carried by ASCII, not color or
 * emoji.
 *
 * These functions are only invoked by Pi in TUI mode; the tools themselves
 * guard all `ctx.ui` usage with `ctx.hasUI`, so print/json never reach
 * TUI-only APIs.
 */

import { Text, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import {
	renderCompareLines,
	renderErrorLine,
	renderGateLines,
	renderInspectLines,
	renderPartialLine,
	renderReadRunLines,
	renderRecipeLines,
	renderToolCallLine,
	type GateToolDetails,
	type InspectToolDetails,
	type ReadRunToolDetails,
	type RecipeToolDetails,
} from "../core/render.ts";

/** The subset of Theme the renderers use (testable with a passthrough fake). */
export type ThemeLike = Pick<Theme, "fg" | "bold">;

export type RendererKind = "inspect" | "recipe" | "gate" | "read_run" | "compare" | "review";

type StatusColor = "success" | "error" | "warning";

interface ProjectedCompareDetails {
	ok?: boolean;
	comparison_id?: string;
	a_run_id?: string;
	b_run_id?: string;
	compatible?: boolean;
	artifact_added_count?: number;
	artifact_removed_count?: number;
	gate_changed_count?: number;
	quant_changed_count?: number;
	parameter_changed_count?: number;
	comparison_path?: string;
	error?: string;
	/** Legacy in-memory payload; absent after bounded details projection. */
	report?: Parameters<typeof renderCompareLines>[0];
}

interface ProjectedReviewDetails {
	ok?: boolean;
	delegation_id?: string;
	verdict?: "PASS" | "FAIL";
	review_status?: string;
	bound_diff_hash?: string;
	recorded_after_hash?: string;
	mismatch?: boolean;
	violation_count?: number;
	drift_count?: number;
	checked_count?: number;
	displayed_count?: number;
	remaining_count?: number;
	coverage_complete?: boolean;
	review_record?: string;
	next_include_paths?: string[];
	patch_truncated?: boolean;
	error?: string;
}

function statusColor(status: string): StatusColor {
	if (status === "OK" || status === "PASS") return "success";
	if (status === "FAIL" || status === "FAILED") return "error";
	return "warning";
}

function extractErrorMessage(result: { content: { type: string; text?: string }[] }): string {
	const text = (result.content ?? [])
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join(" ")
		.trim();
	return text.length > 200 ? `${text.slice(0, 197)}...` : text || "unknown error";
}

/** First-line color + full styled text for a renderer result. */
function styledLines(lines: string[], color: StatusColor | "muted" | "accent", theme: ThemeLike): string {
	return lines
		.map((line, index) => (index === 0 ? theme.fg(color, line) : theme.fg("dim", line)))
		.join("\n");
}

/** Render the bounded comparison DTO without reloading its durable record. */
function renderProjectedCompareLines(details: ProjectedCompareDetails, expanded: boolean): string[] {
	const id = details.comparison_id ?? "?";
	const left = details.a_run_id ?? "?";
	const right = details.b_run_id ?? "?";
	const compatibility = details.compatible === true ? "compatible" : details.compatible === false ? "incompatible" : "unknown";
	const compact = `${compatibility} comparison:${id} ${left} vs ${right}`;
	if (!expanded) return [compact];
	const count = (value: number | undefined): string => Number.isSafeInteger(value) && value! >= 0 ? String(value) : "n/a";
	return [
		compact,
		`artifacts    : +${count(details.artifact_added_count)} -${count(details.artifact_removed_count)}`,
		`gate changes : ${count(details.gate_changed_count)}`,
		`quant changes: ${count(details.quant_changed_count)}`,
		`param changes: ${count(details.parameter_changed_count)}`,
		`record       : ${details.comparison_path ?? "(n/a)"}`,
	];
}

/** Render only persisted review counters and bounded continuation guidance. */
function renderProjectedReviewLines(details: ProjectedReviewDetails, expanded: boolean): string[] {
	const count = (value: number | undefined): string => Number.isSafeInteger(value) && value! >= 0 ? String(value) : "n/a";
	const verdict = details.verdict ?? "UNKNOWN";
	const compact = `${verdict} review:${details.delegation_id ?? "?"} coverage ${count(details.displayed_count)}/${count(details.checked_count)} remaining ${count(details.remaining_count)}`;
	if (!expanded) return [compact];
	return [
		compact,
		`review status : ${details.review_status ?? "unknown"}`,
		`scope issues  : ${count(details.violation_count)} violation(s), ${count(details.drift_count)} drift path(s)`,
		`coverage      : ${details.coverage_complete === true ? "complete" : "incomplete"}`,
		`hash mismatch : ${details.mismatch === true ? "yes" : "no"}`,
		`bound hash    : ${details.bound_diff_hash ?? "(n/a)"}`,
		`recorded hash : ${details.recorded_after_hash ?? "(n/a)"}`,
		`next paths    : ${count(details.next_include_paths?.length)} shown of ${count(details.remaining_count)} remaining`,
		`patch bounded : ${details.patch_truncated === true ? "yes" : "no"}`,
		`review record : ${details.review_record ?? "(n/a)"}`,
	];
}

/**
 * Build the renderCall/renderResult pair for one workbench tool kind.
 * Returns `undefined` for the fallback-safe default when the payload is
 * missing — never throws (pi falls back to raw text on renderer errors).
 */
export function workbenchToolRenderer(kind: RendererKind, name: string): { renderCall: (args: unknown, theme: ThemeLike, context: { lastComponent?: Component }) => Component; renderResult: (result: { details?: unknown; content: { type: string; text?: string }[] }, options: { expanded: boolean; isPartial: boolean }, theme: ThemeLike, context: { isError: boolean }) => Component } {
	const renderCall = (args: unknown, theme: ThemeLike, context: { lastComponent?: Component }): Component => {
		const line = `${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("muted", renderToolCallLine(name, (args ?? {}) as Record<string, unknown>))}`.trimEnd();
		const last = context.lastComponent;
		if (last instanceof Text) {
			last.setText(line);
			return last;
		}
		return new Text(line, 0, 0);
	};

	const renderResult = (
		result: { details?: unknown; content: { type: string; text?: string }[] },
		options: { expanded: boolean; isPartial: boolean },
		theme: ThemeLike,
		context: { isError: boolean },
	): Component => {
		if (context.isError) {
			return new Text(theme.fg("error", renderErrorLine(name, extractErrorMessage(result))), 0, 0);
		}
		if (options.isPartial) {
			const details = (result.details ?? {}) as { phase?: string };
			return new Text(theme.fg("muted", renderPartialLine(name, details.phase)), 0, 0);
		}

		const details = (result.details ?? {}) as Record<string, unknown>;
		let color: StatusColor | "muted" | "accent" = "muted";
		let lines: string[];

		switch (kind) {
			case "inspect": {
				const d = details as unknown as InspectToolDetails;
				lines = renderInspectLines(d, options.expanded);
				color = "accent";
				break;
			}
			case "recipe": {
				const d = details as unknown as RecipeToolDetails;
				lines = renderRecipeLines(d, options.expanded);
				color = statusColor(d.status ?? "?");
				break;
			}
			case "gate": {
				const d = details as unknown as GateToolDetails;
				lines = renderGateLines(d, options.expanded);
				color = statusColor(d.status ?? "?");
				break;
			}
			case "read_run": {
				const d = details as unknown as ReadRunToolDetails;
				lines = renderReadRunLines(d, options.expanded);
				color = statusColor(d.status ?? "?");
				break;
			}
			case "compare": {
				const d = details as ProjectedCompareDetails;
				if (d.ok !== true) {
					const message = extractErrorMessage(result);
					lines = [renderErrorLine(name, message === "unknown error" ? d.error ?? "comparison unavailable" : message)];
					color = "error";
				} else if (d.report && typeof d.report === "object") {
					// Backward-compatible rendering for already-open legacy results.
					lines = renderCompareLines(d.report, options.expanded);
					color = d.report.compatible ? "accent" : "warning";
				} else {
					lines = renderProjectedCompareLines(d, options.expanded);
					color = d.compatible === true ? "accent" : "warning";
				}
				break;
			}
			case "review": {
				const d = details as ProjectedReviewDetails;
				if (d.ok !== true) {
					const message = extractErrorMessage(result);
					lines = [renderErrorLine(name, message === "unknown error" ? d.error ?? "review unavailable" : message)];
					color = "error";
				} else {
					lines = renderProjectedReviewLines(d, options.expanded);
					color = d.verdict === "FAIL" ? "error" : d.coverage_complete === true ? "success" : "warning";
				}
				break;
			}
			default:
				lines = [name];
		}
		return new Text(styledLines(lines, color, theme), 0, 0);
	};

	return { renderCall, renderResult };
}
