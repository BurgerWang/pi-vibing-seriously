/** Shared bounded text helpers for user-facing workbench commands. */

import { clampWholeResultText } from "./output-policy.ts";
import type { BoundedStringListDetails } from "./render.ts";

export const COMMAND_OUTPUT_MAX_BYTES = 16_384;
export const COMMAND_OUTPUT_MAX_LINES = 240;

export function boundedInlineDetail(value: unknown, maxBytes = 512): string {
	const clean = (typeof value === "string" ? value : "").replace(/[\x00-\x1f\x7f]/g, " ");
	return clampWholeResultText(clean, { maxBytes, maxLines: 1 }).text;
}

export function boundedCommandText(
	value: unknown,
	maxBytes = COMMAND_OUTPUT_MAX_BYTES,
	maxLines = COMMAND_OUTPUT_MAX_LINES,
): string {
	return clampWholeResultText(value, { maxBytes, maxLines }).text;
}

export function boundedDetailsList(
	values: readonly string[],
	maxItems: number,
	maxItemBytes: number,
): BoundedStringListDetails {
	const shown = values.slice(0, maxItems).map((value) => boundedInlineDetail(value, maxItemBytes));
	return {
		items: shown,
		original_items: values.length,
		shown_items: shown.length,
		omitted_items: values.length - shown.length,
	};
}
