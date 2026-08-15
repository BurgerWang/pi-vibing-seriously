/**
 * Context-output hard limits approved for the v1 control plane.
 *
 * R0 uses the single-result limits for an emergency whole-result clamp.
 * Later phases consume the remaining constants when they add reservations,
 * history projection, details projection, and streaming-update envelopes.
 * These are compile-time ceilings: callers may request less, never more.
 */
export const NATIVE_READ_MAX_BYTES = 12_288 as const;
export const NATIVE_READ_MAX_FILE_LINES = 240 as const;
export const NATIVE_READ_MAX_TOTAL_LINES = 252 as const;

export const DEFAULT_RESULT_MAX_BYTES = 16_384 as const;
export const DEFAULT_RESULT_MAX_LINES = 240 as const;
export const RUN_LOG_RESULT_MAX_BYTES = 32_768 as const;
export const RUN_LOG_RESULT_MAX_LINES = 400 as const;
export const DIFF_REVIEW_RESULT_MAX_BYTES = 32_768 as const;
export const DIFF_REVIEW_RESULT_MAX_LINES = 400 as const;
export const COMPARE_RESULT_MAX_BYTES = 32_768 as const;
export const COMPARE_RESULT_MAX_LINES = 400 as const;
export const ERROR_RESULT_MAX_BYTES = 8_192 as const;

export const COMMANDER_TURN_MAX_BYTES = 65_536 as const;
export const COMMANDER_HISTORY_MAX_BYTES = 196_608 as const;
export const WORKER_TURN_MAX_BYTES = 49_152 as const;
export const WORKER_HISTORY_MAX_BYTES = 131_072 as const;
export const OTHER_HISTORY_MAX_BYTES = 65_536 as const;
export const DETAILS_MAX_BYTES = 8_192 as const;
export const STREAM_UPDATE_MAX_BYTES = 4_096 as const;
export const MAX_TOOL_CALLS_PER_TURN = 16 as const;
export const HISTORY_MAX_TOOL_BUNDLES = 128 as const;

export const OUTPUT_HARD_CAPS = Object.freeze({
	nativeRead: Object.freeze({
		maxBytes: NATIVE_READ_MAX_BYTES,
		maxFileLines: NATIVE_READ_MAX_FILE_LINES,
		maxTotalLines: NATIVE_READ_MAX_TOTAL_LINES,
	}),
	defaultResult: Object.freeze({ maxBytes: DEFAULT_RESULT_MAX_BYTES, maxLines: DEFAULT_RESULT_MAX_LINES }),
	runLogResult: Object.freeze({ maxBytes: RUN_LOG_RESULT_MAX_BYTES, maxLines: RUN_LOG_RESULT_MAX_LINES }),
	diffReviewResult: Object.freeze({ maxBytes: DIFF_REVIEW_RESULT_MAX_BYTES, maxLines: DIFF_REVIEW_RESULT_MAX_LINES }),
	compareResult: Object.freeze({ maxBytes: COMPARE_RESULT_MAX_BYTES, maxLines: COMPARE_RESULT_MAX_LINES }),
	errorResult: Object.freeze({ maxBytes: ERROR_RESULT_MAX_BYTES }),
	commander: Object.freeze({ turnMaxBytes: COMMANDER_TURN_MAX_BYTES, historyMaxBytes: COMMANDER_HISTORY_MAX_BYTES }),
	worker: Object.freeze({ turnMaxBytes: WORKER_TURN_MAX_BYTES, historyMaxBytes: WORKER_HISTORY_MAX_BYTES }),
	other: Object.freeze({ turnMaxBytes: WORKER_TURN_MAX_BYTES, historyMaxBytes: OTHER_HISTORY_MAX_BYTES }),
	detailsMaxBytes: DETAILS_MAX_BYTES,
	streamUpdateMaxBytes: STREAM_UPDATE_MAX_BYTES,
	maxToolCallsPerTurn: MAX_TOOL_CALLS_PER_TURN,
	historyMaxToolBundles: HISTORY_MAX_TOOL_BUNDLES,
});

