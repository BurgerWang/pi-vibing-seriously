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
	type CompareToolDetails,
	type GateToolDetails,
	type InspectToolDetails,
	type ReadRunToolDetails,
	type RecipeToolDetails,
} from "../core/render.ts";

/** The subset of Theme the renderers use (testable with a passthrough fake). */
export type ThemeLike = Pick<Theme, "fg" | "bold">;

export type RendererKind = "inspect" | "recipe" | "gate" | "read_run" | "compare";

type StatusColor = "success" | "error" | "warning";

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
				const d = details as unknown as CompareToolDetails;
				if (!d.ok) {
					lines = [renderErrorLine(name, d.error)];
					color = "error";
				} else {
					lines = renderCompareLines(d.report, options.expanded);
					color = d.report.compatible ? "accent" : "warning";
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
