import { types as utilTypes } from "node:util";

import {
	COMMANDER_HISTORY_MAX_BYTES,
	COMMANDER_TURN_MAX_BYTES,
	WORKER_HISTORY_MAX_BYTES,
	WORKER_TURN_MAX_BYTES,
	resolveOutputPolicyHardCeiling,
	type OutputPolicyId,
} from "./output-policy.ts";

/** Persisted Pi custom-entry identity for session-scoped output telemetry. */
export const OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE = "workbench-output-control-telemetry-v1" as const;
export const OUTPUT_CONTROL_TELEMETRY_SCHEMA = "workbench-output-control-telemetry-v1" as const;
export const OUTPUT_CONTROL_STATUS_MAX_BYTES = 8_192 as const;

export type OutputControlRole = "commander" | "worker" | "other";
export type OutputControlAdvisoryBand = "OK" | "SOFT" | "HIGH";
export type OutputControlCompliance = "COMPLIANT" | "VIOLATION";

/**
 * Fixed, non-user-controlled identifiers. Unknown tool names are aggregated
 * into `other`; arbitrary names are never persisted or rendered.
 */
export const OUTPUT_CONTROL_TOOL_IDS = [
	"read",
	"grep",
	"find",
	"ls",
	"workbench_project_inspect",
	"workbench_run_recipe",
	"workbench_read_run",
	"workbench_run_gate",
	"workbench_read_gate",
	"workbench_list_gates",
	"workbench_compare_runs",
	"workbench_delegate_worker",
	"workbench_review_worker_diff",
	"workbench_delegation_status",
	"workbench_recover_tool_result",
	"other",
] as const;

export type OutputControlToolId = (typeof OUTPUT_CONTROL_TOOL_IDS)[number];

/** The exact cumulative fact set required by the v1 control plane. */
export interface OutputControlTotals {
	toolResults: number;
	rawTextBytes: number;
	shownTextBytes: number;
	omittedTextBytes: number;
	truncatedResults: number;
	blockedCalls: number;
	batchReservedBytes: number;
	historyCollapsedResults: number;
	historyRemovedBundles: number;
}

export interface OutputControlPerToolTotals {
	tool: OutputControlToolId;
	toolResults: number;
	rawTextBytes: number;
	shownTextBytes: number;
	omittedTextBytes: number;
	truncatedResults: number;
	maxResultBytes: number;
}

/**
 * Canonical session snapshot. Every string is a fixed enum; every remaining
 * field is a non-negative safe integer. No content, args, cursors, paths, or
 * error prose can be represented by this type.
 */
export interface OutputControlTelemetrySnapshot {
	schema: typeof OUTPUT_CONTROL_TELEMETRY_SCHEMA;
	role: OutputControlRole;
	totals: Readonly<OutputControlTotals>;
	perTool: ReadonlyArray<Readonly<OutputControlPerToolTotals>>;
	maxResultBytes: number;
	maxBatchReservedBytes: number;
	activeHistoryToolTextBytes: number;
	turnHardCapBytes: number;
	historyHardCapBytes: number;
	envelopeCapViolations: number;
	turnCapViolations: number;
	historyCapViolations: number;
	hardCapViolations: number;
	advisory: OutputControlAdvisoryBand;
	compliance: OutputControlCompliance;
}

export interface OutputControlCustomEntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

const TOOL_ID_SET = new Set<string>(OUTPUT_CONTROL_TOOL_IDS);
const TOOL_ORDINAL = new Map<string, number>(OUTPUT_CONTROL_TOOL_IDS.map((tool, index) => [tool, index]));
const ROLE_SET = new Set<OutputControlRole>(["commander", "worker", "other"]);
const POLICY_IDS = new Set<OutputPolicyId>([
	"native-read-page", "native-search", "run-summary", "run-log-page", "gate-summary", "gate-read",
	"diff-review", "compare", "worker-handoff", "recovery", "default",
]);
const ENVELOPE_REASONS = new Set(["none", "per-tool-cap", "turn-reservation", "runtime-failure"]);