export type OutputPolicyId =
	| "native-read-page"
	| "native-search"
	| "run-summary"
	| "run-log-page"
	| "gate-summary"
	| "gate-read"
	| "diff-review"
	| "compare"
	| "worker-handoff"
	| "recovery"
	| "default";

export type OutputOverflow = "cursor" | "source-pointer" | "artifact-pointer" | "narrow-query" | "receipt-only";

export interface ToolOutputPolicy {
	id: OutputPolicyId;
	maxTextBytes: number;
	maxLines: number;
	minReservationBytes: number;
	overflow: OutputOverflow;
	preserveImages: boolean;
}

export interface OutputPolicyHardCeiling {
	id: OutputPolicyId;
	maxTextBytes: number;
	maxLines: number;
	preserveImages: boolean;
}

/**
 * Immutable ceilings keyed only by the trusted policy identifier.
 *
 * Some resolved policies deliberately request a lower cap for a particular
 * tool variant. The envelope intersects that caller-supplied lower cap with
 * this table, so a forged ToolOutputPolicy object can never enlarge output or
 * enable images for another policy.
 */
const POLICY_HARD_CEILINGS: Readonly<Record<OutputPolicyId, Readonly<OutputPolicyHardCeiling>>> = Object.freeze({
	"native-read-page": Object.freeze({ id: "native-read-page", maxTextBytes: NATIVE_READ_MAX_BYTES, maxLines: NATIVE_READ_MAX_TOTAL_LINES, preserveImages: true }),
	"native-search": Object.freeze({ id: "native-search", maxTextBytes: DEFAULT_RESULT_MAX_BYTES, maxLines: DEFAULT_RESULT_MAX_LINES, preserveImages: false }),
	"run-summary": Object.freeze({ id: "run-summary", maxTextBytes: DEFAULT_RESULT_MAX_BYTES, maxLines: DEFAULT_RESULT_MAX_LINES, preserveImages: false }),
	"run-log-page": Object.freeze({ id: "run-log-page", maxTextBytes: RUN_LOG_RESULT_MAX_BYTES, maxLines: RUN_LOG_RESULT_MAX_LINES, preserveImages: false }),
	"gate-summary": Object.freeze({ id: "gate-summary", maxTextBytes: DEFAULT_RESULT_MAX_BYTES, maxLines: DEFAULT_RESULT_MAX_LINES, preserveImages: false }),
	"gate-read": Object.freeze({ id: "gate-read", maxTextBytes: 24_576, maxLines: 320, preserveImages: false }),
	"diff-review": Object.freeze({ id: "diff-review", maxTextBytes: DIFF_REVIEW_RESULT_MAX_BYTES, maxLines: DIFF_REVIEW_RESULT_MAX_LINES, preserveImages: false }),
	compare: Object.freeze({ id: "compare", maxTextBytes: COMPARE_RESULT_MAX_BYTES, maxLines: COMPARE_RESULT_MAX_LINES, preserveImages: false }),
	"worker-handoff": Object.freeze({ id: "worker-handoff", maxTextBytes: NATIVE_READ_MAX_BYTES, maxLines: 120, preserveImages: false }),
	recovery: Object.freeze({ id: "recovery", maxTextBytes: ERROR_RESULT_MAX_BYTES, maxLines: 120, preserveImages: false }),
	default: Object.freeze({ id: "default", maxTextBytes: DEFAULT_RESULT_MAX_BYTES, maxLines: DEFAULT_RESULT_MAX_LINES, preserveImages: false }),
});

/** Pure hard-ceiling lookup. Unknown identifiers fail to the bounded default. */
export function resolveOutputPolicyHardCeiling(id: unknown): Readonly<OutputPolicyHardCeiling> {
	return typeof id === "string" && Object.prototype.hasOwnProperty.call(POLICY_HARD_CEILINGS, id)
		? POLICY_HARD_CEILINGS[id as OutputPolicyId]
		: POLICY_HARD_CEILINGS.default;
}

