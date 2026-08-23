/** Pure, bounded state machine for one compact attempt. */

import { types as utilTypes } from "node:util";

export const COMPACT_ATTEMPT_SCHEMA = "workbench-compact-attempt-v1";
export const COMPACT_ATTEMPT_ENTRY_TYPE = "workbench-compact-attempt";
export const COMPACT_ATTEMPT_TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;
export const COMPACT_ATTEMPT_REASONS = ["manual", "threshold", "overflow"] as const;
export const COMPACT_ATTEMPT_OWNERS = ["pi-native", "workbench-overflow-recovery"] as const;
export const COMPACT_ATTEMPT_RESULT_CODES = Object.freeze({
	completed: "compact_completed",
	failed: "compact_failed",
	cancelled: "compact_cancelled",
} as const);

export type CompactAttemptTerminalStatus = typeof COMPACT_ATTEMPT_TERMINAL_STATUSES[number];
export type CompactAttemptStatus = "started" | CompactAttemptTerminalStatus;
export type CompactAttemptReason = typeof COMPACT_ATTEMPT_REASONS[number];
export type CompactAttemptOwner = typeof COMPACT_ATTEMPT_OWNERS[number];
export type CompactAttemptResultCode = typeof COMPACT_ATTEMPT_RESULT_CODES[CompactAttemptTerminalStatus];

export interface StartCompactAttemptInput {
	readonly attemptId: string;
	readonly startedAt: string;
	readonly reason: CompactAttemptReason;
	readonly owner: CompactAttemptOwner;
	readonly willRetry: boolean;
}

export interface CompactAttemptState {
	readonly schema: typeof COMPACT_ATTEMPT_SCHEMA;
	readonly attemptId: string;
	readonly status: CompactAttemptStatus;
	readonly startedAt: string;
	readonly finishedAt: string | null;
	readonly reason: CompactAttemptReason;
	readonly owner: CompactAttemptOwner;
	readonly willRetry: boolean;
	readonly resultCode: CompactAttemptResultCode | null;
}

const ATTEMPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL = new Set<string>(COMPACT_ATTEMPT_TERMINAL_STATUSES);
const REASONS = new Set<string>(COMPACT_ATTEMPT_REASONS);
const OWNERS = new Set<string>(COMPACT_ATTEMPT_OWNERS);
const STATE_KEYS = [
	"schema", "attemptId", "status", "startedAt", "finishedAt", "reason", "owner", "willRetry", "resultCode",
] as const;

function exactValues(value: unknown): Record<string, unknown> | undefined {
	try {
		if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return undefined;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Object.keys(descriptors).length !== STATE_KEYS.length) return undefined;
		const output: Record<string, unknown> = Object.create(null);
		for (const key of STATE_KEYS) {
			const descriptor = descriptors[key];
			if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return undefined;
			output[key] = descriptor.value;
		}
		if (Object.keys(descriptors).some((key) => !STATE_KEYS.includes(key as typeof STATE_KEYS[number]))) return undefined;
		return output;
	} catch {
		return undefined;
	}
}

function timestamp(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 32) return false;
	const millis = Date.parse(value);
	return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function freezeState(state: CompactAttemptState): CompactAttemptState {
	return Object.freeze({ ...state });
}

/** Strictly parse the persisted state; partial or extended records are rejected. */
export function parseCompactAttemptState(value: unknown): CompactAttemptState | undefined {
	const record = exactValues(value);
	if (!record
		|| record.schema !== COMPACT_ATTEMPT_SCHEMA
		|| typeof record.attemptId !== "string"
		|| !ATTEMPT_ID_RE.test(record.attemptId)
		|| (record.status !== "started" && !TERMINAL.has(String(record.status)))
		|| !timestamp(record.startedAt)
		|| typeof record.reason !== "string"
		|| !REASONS.has(record.reason)
		|| typeof record.owner !== "string"
		|| !OWNERS.has(record.owner)
		|| typeof record.willRetry !== "boolean") return undefined;

	const status = record.status as CompactAttemptStatus;
	if (status === "started") {
		if (record.finishedAt !== null || record.resultCode !== null) return undefined;
	} else {
		if (!timestamp(record.finishedAt)
			|| Date.parse(record.finishedAt) < Date.parse(record.startedAt)
			|| record.resultCode !== COMPACT_ATTEMPT_RESULT_CODES[status]) return undefined;
	}
	return freezeState({
		schema: COMPACT_ATTEMPT_SCHEMA,
		attemptId: record.attemptId,
		status,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt as string | null,
		reason: record.reason as CompactAttemptReason,
		owner: record.owner as CompactAttemptOwner,
		willRetry: record.willRetry,
		resultCode: record.resultCode as CompactAttemptResultCode | null,
	});
}

/** Create the sole legal initial state. */
export function startCompactAttempt(input: StartCompactAttemptInput): CompactAttemptState {
	const parsed = parseCompactAttemptState({
		schema: COMPACT_ATTEMPT_SCHEMA,
		attemptId: input.attemptId,
		status: "started",
		startedAt: input.startedAt,
		finishedAt: null,
		reason: input.reason,
		owner: input.owner,
		willRetry: input.willRetry,
		resultCode: null,
	});
	if (!parsed) throw new TypeError("invalid compact attempt start");
	return parsed;
}

/** Transition started -> terminal exactly once; invalid/repeated transitions fail closed. */
export function finishCompactAttempt(
	value: unknown,
	status: CompactAttemptTerminalStatus,
	finishedAt: string,
): CompactAttemptState | undefined {
	const started = parseCompactAttemptState(value);
	if (!started || started.status !== "started" || !TERMINAL.has(status)) return undefined;
	return parseCompactAttemptState({
		...started,
		status,
		finishedAt,
		resultCode: COMPACT_ATTEMPT_RESULT_CODES[status],
	});
}

export function isCompactAttemptTerminal(value: unknown): value is CompactAttemptState {
	const parsed = parseCompactAttemptState(value);
	return parsed !== undefined && parsed.status !== "started";
}

/** Return a detached canonical payload suitable for persistence. */
export function serializeCompactAttemptState(value: unknown): CompactAttemptState {
	const parsed = parseCompactAttemptState(value);
	if (!parsed) throw new TypeError("invalid compact attempt state");
	return freezeState(parsed);
}