const TOTAL_KEYS = [
	"toolResults", "rawTextBytes", "shownTextBytes", "omittedTextBytes", "truncatedResults", "blockedCalls",
	"batchReservedBytes", "historyCollapsedResults", "historyRemovedBundles",
] as const;
const PER_TOOL_KEYS = [
	"tool", "toolResults", "rawTextBytes", "shownTextBytes", "omittedTextBytes", "truncatedResults", "maxResultBytes",
] as const;
const SNAPSHOT_KEYS = [
	"schema", "role", "totals", "perTool", "maxResultBytes", "maxBatchReservedBytes",
	"activeHistoryToolTextBytes", "turnHardCapBytes", "historyHardCapBytes", "envelopeCapViolations",
	"turnCapViolations", "historyCapViolations", "hardCapViolations", "advisory", "compliance",
] as const;
const ENVELOPE_KEYS = [
	"schema", "policy", "truncated", "originalTextBytes", "originalTextLines", "shownTextBytes", "shownTextLines",
	"omittedTextBytes", "omittedTextLines", "originalImageCount", "shownImageCount", "omittedImageCount", "reason",
	"continuation",
] as const;
const TURN_KEYS = [
	"schema", "turnSerial", "role", "planned", "maxBytes", "reservationCount", "blockedCalls", "consumedCalls",
	"releasedCalls", "reservedBytes", "consumedBytes", "controlConsumedBytes", "totalAccountedBytes", "releasedBytes",
	"unusedBytes",
] as const;
const HISTORY_KEYS = [
	"originalToolTextBytes", "finalToolTextBytes", "collapsedResults", "removedBundles", "protectedLatestBundles",
] as const;

// Observation-only advisory thresholds. They never participate in hard-cap
// decisions; enforcement has already happened in envelope/turn/history code.
export const OUTPUT_CONTROL_ADVISORY_THRESHOLDS = Object.freeze({
	softTruncatedResults: 4,
	highTruncatedResults: 12,
	softHistoryCollapsedResults: 8,
	highHistoryCollapsedResults: 32,
	softHistoryRemovedBundles: 2,
	highHistoryRemovedBundles: 8,
});

function emptyTotals(): OutputControlTotals {
	return {
		toolResults: 0,
		rawTextBytes: 0,
		shownTextBytes: 0,
		omittedTextBytes: 0,
		truncatedResults: 0,
		blockedCalls: 0,
		batchReservedBytes: 0,
		historyCollapsedResults: 0,
		historyRemovedBundles: 0,
	};
}

export function emptyOutputControlTotals(): OutputControlTotals {
	return emptyTotals();
}

function emptyTool(tool: OutputControlToolId): OutputControlPerToolTotals {
	return {
		tool,
		toolResults: 0,
		rawTextBytes: 0,
		shownTextBytes: 0,
		omittedTextBytes: 0,
		truncatedResults: 0,
		maxResultBytes: 0,
	};
}

/** Saturating addition preserves the safe-integer invariant indefinitely. */
function addSafe(left: number, right: number): number {
	if (left >= Number.MAX_SAFE_INTEGER || right >= Number.MAX_SAFE_INTEGER - left) return Number.MAX_SAFE_INTEGER;
	return left + right;
}

function normalizeRole(value: unknown): OutputControlRole {
	return value === "commander" || value === "worker" ? value : "other";
}

function turnCap(role: OutputControlRole): number {
	return role === "commander" ? COMMANDER_TURN_MAX_BYTES : WORKER_TURN_MAX_BYTES;
}

function historyCap(role: OutputControlRole): number {
	return role === "commander" ? COMMANDER_HISTORY_MAX_BYTES : WORKER_HISTORY_MAX_BYTES;
}

function toolId(value: unknown): OutputControlToolId {
	return typeof value === "string" && TOOL_ID_SET.has(value) ? value as OutputControlToolId : "other";
}

function isSafeCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

interface ExactRecord {
	readonly values: Readonly<Record<string, unknown>>;
}

/** Read only own, enumerable data properties. Proxies/accessors fail closed. */
function exactRecord(value: unknown, allowedKeys: readonly string[], requiredKeys = allowedKeys): ExactRecord | undefined {
	try {
		if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return undefined;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const names = Object.keys(descriptors);
		const allowed = new Set(allowedKeys);
		if (names.some((name) => !allowed.has(name))) return undefined;
		for (const required of requiredKeys) if (!Object.prototype.hasOwnProperty.call(descriptors, required)) return undefined;
		const values: Record<string, unknown> = Object.create(null);
		for (const name of names) {
			const descriptor = descriptors[name];
			if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return undefined;
			values[name] = descriptor.value;
		}
		return { values };
	} catch {
		return undefined;
	}
}

function ownDataValue(value: unknown, key: string): { ok: boolean; value?: unknown } {
	try {
		if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return { ok: false };
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return { ok: false };
		return { ok: true, value: descriptor.value };
	} catch {
		return { ok: false };
	}
}

