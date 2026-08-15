import { Buffer } from "node:buffer";

import {
	convertToLlm,
	serializeConversation,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

export const COMPACT_PREFLIGHT_FIXED_INPUT_TOKENS = 2_048;
export const COMPACT_PREFLIGHT_SAFETY_BPS = 500;
export const COMPACT_PREFLIGHT_TOKENIZER_HEADROOM_BPS = 500;
export const COMPACT_PREFLIGHT_WARN_BPS = 9_000;

const BASIS_POINTS = 10_000;

export type CompactPreflightVerdict = "allow" | "warn" | "block" | "unknown";
export type CompactPreflightReason =
	| "within-budget"
	| "near-capacity"
	| "request-too-large"
	| "invalid-input"
	| "estimation-failed";
export type CompactPreflightRequestKind = "history" | "turn-prefix";
export type CompactPreflightWorstRequestKind = CompactPreflightRequestKind | "none";

export interface CompactPreflightCallFacts {
	kind: CompactPreflightRequestKind;
	serializedChars: number;
	serializedUtf8Bytes: number;
	basePayloadTokens: number;
	estimatedInputTokens: number;
	reservedOutputTokens: number;
	safetyTokens: number;
	requestEnvelopeTokens: number;
}

export interface CompactSummaryPreflightResult {
	verdict: CompactPreflightVerdict;
	reason: CompactPreflightReason;
	requestCount: number;
	worstRequestKind: CompactPreflightWorstRequestKind;
	contextWindowTokens: number;
	worstRequestEnvelopeTokens: number;
	calls: CompactPreflightCallFacts[];
}

interface CompactPreflightModel {
	contextWindow: number;
	maxTokens: number;
}

interface CompactSummaryPreflightInput {
	preparation: SessionBeforeCompactEvent["preparation"];
	model?: CompactPreflightModel;
	customInstructions?: string;
}

interface SerializedSize {
	chars: number;
	utf8Bytes: number;
}

function unknown(reason: "invalid-input" | "estimation-failed"): CompactSummaryPreflightResult {
	return {
		verdict: "unknown",
		reason,
		requestCount: 0,
		worstRequestKind: "none",
		contextWindowTokens: 0,
		worstRequestEnvelopeTokens: 0,
		calls: [],
	};
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return isSafeInteger(value) && value >= 0;
}

function safeAdd(...values: number[]): number {
	let total = 0;
	for (const value of values) {
		if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) {
			throw new RangeError("unsafe compact preflight arithmetic");
		}
		total += value;
	}
	return total;
}

function floorRatio(value: number, numerator: number, denominator: number): number {
	const quotient = Math.floor(value / denominator);
	const remainder = value % denominator;
	return safeAdd(quotient * numerator, Math.floor((remainder * numerator) / denominator));
}

function ceilRatio(value: number, numerator: number, denominator: number): number {
	const quotient = Math.floor(value / denominator);
	const remainder = value % denominator;
	return safeAdd(quotient * numerator, Math.ceil((remainder * numerator) / denominator));
}

/**
 * Measure the exact public Pi serialization without retaining or returning
 * message content. Serializing one AgentMessage at a time and joining each
 * non-empty result with Pi's two-newline separator is equivalent to the
 * public whole-array serializer while avoiding a second combined copy.
 */
function serializedSize(messages: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"]): SerializedSize {
	let chars = 0;
	let utf8Bytes = 0;
	let emittedChunks = 0;
	for (const message of messages) {
		const serialized = serializeConversation(convertToLlm([message]));
		if (serialized.length === 0) continue;
		if (emittedChunks > 0) {
			chars = safeAdd(chars, 2);
			utf8Bytes = safeAdd(utf8Bytes, 2);
		}
		chars = safeAdd(chars, serialized.length);
		utf8Bytes = safeAdd(utf8Bytes, Buffer.byteLength(serialized, "utf8"));
		emittedChunks += 1;
	}
	return { chars, utf8Bytes };
}

function stringSize(value: string | undefined): SerializedSize {
	if (value === undefined) return { chars: 0, utf8Bytes: 0 };
	return { chars: value.length, utf8Bytes: Buffer.byteLength(value, "utf8") };
}

