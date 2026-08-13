import {
	ERROR_RESULT_MAX_BYTES,
	STREAM_UPDATE_MAX_BYTES,
	resolveOutputPolicyHardCeiling,
	type OutputPolicyId,
	type ToolOutputPolicy,
} from "./output-policy.ts";

export interface TextContent { type: "text"; text: string }
export interface ImageContent { type: "image"; data: string; mimeType: string }
export interface BoundedContinuation { kind: string; value: string }
export type OutputEnvelopeReason = "none" | "per-tool-cap" | "turn-reservation" | "runtime-failure";

export interface OutputEnvelopeFacts {
	schema: "workbench-output-v1";
	policy: OutputPolicyId;
	truncated: boolean;
	originalTextBytes: number;
	originalTextLines: number;
	shownTextBytes: number;
	shownTextLines: number;
	omittedTextBytes: number;
	omittedTextLines: number;
	originalImageCount: number;
	shownImageCount: number;
	omittedImageCount: number;
	reason: OutputEnvelopeReason;
	continuation?: BoundedContinuation;
}

export interface OutputEnvelopeResult {
	content: Array<TextContent | ImageContent>;
	facts: OutputEnvelopeFacts;
	isError: boolean;
}

export interface EnforceOutputEnvelopeInput {
	toolName: string;
	content: Array<TextContent | ImageContent>;
	isError: boolean;
	policy: ToolOutputPolicy;
	allocatedBytes: number;
	continuation?: BoundedContinuation;
	receiptId?: string;
}

const FAILURE_TEXT = "output_envelope_error";
const META_MAX_BYTES = 1_024;
const IMAGE_OMISSION = "[workbench-output image omitted]";
const BASH_REPLAY_ACTION = "rerun_redirect_file_then_bounded_read";
const GENERIC_REPLAY_ACTION = "rerun_narrow_or_persist_then_bounded_read";

/**
 * Streaming updates are ephemeral UI progress, not final tool results.  They
 * therefore use one independent fixed envelope instead of borrowing a final
 * turn reservation.  Eighty lines keeps progress readable while remaining
 * well below every final-result line ceiling.
 */
export const STREAM_UPDATE_MAX_LINES = 80 as const;
const STREAM_UPDATE_POLICY: Readonly<ToolOutputPolicy> = Object.freeze({
	id: "default",
	maxTextBytes: STREAM_UPDATE_MAX_BYTES,
	maxLines: STREAM_UPDATE_MAX_LINES,
	minReservationBytes: 1,
	overflow: "receipt-only",
	preserveImages: false,
});

function bytes(text: string): number { return Buffer.byteLength(text, "utf8"); }
function lines(text: string): number { return text.length === 0 ? 0 : text.split("\n").length; }

function scalarText(value: string): string {
	let out = "";
	for (let i = 0; i < value.length; i += 1) {
		const unit = value.charCodeAt(i);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) { out += value.slice(i, i + 2); i += 1; }
			else out += "\ufffd";
		} else if (unit >= 0xdc00 && unit <= 0xdfff) out += "\ufffd";
		else out += value[i];
	}
	return out;
}

function prefix(text: string, maxBytes: number, maxLines: number): string {
	if (maxBytes <= 0 || maxLines <= 0) return "";
	let out = "";
	let usedBytes = 0;
	let usedLines = 0;
	for (const scalar of text) {
		const scalarBytes = bytes(scalar);
		const nextLines = out.length === 0 ? (scalar === "\n" ? 2 : 1) : usedLines + (scalar === "\n" ? 1 : 0);
		if (usedBytes + scalarBytes > maxBytes || nextLines > maxLines) break;
		out += scalar; usedBytes += scalarBytes; usedLines = nextLines;
	}
	return out;
}

function boundedInline(value: unknown): string {
	const text = scalarText(typeof value === "string" ? value : "").replace(/[\x00-\x1f\x7f]/g, " ");
	return prefix(text, META_MAX_BYTES, 1);
}

function safeFailure(policyId: OutputPolicyId, byteCap: number, lineCap: number): OutputEnvelopeResult {
	const safeByteCap = Number.isFinite(byteCap) && byteCap > 0 ? Math.min(Math.floor(byteCap), ERROR_RESULT_MAX_BYTES) : 0;
	const safeLineCap = Number.isFinite(lineCap) && lineCap > 0 ? Math.floor(lineCap) : 0;
	const text = prefix(FAILURE_TEXT, safeByteCap, Math.min(safeLineCap, 1));
	return {
		content: text ? [{ type: "text", text }] : [],
		facts: { schema: "workbench-output-v1", policy: policyId, truncated: true, originalTextBytes: 0, originalTextLines: 0, shownTextBytes: bytes(text), shownTextLines: lines(text), omittedTextBytes: 0, omittedTextLines: 0, originalImageCount: 0, shownImageCount: 0, omittedImageCount: 0, reason: "runtime-failure" },
		isError: true,
	};
}