function parseTotals(value: unknown): OutputControlTotals | undefined {
	const record = exactRecord(value, TOTAL_KEYS);
	if (!record) return undefined;
	const output = emptyTotals();
	for (const key of TOTAL_KEYS) {
		const candidate = record.values[key];
		if (!isSafeCount(candidate)) return undefined;
		output[key] = candidate;
	}
	if (output.truncatedResults > output.toolResults) return undefined;
	return output;
}

function parseTool(value: unknown): OutputControlPerToolTotals | undefined {
	const record = exactRecord(value, PER_TOOL_KEYS);
	if (!record) return undefined;
	const fixedTool = record.values.tool;
	if (typeof fixedTool !== "string" || !TOOL_ID_SET.has(fixedTool)) return undefined;
	const output = emptyTool(fixedTool as OutputControlToolId);
	for (const key of [
		"toolResults", "rawTextBytes", "shownTextBytes", "omittedTextBytes", "truncatedResults", "maxResultBytes",
	] as const) {
		const candidate = record.values[key];
		if (!isSafeCount(candidate)) return undefined;
		output[key] = candidate;
	}
	if (output.toolResults <= 0 || output.truncatedResults > output.toolResults) return undefined;
	if (output.omittedTextBytes > output.rawTextBytes || output.maxResultBytes > output.shownTextBytes) return undefined;
	return output;
}

function strictDenseArray(value: unknown, maxItems: number): unknown[] | undefined {
	try {
		if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > maxItems) return undefined;
		if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (key === "length") {
				if (!Object.prototype.hasOwnProperty.call(descriptor, "value") || descriptor.value !== value.length) return undefined;
				continue;
			}
			if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return undefined;
			const index = Number(key);
			if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) return undefined;
			if (descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return undefined;
		}
		for (let index = 0; index < value.length; index += 1) {
			if (!Object.prototype.hasOwnProperty.call(descriptors, String(index))) return undefined;
		}
		return value;
	} catch {
		return undefined;
	}
}

export function evaluateOutputControlAdvisory(value: unknown): OutputControlAdvisoryBand {
	const totals = parseTotals(value) ?? emptyTotals();
	const thresholds = OUTPUT_CONTROL_ADVISORY_THRESHOLDS;
	if (totals.truncatedResults >= thresholds.highTruncatedResults
		|| totals.historyCollapsedResults >= thresholds.highHistoryCollapsedResults
		|| totals.historyRemovedBundles >= thresholds.highHistoryRemovedBundles) return "HIGH";
	if (totals.truncatedResults >= thresholds.softTruncatedResults
		|| totals.historyCollapsedResults >= thresholds.softHistoryCollapsedResults
		|| totals.historyRemovedBundles >= thresholds.softHistoryRemovedBundles) return "SOFT";
	return "OK";
}

function freezeSnapshot(input: {
	role: OutputControlRole;
	totals: OutputControlTotals;
	perTool: OutputControlPerToolTotals[];
	maxResultBytes: number;
	maxBatchReservedBytes: number;
	activeHistoryToolTextBytes: number;
	envelopeCapViolations: number;
	turnCapViolations: number;
	historyCapViolations: number;
}): OutputControlTelemetrySnapshot {
	const totals = Object.freeze({ ...input.totals });
	const perTool = Object.freeze(input.perTool.map((value) => Object.freeze({ ...value })));
	const hardCapViolations = addSafe(addSafe(input.envelopeCapViolations, input.turnCapViolations), input.historyCapViolations);
	return Object.freeze({
		schema: OUTPUT_CONTROL_TELEMETRY_SCHEMA,
		role: input.role,
		totals,
		perTool,
		maxResultBytes: input.maxResultBytes,
		maxBatchReservedBytes: input.maxBatchReservedBytes,
		activeHistoryToolTextBytes: input.activeHistoryToolTextBytes,
		turnHardCapBytes: turnCap(input.role),
		historyHardCapBytes: historyCap(input.role),
		envelopeCapViolations: input.envelopeCapViolations,
		turnCapViolations: input.turnCapViolations,
		historyCapViolations: input.historyCapViolations,
		hardCapViolations,
		advisory: evaluateOutputControlAdvisory(totals),
		compliance: hardCapViolations === 0 ? "COMPLIANT" : "VIOLATION",
	});
}

