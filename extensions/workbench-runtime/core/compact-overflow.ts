/** Narrow context-window overflow detection and one-shot recovery policy. */

import { types as utilTypes } from "node:util";

export type CompactOverflowKind = "context-window-overflow";
export type CompactOverflowSource = "code" | "message";

export interface CompactOverflowClassification {
	readonly kind: CompactOverflowKind;
	readonly source: CompactOverflowSource;
}

export interface CompactOverflowRecoveryDecision {
	readonly classification?: CompactOverflowClassification;
	readonly recover: boolean;
	readonly recoveryAttempted: boolean;
	readonly reason: "not-context-overflow" | "recover-once" | "recovery-already-attempted";
}

const OVERFLOW_CODES = new Set([
	"context_length_exceeded",
	"context_window_exceeded",
	"input_too_long",
	"prompt_too_long",
]);

const OVERFLOW_MESSAGES = [
	/maximum context length (?:is|of) [0-9][0-9,]* tokens/i,
	/context (?:length|window)[^.\n]{0,80}(?:exceed(?:ed|s)?|too (?:large|long))/i,
	/(?:prompt is too long|input token count[^.\n]{0,80}exceeds?)[^.\n]{0,120}(?:maximum|context)/i,
] as const;

function ownValue(value: unknown, key: string): unknown {
	try {
		if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value") ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function candidates(value: unknown): unknown[] {
	const nested = ownValue(value, "error");
	return nested === undefined ? [value] : [value, nested];
}

/**
 * Classify only explicit provider context-window signals. Generic 413s,
 * "overflow", "too long", timeouts, and rate limits deliberately do not match.
 */
export function classifyCompactOverflow(value: unknown): CompactOverflowClassification | undefined {
	for (const candidate of candidates(value)) {
		const code = ownValue(candidate, "code");
		if (typeof code === "string" && OVERFLOW_CODES.has(code.toLowerCase())) {
			return Object.freeze({ kind: "context-window-overflow", source: "code" });
		}
	}
	for (const candidate of candidates(value)) {
		const message = typeof candidate === "string" ? candidate : ownValue(candidate, "message");
		if (typeof message === "string" && message.length <= 4_096 && OVERFLOW_MESSAGES.some((pattern) => pattern.test(message))) {
			return Object.freeze({ kind: "context-window-overflow", source: "message" });
		}
	}
	return undefined;
}

/** Decide whether the caller may perform the single compact-and-retry recovery. */
export function decideCompactOverflowRecovery(
	error: unknown,
	recoveryAlreadyAttempted: boolean,
): CompactOverflowRecoveryDecision {
	const classification = classifyCompactOverflow(error);
	if (!classification) {
		return Object.freeze({ recover: false, recoveryAttempted: recoveryAlreadyAttempted, reason: "not-context-overflow" });
	}
	if (recoveryAlreadyAttempted) {
		return Object.freeze({ classification, recover: false, recoveryAttempted: true, reason: "recovery-already-attempted" });
	}
	return Object.freeze({ classification, recover: true, recoveryAttempted: true, reason: "recover-once" });
}