function marker(
	omittedBytes: number,
	omittedLines: number,
	replayAction: string,
	continuation?: BoundedContinuation,
	receiptId?: string,
): string {
	// A receipt stores only the already-bounded post-envelope summary; it is
	// never advertised as recovery for raw omitted text. A trusted continuation
	// is exact replay authority. Otherwise surface a fixed, tool-class-derived
	// re-query action before the omission counters so it survives ordinary caps.
	const parts = continuation
		? [`continuation=${boundedInline(continuation.kind)}:${boundedInline(continuation.value)}`]
		: [`action=${replayAction}`];
	parts.push(`omitted_bytes=${omittedBytes}`, `omitted_lines=${omittedLines}`);
	if (receiptId) parts.push(`receipt=${boundedInline(receiptId)}`);
	return `[workbench-output truncated ${parts.join(" ")}]`;
}

function truncationReason(
	originalTextBytes: number,
	originalTextLines: number,
	omittedImageCount: number,
	allocatedBytes: number,
	applicablePolicyBytes: number,
	policyLines: number,
): Exclude<OutputEnvelopeReason, "none" | "runtime-failure"> {
	// A smaller reservation is the cause only when the original text crosses
	// that smaller byte boundary but would fit the applicable policy/error
	// boundary. Line caps and image omission are policy-owned constraints and
	// therefore do not become reservation failures merely because the numeric
	// allocation happens to be lower than the policy cap.
	return omittedImageCount === 0
		&& originalTextLines <= policyLines
		&& allocatedBytes < applicablePolicyBytes
		&& originalTextBytes > allocatedBytes
		&& originalTextBytes <= applicablePolicyBytes
		? "turn-reservation"
		: "per-tool-cap";
}