function canonicalSnapshot(input: OutputControlTelemetrySnapshot): OutputControlTelemetrySnapshot {
	return freezeSnapshot({
		role: input.role,
		totals: { ...input.totals },
		perTool: input.perTool.map((value) => ({ ...value })),
		maxResultBytes: input.maxResultBytes,
		maxBatchReservedBytes: input.maxBatchReservedBytes,
		activeHistoryToolTextBytes: input.activeHistoryToolTextBytes,
		envelopeCapViolations: input.envelopeCapViolations,
		turnCapViolations: input.turnCapViolations,
		historyCapViolations: input.historyCapViolations,
	});
}

/** Strictly parse the persisted data payload; unknown fields fail closed. */
export function parseOutputControlTelemetry(value: unknown): OutputControlTelemetrySnapshot | undefined {
	const record = exactRecord(value, SNAPSHOT_KEYS);
	if (!record) return undefined;
	if (record.values.schema !== OUTPUT_CONTROL_TELEMETRY_SCHEMA) return undefined;
	const role = record.values.role;
	if (typeof role !== "string" || !ROLE_SET.has(role as OutputControlRole)) return undefined;
	const fixedRole = role as OutputControlRole;
	const totals = parseTotals(record.values.totals);
	const sourceTools = strictDenseArray(record.values.perTool, OUTPUT_CONTROL_TOOL_IDS.length);
	if (!totals || !sourceTools) return undefined;
	const perTool: OutputControlPerToolTotals[] = [];
	let lastOrdinal = -1;
	const summed = emptyTotals();
	let computedMaxResultBytes = 0;
	for (let index = 0; index < sourceTools.length; index += 1) {
		if (!Object.prototype.hasOwnProperty.call(sourceTools, index)) return undefined;
		const parsed = parseTool(sourceTools[index]);
		if (!parsed) return undefined;
		const ordinal = TOOL_ORDINAL.get(parsed.tool);
		if (ordinal === undefined || ordinal <= lastOrdinal) return undefined;
		lastOrdinal = ordinal;
		summed.toolResults = addSafe(summed.toolResults, parsed.toolResults);
		summed.rawTextBytes = addSafe(summed.rawTextBytes, parsed.rawTextBytes);
		summed.shownTextBytes = addSafe(summed.shownTextBytes, parsed.shownTextBytes);
		summed.omittedTextBytes = addSafe(summed.omittedTextBytes, parsed.omittedTextBytes);
		summed.truncatedResults = addSafe(summed.truncatedResults, parsed.truncatedResults);
		computedMaxResultBytes = Math.max(computedMaxResultBytes, parsed.maxResultBytes);
		perTool.push(parsed);
	}
	for (const key of ["toolResults", "rawTextBytes", "shownTextBytes", "omittedTextBytes", "truncatedResults"] as const) {
		if (summed[key] !== totals[key]) return undefined;
	}
	const numericKeys = [
		"maxResultBytes", "maxBatchReservedBytes", "activeHistoryToolTextBytes", "turnHardCapBytes", "historyHardCapBytes",
		"envelopeCapViolations", "turnCapViolations", "historyCapViolations", "hardCapViolations",
	] as const;
	for (const key of numericKeys) if (!isSafeCount(record.values[key])) return undefined;
	if (record.values.maxResultBytes !== computedMaxResultBytes) return undefined;
	if (record.values.turnHardCapBytes !== turnCap(fixedRole) || record.values.historyHardCapBytes !== historyCap(fixedRole)) return undefined;
	if (totals.omittedTextBytes > totals.rawTextBytes
		|| (record.values.maxBatchReservedBytes as number) > totals.batchReservedBytes
		|| ((record.values.turnCapViolations as number) === 0 && (record.values.maxBatchReservedBytes as number) > turnCap(fixedRole))
		|| ((record.values.historyCapViolations as number) === 0 && (record.values.activeHistoryToolTextBytes as number) > historyCap(fixedRole))
		|| ((record.values.envelopeCapViolations as number) === 0 && (record.values.maxResultBytes as number) > 32_768)) return undefined;
	const hardViolations = addSafe(
		addSafe(record.values.envelopeCapViolations as number, record.values.turnCapViolations as number),
		record.values.historyCapViolations as number,
	);
	if (record.values.hardCapViolations !== hardViolations) return undefined;
	const advisory = evaluateOutputControlAdvisory(totals);
	if (record.values.advisory !== advisory) return undefined;
	const compliance: OutputControlCompliance = hardViolations === 0 ? "COMPLIANT" : "VIOLATION";
	if (record.values.compliance !== compliance) return undefined;
	return freezeSnapshot({
		role: fixedRole,
		totals,
		perTool,
		maxResultBytes: record.values.maxResultBytes as number,
		maxBatchReservedBytes: record.values.maxBatchReservedBytes as number,
		activeHistoryToolTextBytes: record.values.activeHistoryToolTextBytes as number,
		envelopeCapViolations: record.values.envelopeCapViolations as number,
		turnCapViolations: record.values.turnCapViolations as number,
		historyCapViolations: record.values.historyCapViolations as number,
	});
}