export interface ResolveToolOutputPolicyInput {
	toolName: string;
	args: unknown;
	role: "commander" | "worker" | "other";
}

const POLICY = Object.freeze({
	nativeRead: Object.freeze<ToolOutputPolicy>({ id: "native-read-page", maxTextBytes: NATIVE_READ_MAX_BYTES, maxLines: NATIVE_READ_MAX_TOTAL_LINES, minReservationBytes: 2_048, overflow: "cursor", preserveImages: true }),
	nativeSearch: Object.freeze<ToolOutputPolicy>({ id: "native-search", maxTextBytes: DEFAULT_RESULT_MAX_BYTES, maxLines: DEFAULT_RESULT_MAX_LINES, minReservationBytes: 2_048, overflow: "narrow-query", preserveImages: false }),
	runSummary: Object.freeze<ToolOutputPolicy>({ id: "run-summary", maxTextBytes: 8_192, maxLines: 120, minReservationBytes: 2_048, overflow: "source-pointer", preserveImages: false }),
	runRecipe: Object.freeze<ToolOutputPolicy>({ id: "run-summary", maxTextBytes: DEFAULT_RESULT_MAX_BYTES, maxLines: DEFAULT_RESULT_MAX_LINES, minReservationBytes: 4_096, overflow: "source-pointer", preserveImages: false }),
	runLog: Object.freeze<ToolOutputPolicy>({ id: "run-log-page", maxTextBytes: RUN_LOG_RESULT_MAX_BYTES, maxLines: RUN_LOG_RESULT_MAX_LINES, minReservationBytes: 4_096, overflow: "cursor", preserveImages: false }),
	gateSummary: Object.freeze<ToolOutputPolicy>({ id: "gate-summary", maxTextBytes: DEFAULT_RESULT_MAX_BYTES, maxLines: DEFAULT_RESULT_MAX_LINES, minReservationBytes: 4_096, overflow: "artifact-pointer", preserveImages: false }),
	gateRead: Object.freeze<ToolOutputPolicy>({ id: "gate-read", maxTextBytes: 24_576, maxLines: 320, minReservationBytes: 4_096, overflow: "source-pointer", preserveImages: false }),
	gateList: Object.freeze<ToolOutputPolicy>({ id: "gate-read", maxTextBytes: DEFAULT_RESULT_MAX_BYTES, maxLines: DEFAULT_RESULT_MAX_LINES, minReservationBytes: 2_048, overflow: "narrow-query", preserveImages: false }),
	diffReview: Object.freeze<ToolOutputPolicy>({ id: "diff-review", maxTextBytes: DIFF_REVIEW_RESULT_MAX_BYTES, maxLines: DIFF_REVIEW_RESULT_MAX_LINES, minReservationBytes: 4_096, overflow: "narrow-query", preserveImages: false }),
	compare: Object.freeze<ToolOutputPolicy>({ id: "compare", maxTextBytes: COMPARE_RESULT_MAX_BYTES, maxLines: COMPARE_RESULT_MAX_LINES, minReservationBytes: 4_096, overflow: "artifact-pointer", preserveImages: false }),
	workerHandoff: Object.freeze<ToolOutputPolicy>({ id: "worker-handoff", maxTextBytes: NATIVE_READ_MAX_BYTES, maxLines: 120, minReservationBytes: 4_096, overflow: "source-pointer", preserveImages: false }),
	recovery: Object.freeze<ToolOutputPolicy>({ id: "recovery", maxTextBytes: ERROR_RESULT_MAX_BYTES, maxLines: 120, minReservationBytes: 2_048, overflow: "receipt-only", preserveImages: false }),
	default: Object.freeze<ToolOutputPolicy>({ id: "default", maxTextBytes: DEFAULT_RESULT_MAX_BYTES, maxLines: DEFAULT_RESULT_MAX_LINES, minReservationBytes: 2_048, overflow: "receipt-only", preserveImages: false }),
});

