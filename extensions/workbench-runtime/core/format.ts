/**
 * P4 display formatting helpers — pure, framework-free, ANSI-free.
 *
 * All TUI rendering (status bar, widget, tool renderers) builds on these so
 * the same strings stay readable in print/json modes and in terminals
 * without color support. No emoji is used to carry semantics anywhere in
 * the workbench UI.
 */

/** Human duration: "850ms", "1.2s", "2m 3s". */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "n/a";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

/** Compact finite number without trailing zeros; non-finite becomes "n/a". */
export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) return "n/a";
	if (Number.isInteger(value)) return String(value);
	return value.toFixed(4).replace(/\.?0+$/, "");
}

/** "0.04 -> 0.05 (+0.01)" — descriptive only, never a verdict. */
export function formatDelta(a: number, b: number): string {
	if (!Number.isFinite(a) || !Number.isFinite(b)) return `${formatNumber(a)} -> ${formatNumber(b)}`;
	const d = b - a;
	const sign = d > 0 ? "+" : "";
	return `${formatNumber(a)} -> ${formatNumber(b)} (${sign}${formatNumber(d)})`;
}

/** Status label of a run record: OK / FAILED / TIMED OUT / CANCELLED / KILLED. */
export function runStatusLabel(record: {
	exit_code: number | null;
	timed_out: boolean;
	cancelled: boolean;
	expected_exit_codes: readonly number[];
	run_outcome?: "SUCCESS" | "PROCESS_FAILED" | "ARTIFACT_FAILED" | "COMMAND_EFFECT_FAILED";
}): string {
	if (record.timed_out) return "TIMED OUT";
	if (record.cancelled) return "CANCELLED";
	if (record.run_outcome === "ARTIFACT_FAILED" || record.run_outcome === "PROCESS_FAILED" || record.run_outcome === "COMMAND_EFFECT_FAILED") return "FAILED";
	if (record.exit_code === null) return "KILLED";
	return record.expected_exit_codes.includes(record.exit_code) ? "OK" : "FAILED";
}

/**
 * Truncate a line to a display width (code points) with an ellipsis.
 * Used for narrow-terminal degradation of the status bar and widget lines.
 * width <= 0 returns the line unchanged; width <= 3 degenerates to dots.
 */
export function fitToWidth(line: string, width: number): string {
	if (width <= 0) return line;
	const chars = Array.from(line);
	if (chars.length <= width) return line;
	if (width <= 3) return ".".repeat(width);
	return chars.slice(0, width - 3).join("") + "...";
}