/** Parse one Pi custom entry without touching unrelated entry metadata. */
export function parseOutputControlTelemetryEntry(entry: unknown): OutputControlTelemetrySnapshot | undefined {
	const type = ownDataValue(entry, "type");
	const customType = ownDataValue(entry, "customType");
	const data = ownDataValue(entry, "data");
	if (!type.ok || !customType.ok || !data.ok || type.value !== "custom" || customType.value !== OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE) {
		return undefined;
	}
	return parseOutputControlTelemetry(data.value);
}

/** Return a detached, canonical payload suitable for `pi.appendEntry`. */
export function serializeOutputControlTelemetry(value: OutputControlTelemetrySnapshot): OutputControlTelemetrySnapshot {
	const parsed = parseOutputControlTelemetry(value);
	if (!parsed) throw new TypeError("invalid output-control telemetry snapshot");
	return canonicalSnapshot(parsed);
}

/** Merge chronologically ordered, disjoint snapshots for the same role. */
export function mergeOutputControlTelemetry(
	leftValue: unknown,
	rightValue: unknown,
): OutputControlTelemetrySnapshot | undefined {
	const left = parseOutputControlTelemetry(leftValue);
	const right = parseOutputControlTelemetry(rightValue);
	if (!left || !right || left.role !== right.role) return undefined;
	const totals = emptyTotals();
	for (const key of TOTAL_KEYS) totals[key] = addSafe(left.totals[key], right.totals[key]);
	const byTool = new Map<OutputControlToolId, OutputControlPerToolTotals>();
	for (const source of [...left.perTool, ...right.perTool]) {
		const current = byTool.get(source.tool) ?? emptyTool(source.tool);
		current.toolResults = addSafe(current.toolResults, source.toolResults);
		current.rawTextBytes = addSafe(current.rawTextBytes, source.rawTextBytes);
		current.shownTextBytes = addSafe(current.shownTextBytes, source.shownTextBytes);
		current.omittedTextBytes = addSafe(current.omittedTextBytes, source.omittedTextBytes);
		current.truncatedResults = addSafe(current.truncatedResults, source.truncatedResults);
		current.maxResultBytes = Math.max(current.maxResultBytes, source.maxResultBytes);
		byTool.set(source.tool, current);
	}
	const perTool = OUTPUT_CONTROL_TOOL_IDS.flatMap((tool) => {
		const value = byTool.get(tool);
		return value && value.toolResults > 0 ? [value] : [];
	});
	return freezeSnapshot({
		role: left.role,
		totals,
		perTool,
		maxResultBytes: Math.max(left.maxResultBytes, right.maxResultBytes),
		maxBatchReservedBytes: Math.max(left.maxBatchReservedBytes, right.maxBatchReservedBytes),
		// The right snapshot is chronologically later; active history is a
		// gauge, not an additive session counter.
		activeHistoryToolTextBytes: right.activeHistoryToolTextBytes,
		envelopeCapViolations: addSafe(left.envelopeCapViolations, right.envelopeCapViolations),
		turnCapViolations: addSafe(left.turnCapViolations, right.turnCapViolations),
		historyCapViolations: addSafe(left.historyCapViolations, right.historyCapViolations),
	});
}