export function enforceOutputEnvelope(input: EnforceOutputEnvelopeInput): OutputEnvelopeResult {
	let policyId: OutputPolicyId = "default";
	let allocated = 0;
	// Failure output starts at the safest possible lower bound. These values
	// are raised only after every contributing cap has been read and validated,
	// so a throwing input/policy getter can never make the catch path fall back
	// to a larger default.
	let failureByteCap: number = 0;
	let failureLineCap: number = 0;
	try {
		const selectedPolicy = input.policy;
		const hardCeiling = resolveOutputPolicyHardCeiling(selectedPolicy.id);
		policyId = hardCeiling.id;
		const rawPolicyCap = selectedPolicy.maxTextBytes;
		const policyCap = Number.isFinite(rawPolicyCap) && rawPolicyCap > 0
			? Math.min(Math.floor(rawPolicyCap), hardCeiling.maxTextBytes)
			: 0;
		const rawLineCap = selectedPolicy.maxLines;
		const lineCap = Number.isFinite(rawLineCap) && rawLineCap > 0
			? Math.min(Math.floor(rawLineCap), hardCeiling.maxLines)
			: 0;
		const rawAllocated = input.allocatedBytes;
		allocated = Number.isFinite(rawAllocated) && rawAllocated > 0 ? Math.floor(rawAllocated) : 0;
		failureByteCap = Math.min(allocated, policyCap, ERROR_RESULT_MAX_BYTES);
		failureLineCap = lineCap;
		const isError = input.isError === true;
		const effectivePolicyCap = Math.min(policyCap, isError ? ERROR_RESULT_MAX_BYTES : policyCap);
		const byteCap = Math.min(effectivePolicyCap, allocated);

		const blocks = Array.from(input.content);
		const normalized: Array<TextContent | ImageContent> = [];
		let originalImages = 0;
		for (const block of blocks) {
			if (block.type === "text") {
				if (typeof block.text !== "string") throw new Error("invalid text content");
				normalized.push({ type: "text", text: scalarText(block.text) });
			} else if (block.type === "image") {
				if (typeof block.data !== "string" || typeof block.mimeType !== "string") throw new Error("invalid image content");
				normalized.push({ type: "image", data: block.data, mimeType: block.mimeType });
				originalImages += 1;
			}
			else throw new Error("unsupported content");
		}
		const textSources = normalized.filter((block): block is TextContent => block.type === "text").map((block) => block.text);
		// Pi provider adapters join separate text content blocks with one newline.
		// Canonicalize that exact model-visible text before measuring or cutting;
		// downstream turn/history accounting can then count the single text block
		// without any hidden inter-block separator amplification.
		const originalText = textSources.join("\n");
		const originalBytes = bytes(originalText);
		const originalLines = lines(originalText);
		if (byteCap <= 0 || lineCap <= 0) {
			const truncated = originalBytes > 0 || originalImages > 0;
			return { content: [], facts: { schema: "workbench-output-v1", policy: policyId, truncated, originalTextBytes: originalBytes, originalTextLines: originalLines, shownTextBytes: 0, shownTextLines: 0, omittedTextBytes: originalBytes, omittedTextLines: originalLines, originalImageCount: originalImages, shownImageCount: 0, omittedImageCount: originalImages, reason: truncated ? truncationReason(originalBytes, originalLines, originalImages, allocated, effectivePolicyCap, lineCap) : "none" }, isError };
		}
		const continuationValue = input.continuation;
		const safeContinuation = continuationValue
			? { kind: boundedInline(continuationValue.kind), value: boundedInline(continuationValue.value) }
			: undefined;
		const receipt = boundedInline(input.receiptId);
		const replayAction = input.toolName === "bash" ? BASH_REPLAY_ACTION : GENERIC_REPLAY_ACTION;
		const preserveImages = policyId === "native-read-page"
			&& hardCeiling.preserveImages
			&& selectedPolicy.preserveImages === true;
		const keptImage = preserveImages
			? normalized.find((block): block is ImageContent => block.type === "image")
			: undefined;
		const keepImage = keptImage !== undefined;
		const omittedImages = originalImages - (keepImage ? 1 : 0);
		const needsClamp = originalBytes > byteCap || originalLines > lineCap || omittedImages > 0;
		let reservedMarker = needsClamp ? marker(originalBytes, originalLines, replayAction, safeContinuation, receipt) : "";
		if (omittedImages > 0) reservedMarker = `${IMAGE_OMISSION} ${reservedMarker}`;
		reservedMarker = prefix(reservedMarker, byteCap, lineCap);
		const remainingBytes = Math.max(0, byteCap - bytes(reservedMarker) - (reservedMarker ? 1 : 0));
		const remainingLines = Math.max(0, lineCap - (reservedMarker ? 1 : 0));
		const sourceText = needsClamp ? prefix(originalText, remainingBytes, remainingLines) : originalText;
		const sourceShownBytes = bytes(sourceText);
		const sourceShownLines = lines(sourceText);
		const omittedBytes = Math.max(0, originalBytes - sourceShownBytes);
		const omittedLines = Math.max(0, originalLines - sourceShownLines);
		let finalMarker = "";
		if (needsClamp) {
			finalMarker = marker(omittedBytes, omittedLines, replayAction, safeContinuation, receipt);
			if (omittedImages > 0) finalMarker = `${IMAGE_OMISSION} ${finalMarker}`;
			finalMarker = prefix(finalMarker, byteCap - sourceShownBytes - (sourceShownBytes > 0 ? 1 : 0), Math.max(0, lineCap - sourceShownLines));
		}
		const finalText = sourceText && finalMarker ? `${sourceText}\n${finalMarker}` : sourceText || finalMarker;
		const content: Array<TextContent | ImageContent> = [];
		if (keptImage) content.push(keptImage);
		if (finalText) content.push({ type: "text", text: finalText });
		const shownBytes = bytes(finalText);
		const shownLines = lines(finalText);
		return {
			content,
				facts: { schema: "workbench-output-v1", policy: policyId, truncated: needsClamp, originalTextBytes: originalBytes, originalTextLines: originalLines, shownTextBytes: shownBytes, shownTextLines: shownLines, omittedTextBytes: omittedBytes, omittedTextLines: omittedLines, originalImageCount: originalImages, shownImageCount: keepImage ? 1 : 0, omittedImageCount: omittedImages, reason: needsClamp ? truncationReason(originalBytes, originalLines, omittedImages, allocated, effectivePolicyCap, lineCap) : "none", ...(safeContinuation && needsClamp ? { continuation: safeContinuation } : {}) },
				isError,
		};
	} catch {
		return safeFailure(policyId, failureByteCap, failureLineCap);
	}
}

export interface EnforceStreamingUpdateInput {
	toolName: string;
	content: unknown;
}

/**
 * Apply the non-negotiable partial-update boundary.
 *
 * This deliberately has no continuation, receipt, or caller-controlled
 * allocation.  It cannot consume or enlarge a final result reservation, and
 * images are omitted by the fixed policy.  Malformed/hostile content follows
 * the same deterministic fail-closed path as final envelopes.
 */
export function enforceStreamingUpdate(input: EnforceStreamingUpdateInput): OutputEnvelopeResult {
	let toolName = "";
	let content: unknown;
	try {
		toolName = typeof input.toolName === "string" ? input.toolName : "";
		content = input.content;
	} catch {
		content = undefined;
	}
	return enforceOutputEnvelope({
		toolName,
		content: content as Array<TextContent | ImageContent>,
		isError: false,
		policy: STREAM_UPDATE_POLICY,
		allocatedBytes: STREAM_UPDATE_MAX_BYTES,
	});
}