function readRunInclude(args: unknown): unknown {
	try {
		if (typeof args !== "object" || args === null) return undefined;
		return (args as { include?: unknown }).include;
	} catch {
		return undefined;
	}
}

/** Pure, deterministic policy resolution. Unknown tools and hostile args fail to the fixed default. */
export function resolveToolOutputPolicy(input: ResolveToolOutputPolicyInput): ToolOutputPolicy {
	let toolName: string;
	try {
		toolName = typeof input.toolName === "string" ? input.toolName : "";
	} catch {
		return POLICY.default;
	}
	switch (toolName) {
		case "read": return POLICY.nativeRead;
		case "grep":
		case "find":
		case "ls": return POLICY.nativeSearch;
		case "workbench_run_recipe": return POLICY.runRecipe;
		case "workbench_read_run": {
			const include = readRunInclude(input.args);
			return include === "logs" || include === "all" ? POLICY.runLog : POLICY.runSummary;
		}
		case "workbench_run_gate": return POLICY.gateSummary;
		case "workbench_read_gate": return POLICY.gateRead;
		case "workbench_list_gates": return POLICY.gateList;
		case "workbench_compare_runs": return POLICY.compare;
		case "workbench_delegate_worker": return POLICY.workerHandoff;
		case "workbench_review_worker_diff": return POLICY.diffReview;
		case "workbench_recover_tool_result": return POLICY.recovery;
		default: return POLICY.default;
	}
}

const ABSOLUTE_SINGLE_RESULT_MAX_BYTES = Math.max(
	DEFAULT_RESULT_MAX_BYTES,
	RUN_LOG_RESULT_MAX_BYTES,
	DIFF_REVIEW_RESULT_MAX_BYTES,
	COMPARE_RESULT_MAX_BYTES,
);
const ABSOLUTE_SINGLE_RESULT_MAX_LINES = Math.max(
	DEFAULT_RESULT_MAX_LINES,
	RUN_LOG_RESULT_MAX_LINES,
	DIFF_REVIEW_RESULT_MAX_LINES,
	COMPARE_RESULT_MAX_LINES,
);
const FAILURE_TEXT = "workbench output control failure (bounded fail-closed result)";

export interface WholeResultCaps {
	maxBytes: number;
	maxLines: number;
}

export interface WholeResultClamp {
	text: string;
	truncated: boolean;
	failed: boolean;
	originalBytes: number;
	originalLines: number;
	shownBytes: number;
	shownLines: number;
	omittedBytes: number;
	omittedLines: number;
}

function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function textLines(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

/** Replace malformed UTF-16 with U+FFFD while preserving valid pairs. */
function unicodeScalarText(value: string): string {
	let output = "";
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				output += value.slice(index, index + 2);
				index += 1;
			} else {
				output += "\ufffd";
			}
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			output += "\ufffd";
		} else {
			output += value[index];
		}
	}
	return output;
}

/** Prefix bounded simultaneously by UTF-8 bytes and rendered line count. */
function boundedPrefix(text: string, maxBytes: number, maxLines: number): string {
	if (maxBytes <= 0 || maxLines <= 0 || text.length === 0) return "";
	let output = "";
	let usedBytes = 0;
	let usedLines = 0;
	for (const scalar of text) {
		const scalarBytes = utf8Bytes(scalar);
		const candidateLines = output.length === 0
			? scalar === "\n" ? 2 : 1
			: usedLines + (scalar === "\n" ? 1 : 0);
		if (usedBytes + scalarBytes > maxBytes || candidateLines > maxLines) break;
		output += scalar;
		usedBytes += scalarBytes;
		usedLines = candidateLines;
	}
	return output;
}