function envelopeFacts(value: unknown): {
	policy: OutputPolicyId;
	truncated: boolean;
	originalTextBytes: number;
	originalTextLines: number;
	shownTextBytes: number;
	shownTextLines: number;
	omittedTextBytes: number;
} | undefined {
	const required = ENVELOPE_KEYS.filter((key) => key !== "continuation");
	const record = exactRecord(value, ENVELOPE_KEYS, required);
	if (!record || record.values.schema !== "workbench-output-v1") return undefined;
	const policy = record.values.policy;
	if (typeof policy !== "string" || !POLICY_IDS.has(policy as OutputPolicyId)) return undefined;
	if (typeof record.values.truncated !== "boolean") return undefined;
	for (const key of [
		"originalTextBytes", "originalTextLines", "shownTextBytes", "shownTextLines", "omittedTextBytes", "omittedTextLines",
		"originalImageCount", "shownImageCount", "omittedImageCount",
	]) if (!isSafeCount(record.values[key])) return undefined;
	if (typeof record.values.reason !== "string" || !ENVELOPE_REASONS.has(record.values.reason)) return undefined;
	const originalTextBytes = record.values.originalTextBytes as number;
	const originalTextLines = record.values.originalTextLines as number;
	const omittedTextBytes = record.values.omittedTextBytes as number;
	const omittedTextLines = record.values.omittedTextLines as number;
	const originalImageCount = record.values.originalImageCount as number;
	const shownImageCount = record.values.shownImageCount as number;
	const omittedImageCount = record.values.omittedImageCount as number;
	if (omittedTextBytes > originalTextBytes
		|| omittedTextLines > originalTextLines
		|| shownImageCount > originalImageCount
		|| omittedImageCount !== originalImageCount - shownImageCount
		|| (record.values.truncated === false && (
			omittedTextBytes !== 0 || omittedTextLines !== 0 || omittedImageCount !== 0 || record.values.reason !== "none"
		))
		|| (record.values.truncated === true && record.values.reason === "none")) return undefined;
	return {
		policy: policy as OutputPolicyId,
		truncated: record.values.truncated,
		originalTextBytes,
		originalTextLines,
		shownTextBytes: record.values.shownTextBytes as number,
		shownTextLines: record.values.shownTextLines as number,
		omittedTextBytes,
	};
}

function turnFacts(value: unknown): {
	role: OutputControlRole;
	maxBytes: number;
	blockedCalls: number;
	reservedBytes: number;
	totalAccountedBytes: number;
} | undefined {
	const record = exactRecord(value, TURN_KEYS);
	if (!record || record.values.schema !== "workbench-turn-output-telemetry-v1") return undefined;
	const role = record.values.role;
	if (typeof role !== "string" || !ROLE_SET.has(role as OutputControlRole) || typeof record.values.planned !== "boolean") return undefined;
	for (const key of TURN_KEYS) {
		if (key === "schema" || key === "role" || key === "planned") continue;
		if (!isSafeCount(record.values[key])) return undefined;
	}
	return {
		role: role as OutputControlRole,
		maxBytes: record.values.maxBytes as number,
		blockedCalls: record.values.blockedCalls as number,
		reservedBytes: record.values.reservedBytes as number,
		totalAccountedBytes: record.values.totalAccountedBytes as number,
	};
}

function historyFacts(value: unknown): {
	originalToolTextBytes: number;
	finalToolTextBytes: number;
	collapsedResults: number;
	removedBundles: number;
} | undefined {
	const record = exactRecord(value, HISTORY_KEYS);
	if (!record) return undefined;
	for (const key of HISTORY_KEYS) if (!isSafeCount(record.values[key])) return undefined;
	return {
		originalToolTextBytes: record.values.originalToolTextBytes as number,
		finalToolTextBytes: record.values.finalToolTextBytes as number,
		collapsedResults: record.values.collapsedResults as number,
		removedBundles: record.values.removedBundles as number,
	};
}

/** Mutable session accumulator; its public observations are immutable copies. */
export class OutputControlTelemetryAccumulator {
	private readonly role: OutputControlRole;
	private totals = emptyTotals();
	private readonly tools = new Map<OutputControlToolId, OutputControlPerToolTotals>();
	private maxResultBytes = 0;
	private maxBatchReservedBytes = 0;
	private activeHistoryToolTextBytes = 0;
	private envelopeCapViolations = 0;
	private turnCapViolations = 0;
	private historyCapViolations = 0;

	constructor(role: unknown = "other") {
		this.role = normalizeRole(role);
	}

	reset(): void {
		this.totals = emptyTotals();
		this.tools.clear();
		this.maxResultBytes = 0;
		this.maxBatchReservedBytes = 0;
		this.activeHistoryToolTextBytes = 0;
		this.envelopeCapViolations = 0;
		this.turnCapViolations = 0;
		this.historyCapViolations = 0;
	}