function evaluateCall(input: {
	kind: CompactPreflightRequestKind;
	messages: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"];
	dynamicTextSizes: SerializedSize[];
	reserveTokens: number;
	model: CompactPreflightModel;
}): CompactPreflightCallFacts {
	const serialized = serializedSize(input.messages);
	const payloadChars = safeAdd(serialized.chars, ...input.dynamicTextSizes.map((size) => size.chars));
	const payloadUtf8Bytes = safeAdd(serialized.utf8Bytes, ...input.dynamicTextSizes.map((size) => size.utf8Bytes));
	const basePayloadTokens = Math.max(Math.ceil(payloadChars / 4), Math.ceil(payloadUtf8Bytes / 3));
	const estimatedInputTokens = safeAdd(
		ceilRatio(
			basePayloadTokens,
			BASIS_POINTS + COMPACT_PREFLIGHT_TOKENIZER_HEADROOM_BPS,
			BASIS_POINTS,
		),
		COMPACT_PREFLIGHT_FIXED_INPUT_TOKENS,
	);
	const outputNumerator = input.kind === "history" ? 8 : 5;
	const reserveOutputTokens = floorRatio(input.reserveTokens, outputNumerator, 10);
	// Pi 0.84.2 treats a non-positive model maxTokens as an unbounded cap.
	// Keep Infinity out of the returned numeric facts by applying the cap only
	// when the model publishes a positive maximum.
	const reservedOutputTokens = input.model.maxTokens > 0
		? Math.min(reserveOutputTokens, input.model.maxTokens)
		: reserveOutputTokens;
	const safetyTokens = ceilRatio(input.model.contextWindow, COMPACT_PREFLIGHT_SAFETY_BPS, BASIS_POINTS);
	const requestEnvelopeTokens = safeAdd(estimatedInputTokens, reservedOutputTokens, safetyTokens);

	return {
		kind: input.kind,
		serializedChars: serialized.chars,
		serializedUtf8Bytes: serialized.utf8Bytes,
		basePayloadTokens,
		estimatedInputTokens,
		reservedOutputTokens,
		safetyTokens,
		requestEnvelopeTokens,
	};
}

/**
 * Estimate each provider request Pi will make for a native compaction.
 * Results contain only numeric and enum facts; raw preparation content and
 * caught error text never leave this function.
 */
export function evaluateCompactSummaryPreflight(
	input: CompactSummaryPreflightInput,
): CompactSummaryPreflightResult {
	try {
		const { preparation, model, customInstructions } = input;
		if (
			preparation === null
			|| typeof preparation !== "object"
			|| model === undefined
			|| !isPositiveSafeInteger(model.contextWindow)
			|| !isSafeInteger(model.maxTokens)
			|| !Array.isArray(preparation.messagesToSummarize)
			|| !Array.isArray(preparation.turnPrefixMessages)
			|| typeof preparation.isSplitTurn !== "boolean"
			|| preparation.settings === null
			|| typeof preparation.settings !== "object"
			|| !isNonNegativeSafeInteger(preparation.settings.reserveTokens)
			|| (preparation.previousSummary !== undefined && typeof preparation.previousSummary !== "string")
			|| (customInstructions !== undefined && typeof customInstructions !== "string")
		) {
			return unknown("invalid-input");
		}

		const calls: CompactPreflightCallFacts[] = [];
		if (!preparation.isSplitTurn || preparation.messagesToSummarize.length > 0) {
			calls.push(evaluateCall({
				kind: "history",
				messages: preparation.messagesToSummarize,
				dynamicTextSizes: [
					stringSize(preparation.previousSummary),
					stringSize(customInstructions),
				],
				reserveTokens: preparation.settings.reserveTokens,
				model,
			}));
		}
		if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
			calls.push(evaluateCall({
				kind: "turn-prefix",
				messages: preparation.turnPrefixMessages,
				dynamicTextSizes: [],
				reserveTokens: preparation.settings.reserveTokens,
				model,
			}));
		}
		if (calls.length === 0) return unknown("invalid-input");

		let worst = calls[0]!;
		for (const call of calls.slice(1)) {
			if (call.requestEnvelopeTokens > worst.requestEnvelopeTokens) worst = call;
		}

		let verdict: CompactPreflightVerdict = "allow";
		let reason: CompactPreflightReason = "within-budget";
		if (calls.some((call) => call.requestEnvelopeTokens >= model.contextWindow)) {
			verdict = "block";
			reason = "request-too-large";
		} else {
			const warningThreshold = ceilRatio(model.contextWindow, COMPACT_PREFLIGHT_WARN_BPS, BASIS_POINTS);
			if (calls.some((call) => call.requestEnvelopeTokens >= warningThreshold)) {
				verdict = "warn";
				reason = "near-capacity";
			}
		}

		return {
			verdict,
			reason,
			requestCount: calls.length,
			worstRequestKind: worst.kind,
			contextWindowTokens: model.contextWindow,
			worstRequestEnvelopeTokens: worst.requestEnvelopeTokens,
			calls,
		};
	} catch {
		return unknown("estimation-failed");
	}
}