/**
 * Resolve a caller cap without ever enlarging an explicit value.
 *
 * Only an omitted value receives the policy default. Invalid, non-positive,
 * non-finite, throwing, or sub-unit values resolve to zero: output control
 * fails closed instead of silently replacing a bad lower cap with a larger
 * default. Positive values are floored and can only be lowered by the hard
 * ceiling.
 */
function resolveCap(options: WholeResultCaps | undefined, key: keyof WholeResultCaps, fallback: number, ceiling: number): number {
	let value: number | undefined;
	try {
		value = options?.[key];
	} catch {
		return 0;
	}
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.min(Math.max(0, Math.floor(value)), ceiling);
}

function failureResult(maxBytes: number, maxLines: number): WholeResultClamp {
	const errorBytes = Math.min(maxBytes, ERROR_RESULT_MAX_BYTES);
	const text = boundedPrefix(FAILURE_TEXT, errorBytes, maxLines);
	return {
		text,
		truncated: true,
		failed: true,
		originalBytes: 0,
		originalLines: 0,
		shownBytes: utf8Bytes(text),
		shownLines: textLines(text),
		omittedBytes: 0,
		omittedLines: 0,
	};
}

function truncationMarker(omittedBytes: number, omittedLines: number): string {
	return `[workbench-output truncated omitted_bytes=${omittedBytes} omitted_lines=${omittedLines}]`;
}

function clampString(input: string, maxBytes: number, maxLines: number): WholeResultClamp {
	const source = unicodeScalarText(input);
	const originalBytes = utf8Bytes(source);
	const originalLines = textLines(source);
	if (originalBytes <= maxBytes && originalLines <= maxLines) {
		return {
			text: source,
			truncated: false,
			failed: false,
			originalBytes,
			originalLines,
			shownBytes: originalBytes,
			shownLines: originalLines,
			omittedBytes: 0,
			omittedLines: 0,
		};
	}

	let marker = truncationMarker(originalBytes, originalLines);
	let prefix = "";
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const markerBytes = utf8Bytes(marker);
		const contentBytes = Math.max(0, maxBytes - markerBytes - 1);
		prefix = boundedPrefix(source, contentBytes, Math.max(0, maxLines - 1));
		const omittedBytes = Math.max(0, originalBytes - utf8Bytes(prefix));
		const omittedLines = Math.max(0, originalLines - textLines(prefix));
		const nextMarker = truncationMarker(omittedBytes, omittedLines);
		if (nextMarker === marker) break;
		marker = nextMarker;
	}

	const markerOnly = boundedPrefix(marker, maxBytes, maxLines);
	let text = prefix.length > 0 ? `${prefix}\n${marker}` : markerOnly;
	if (utf8Bytes(text) > maxBytes || textLines(text) > maxLines) {
		prefix = "";
		text = markerOnly;
	}
	const sourceShownBytes = utf8Bytes(prefix);
	const sourceShownLines = textLines(prefix);
	return {
		text,
		truncated: true,
		failed: false,
		originalBytes,
		originalLines,
		shownBytes: utf8Bytes(text),
		shownLines: textLines(text),
		omittedBytes: Math.max(0, originalBytes - sourceShownBytes),
		omittedLines: Math.max(0, originalLines - sourceShownLines),
	};
}

/**
 * R0 emergency whole-result clamp.
 *
 * The marker is reserved before source text, so it is inside both hard
 * limits. Any conversion or clamp failure returns a fixed bounded error and
 * never returns the original content.
 */
export function clampWholeResultText(input: unknown, options?: WholeResultCaps): WholeResultClamp {
	const maxBytes = resolveCap(options, "maxBytes", DEFAULT_RESULT_MAX_BYTES, ABSOLUTE_SINGLE_RESULT_MAX_BYTES);
	const maxLines = resolveCap(options, "maxLines", DEFAULT_RESULT_MAX_LINES, ABSOLUTE_SINGLE_RESULT_MAX_LINES);
	try {
		return clampString(typeof input === "string" ? input : String(input), maxBytes, maxLines);
	} catch {
		return failureResult(maxBytes, maxLines);
	}
}