	recordEnvelope(toolName: unknown, value: unknown): boolean {
		const facts = envelopeFacts(value);
		if (!facts) return false;
		const id = toolId(toolName);
		const perTool = this.tools.get(id) ?? emptyTool(id);
		this.totals.toolResults = addSafe(this.totals.toolResults, 1);
		this.totals.rawTextBytes = addSafe(this.totals.rawTextBytes, facts.originalTextBytes);
		this.totals.shownTextBytes = addSafe(this.totals.shownTextBytes, facts.shownTextBytes);
		this.totals.omittedTextBytes = addSafe(this.totals.omittedTextBytes, facts.omittedTextBytes);
		if (facts.truncated) this.totals.truncatedResults = addSafe(this.totals.truncatedResults, 1);
		perTool.toolResults = addSafe(perTool.toolResults, 1);
		perTool.rawTextBytes = addSafe(perTool.rawTextBytes, facts.originalTextBytes);
		perTool.shownTextBytes = addSafe(perTool.shownTextBytes, facts.shownTextBytes);
		perTool.omittedTextBytes = addSafe(perTool.omittedTextBytes, facts.omittedTextBytes);
		if (facts.truncated) perTool.truncatedResults = addSafe(perTool.truncatedResults, 1);
		perTool.maxResultBytes = Math.max(perTool.maxResultBytes, facts.shownTextBytes);
		this.maxResultBytes = Math.max(this.maxResultBytes, facts.shownTextBytes);
		this.tools.set(id, perTool);
		const ceiling = resolveOutputPolicyHardCeiling(facts.policy);
		if (facts.shownTextBytes > ceiling.maxTextBytes || facts.shownTextLines > ceiling.maxLines) {
			this.envelopeCapViolations = addSafe(this.envelopeCapViolations, 1);
		}
		return true;
	}

	recordTurn(value: unknown): boolean {
		const facts = turnFacts(value);
		if (!facts || facts.role !== this.role) return false;
		this.totals.blockedCalls = addSafe(this.totals.blockedCalls, facts.blockedCalls);
		this.totals.batchReservedBytes = addSafe(this.totals.batchReservedBytes, facts.reservedBytes);
		this.maxBatchReservedBytes = Math.max(this.maxBatchReservedBytes, facts.reservedBytes);
		if (facts.maxBytes > turnCap(this.role) || facts.reservedBytes > facts.maxBytes || facts.totalAccountedBytes > facts.maxBytes) {
			this.turnCapViolations = addSafe(this.turnCapViolations, 1);
		}
		return true;
	}

	recordHistory(value: unknown, role: unknown = this.role): boolean {
		const fixedRole = normalizeRole(role);
		const facts = historyFacts(value);
		if (!facts || fixedRole !== this.role) return false;
		this.totals.historyCollapsedResults = addSafe(this.totals.historyCollapsedResults, facts.collapsedResults);
		this.totals.historyRemovedBundles = addSafe(this.totals.historyRemovedBundles, facts.removedBundles);
		this.activeHistoryToolTextBytes = facts.finalToolTextBytes;
		if (facts.finalToolTextBytes > historyCap(this.role)) {
			this.historyCapViolations = addSafe(this.historyCapViolations, 1);
		}
		return true;
	}

	/** Merge a disjoint canonical snapshot. Cumulative persisted snapshots should instead be restored. */
	merge(value: unknown): boolean {
		const merged = mergeOutputControlTelemetry(this.snapshot(), value);
		if (!merged) return false;
		this.load(merged);
		return true;
	}

	/** Restore the latest cumulative entry; a malformed matching entry fails closed. */
	restoreFromEntries(entries: readonly unknown[]): boolean {
		let latest: OutputControlTelemetrySnapshot | undefined;
		try {
			for (const entry of entries) {
				const customType = ownDataValue(entry, "customType");
				if (!customType.ok || customType.value !== OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE) continue;
				const parsed = parseOutputControlTelemetryEntry(entry);
				if (!parsed || parsed.role !== this.role) {
					this.reset();
					return false;
				}
				latest = parsed;
			}
		} catch {
			this.reset();
			return false;
		}
		if (!latest) return false;
		this.load(latest);
		return true;
	}

	private load(value: OutputControlTelemetrySnapshot): void {
		this.totals = { ...value.totals };
		this.tools.clear();
		for (const item of value.perTool) this.tools.set(item.tool, { ...item });
		this.maxResultBytes = value.maxResultBytes;
		this.maxBatchReservedBytes = value.maxBatchReservedBytes;
		this.activeHistoryToolTextBytes = value.activeHistoryToolTextBytes;
		this.envelopeCapViolations = value.envelopeCapViolations;
		this.turnCapViolations = value.turnCapViolations;
		this.historyCapViolations = value.historyCapViolations;
	}

	snapshot(): OutputControlTelemetrySnapshot {
		const perTool = OUTPUT_CONTROL_TOOL_IDS.flatMap((tool) => {
			const value = this.tools.get(tool);
			return value && value.toolResults > 0 ? [{ ...value }] : [];
		});
		return freezeSnapshot({
			role: this.role,
			totals: { ...this.totals },
			perTool,
			maxResultBytes: this.maxResultBytes,
			maxBatchReservedBytes: this.maxBatchReservedBytes,
			activeHistoryToolTextBytes: this.activeHistoryToolTextBytes,
			envelopeCapViolations: this.envelopeCapViolations,
			turnCapViolations: this.turnCapViolations,
			historyCapViolations: this.historyCapViolations,
		});
	}
}

export function createOutputControlTelemetry(role: unknown = "other"): OutputControlTelemetryAccumulator {
	return new OutputControlTelemetryAccumulator(role);
}

function statusSummary(snapshot: OutputControlTelemetrySnapshot): Record<string, unknown> {
	return {
		schema: snapshot.schema,
		role: snapshot.role,
		advisory: snapshot.advisory,
		compliance: snapshot.compliance,
		totals: snapshot.totals,
		maxResultBytes: snapshot.maxResultBytes,
		maxBatchReservedBytes: snapshot.maxBatchReservedBytes,
		activeHistoryToolTextBytes: snapshot.activeHistoryToolTextBytes,
		turnHardCapBytes: snapshot.turnHardCapBytes,
		historyHardCapBytes: snapshot.historyHardCapBytes,
		hardCapViolations: snapshot.hardCapViolations,
	};
}

/** Deterministic bounded JSON for `/q-context-output-status json`. */
export function renderOutputControlStatusJson(value: unknown): string {
	const snapshot = parseOutputControlTelemetry(value);
	if (!snapshot) return JSON.stringify({ schema: OUTPUT_CONTROL_TELEMETRY_SCHEMA, status: "UNAVAILABLE" });
	const rendered = JSON.stringify(snapshot);
	if (Buffer.byteLength(rendered, "utf8") <= OUTPUT_CONTROL_STATUS_MAX_BYTES) return rendered;
	return JSON.stringify(statusSummary(snapshot));
}

/** Deterministic bounded text; labels and rendered values are all fixed/numeric. */
export function renderOutputControlStatusText(value: unknown): string {
	const snapshot = parseOutputControlTelemetry(value);
	if (!snapshot) return "context_output_control status=UNAVAILABLE";
	const totals = snapshot.totals;
	const lines = [
		"context_output_control observation=ONLY",
		`role=${snapshot.role} advisory=${snapshot.advisory} compliance=${snapshot.compliance}`,
		`tool_results=${totals.toolResults} raw_text_bytes=${totals.rawTextBytes} shown_text_bytes=${totals.shownTextBytes} omitted_text_bytes=${totals.omittedTextBytes}`,
		`truncated_results=${totals.truncatedResults} blocked_calls=${totals.blockedCalls} batch_reserved_bytes=${totals.batchReservedBytes}`,
		`max_result_bytes=${snapshot.maxResultBytes} max_batch_reserved_bytes=${snapshot.maxBatchReservedBytes}`,
		`active_history_tool_text_bytes=${snapshot.activeHistoryToolTextBytes} history_collapsed_results=${totals.historyCollapsedResults} history_removed_bundles=${totals.historyRemovedBundles}`,
		`turn_hard_cap_bytes=${snapshot.turnHardCapBytes} history_hard_cap_bytes=${snapshot.historyHardCapBytes}`,
		`hard_cap_violations=${snapshot.hardCapViolations} envelope=${snapshot.envelopeCapViolations} turn=${snapshot.turnCapViolations} history=${snapshot.historyCapViolations}`,
		...snapshot.perTool.map((item) => (
			`tool=${item.tool} results=${item.toolResults} raw=${item.rawTextBytes} shown=${item.shownTextBytes} omitted=${item.omittedTextBytes} truncated=${item.truncatedResults} max_result=${item.maxResultBytes}`
		)),
	];
	const rendered = lines.join("\n");
	if (Buffer.byteLength(rendered, "utf8") <= OUTPUT_CONTROL_STATUS_MAX_BYTES) return rendered;
	const summary = lines.slice(0, 8).join("\n");
	return Buffer.byteLength(summary, "utf8") <= OUTPUT_CONTROL_STATUS_MAX_BYTES
		? summary
		: "context_output_control status=UNAVAILABLE";
}

export function renderOutputControlStatus(value: unknown, format: "text" | "json" = "text"): string {
	return format === "json" ? renderOutputControlStatusJson(value) : renderOutputControlStatusText(value);
}
