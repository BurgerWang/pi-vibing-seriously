import { createHash, type Hash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

/** The message union Pi exposes to the extension `context` event. */
export type AgentMessage = ContextEvent["messages"][number];

export type HistoryProjectionRole = "commander" | "worker" | "other";

export const COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES = 96 * 1_024;
export const WORKER_HISTORY_TOOL_TEXT_MAX_BYTES = 64 * 1_024;
export const OTHER_HISTORY_TOOL_TEXT_MAX_BYTES = 64 * 1_024;
export const HISTORY_MAX_BUNDLES = 128;
export const HISTORY_DESCRIPTOR_MAX_BYTES = 384;
export const HISTORY_PROJECTION_ENTRY_TYPE = "workbench-history-projection-state-v1";
export const HISTORY_PROJECTION_LOW_WATERMARK_PERCENT = 75;
export const HISTORY_PROJECTION_LOW_WATERMARK_BUNDLES = 96;

export interface HistoryProjectionFacts {
	originalToolTextBytes: number;
	finalToolTextBytes: number;
	collapsedResults: number;
	removedBundles: number;
	protectedLatestBundles: number;
}

export interface ProjectContextHistoryInput {
	messages: readonly AgentMessage[];
	maxToolTextBytes: number;
	maxBundles: number;
	descriptorMaxBytes: number;
	/** Unknown roles deliberately receive the worker/other ceiling. */
	role?: HistoryProjectionRole | (string & {});
}

export interface ProjectContextHistoryResult {
	messages: AgentMessage[];
	facts: HistoryProjectionFacts;
}

export interface HistoryProjectionControllerResult extends ProjectContextHistoryResult {
	epoch: number;
	epochHash: string | null;
	epochTransitioned: boolean;
	newlyCollapsedResults: number;
	newlyRemovedBundles: number;
	rawBundleCount: number;
	projectedBundleCount: number;
}

export interface HistoryProjectionStateEntryData {
	schemaVersion: 1;
	active: 0 | 1;
	epoch: number;
	epochHash: string;
	prefixMessageCount: number;
	prefixHash: string;
	projectedPrefixHash: string;
	hardToolTextBytes: number;
	hardBundles: number;
	lowToolTextBytes: number;
	lowBundles: number;
	transitionCollapsedResults: number;
	transitionRemovedBundles: number;
	rawToolTextBytes: number;
	rawBundles: number;
	projectedToolTextBytes: number;
	projectedBundles: number;
}

interface ToolCallIdentity {
	id: string;
	name: string;
}

interface ToolResultIdentity {
	id: string;
	name: string;
}

interface ToolBundle {
	assistantIndex: number;
	resultIndices: number[];
	calls: ToolCallIdentity[];
	rawTextBytes: number;
}

interface HistoryAnalysis {
	valid: boolean;
	bundles: ToolBundle[];
}

interface RemovalRange {
	start: number;
	end: number;
	bundles: number;
	results: number;
	omittedBytes: number;
	timestamp: number;
}

interface FailureProjection {
	messages: AgentMessage[];
	removedBundles: number;
	collapsedResults: number;
	protectedLatestBundles: number;
}

const RECEIPT_ID_PATTERN = /^wtr1-[0-9a-f]{64}$/;
const BOUNDED_PATH_PATTERN = /^(?:\.pi\/workbench\/(?:runs|comparisons|delegations|gates|tool-results)\/)[A-Za-z0-9._/+-]{1,384}$/;
const BOUNDED_DETAILS_MAX_BYTES = 8_192;
const BOUNDED_DETAILS_MAX_STRING_BYTES = 512;
const BOUNDED_DETAILS_MAX_DEPTH = 4;
const BOUNDED_DETAILS_MAX_KEYS = 32;
const ENVELOPE_POLICIES = new Set([
	"native-read-page", "native-search", "run-summary", "run-log-page", "gate-summary", "gate-read",
	"diff-review", "compare", "worker-handoff", "recovery", "default",
]);
const ENVELOPE_REASONS = new Set(["none", "per-tool-cap", "turn-reservation", "runtime-failure"]);
const SOURCE_FIELDS_BY_TOOL: Readonly<Record<string, readonly string[]>> = Object.freeze({
	workbench_read_run: ["source_path", "stdout_log", "stderr_log"],
	workbench_run_recipe: ["stdout_log", "stderr_log"],
	workbench_compare_runs: ["comparison_path"],
	workbench_delegate_worker: ["report_path"],
	workbench_review_worker_diff: ["review_record"],
	workbench_read_gate: ["source_path"],
	workbench_list_gates: ["source_path"],
	workbench_run_gate: ["source_path"],
});

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

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

function utf8Prefix(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let output = "";
	let used = 0;
	for (const scalar of unicodeScalarText(value)) {
		const size = utf8Bytes(scalar);
		if (used + size > maxBytes) break;
		output += scalar;
		used += size;
	}
	return output;
}

function boundedInline(value: string, maxBytes: number): string {
	const inline = unicodeScalarText(value)
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return utf8Prefix(inline, maxBytes);
}

function roleOf(message: AgentMessage): string | undefined {
	const role = dataValue(message, "role");
	return typeof role === "string" ? role : undefined;
}

function contentOf(message: AgentMessage): readonly unknown[] {
	const content = dataValue(message, "content");
	return Array.isArray(content) ? content : [];
}

function blockType(block: unknown): string | undefined {
	if (block === null || (typeof block !== "object" && typeof block !== "function")) return undefined;
	if (utilTypes.isProxy(block)) throw new Error("proxy content block is not inspectable");
	const descriptor = Object.getOwnPropertyDescriptor(block, "type");
	return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value") && typeof descriptor.value === "string"
		? descriptor.value
		: undefined;
}

function dataValue(value: unknown, key: string): unknown {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
	if (utilTypes.isProxy(value)) throw new Error("proxy history value is not inspectable");
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value") ? descriptor.value : undefined;
}

function replaceMessageContent(message: AgentMessage, content: readonly unknown[]): AgentMessage {
	if (utilTypes.isProxy(message)) throw new Error("proxy history message is not inspectable");
	const descriptors = Object.getOwnPropertyDescriptors(message);
	const output: Record<string, unknown> = {};
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (key === "content" || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) continue;
		Object.defineProperty(output, key, {
			value: descriptor.value,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	Object.defineProperty(output, "content", {
		value: Array.from(content),
		enumerable: true,
		writable: true,
		configurable: true,
	});
	return output as unknown as AgentMessage;
}

function extractToolCalls(message: AgentMessage): ToolCallIdentity[] | undefined {
	if (roleOf(message) !== "assistant") return [];
	const calls: ToolCallIdentity[] = [];
	const localIds = new Set<string>();
	for (const block of contentOf(message)) {
		if (blockType(block) !== "toolCall") continue;
		const id = dataValue(block, "id");
		const name = dataValue(block, "name");
		if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) return undefined;
		if (localIds.has(id)) return undefined;
		localIds.add(id);
		calls.push({ id, name });
	}
	return calls;
}

function hasToolCallBlock(message: AgentMessage): boolean {
	if (roleOf(message) !== "assistant") return false;
	return contentOf(message).some((block) => blockType(block) === "toolCall");
}

function extractToolResultIdentity(message: AgentMessage): ToolResultIdentity | undefined {
	if (roleOf(message) !== "toolResult") return undefined;
	const id = dataValue(message, "toolCallId");
	const name = dataValue(message, "toolName");
	if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) return undefined;
	return { id, name };
}

function toolResultTextBytes(message: AgentMessage): number {
	if (roleOf(message) !== "toolResult") return 0;
	let total = 0;
	for (const block of contentOf(message)) {
		if (blockType(block) !== "text") continue;
		const text = dataValue(block, "text");
		if (typeof text === "string") total += utf8Bytes(text);
	}
	return total;
}

/** Count only model-visible text blocks carried by tool-result messages. */
export function historyToolTextBytes(messages: readonly AgentMessage[]): number {
	let total = 0;
	for (const message of messages) total += toolResultTextBytes(message);
	return total;
}

function analyzeContextHistory(messages: readonly AgentMessage[]): HistoryAnalysis {
	const bundles: ToolBundle[] = [];
	const seenCalls = new Set<string>();
	const seenResults = new Set<string>();

	for (let index = 0; index < messages.length;) {
		const message = messages[index];
		if (!message) return { valid: false, bundles };
		const role = roleOf(message);
		if (role === "toolResult") return { valid: false, bundles };
		if (role !== "assistant") {
			index += 1;
			continue;
		}

		const calls = extractToolCalls(message);
		if (!calls) return { valid: false, bundles };
		if (calls.length === 0) {
			index += 1;
			continue;
		}
		const expected = new Map<string, string>();
		for (const call of calls) {
			if (seenCalls.has(call.id)) return { valid: false, bundles };
			seenCalls.add(call.id);
			expected.set(call.id, call.name);
		}

		const resultIndices: number[] = [];
		let cursor = index + 1;
		while (cursor < messages.length) {
			const candidate = messages[cursor];
			if (!candidate || roleOf(candidate) !== "toolResult") break;
			const result = extractToolResultIdentity(candidate);
			if (!result || seenResults.has(result.id)) return { valid: false, bundles };
			const expectedName = expected.get(result.id);
			if (expectedName === undefined || expectedName !== result.name) return { valid: false, bundles };
			seenResults.add(result.id);
			expected.delete(result.id);
			resultIndices.push(cursor);
			cursor += 1;
		}
		if (expected.size !== 0 || resultIndices.length !== calls.length) return { valid: false, bundles };
		bundles.push({
			assistantIndex: index,
			resultIndices,
			calls,
			rawTextBytes: resultIndices.reduce((sum, resultIndex) => sum + toolResultTextBytes(messages[resultIndex]!), 0),
		});
		index = cursor;
	}
	return { valid: true, bundles };
}

/** Validate global, exact-id call/result pairing and contiguous tool batches. */
export function validateContextToolPairing(messages: readonly AgentMessage[]): boolean {
	try {
		return analyzeContextHistory(messages).valid;
	} catch {
		return false;
	}
}

function boundedPointer(value: unknown): string | undefined {
	if (typeof value !== "string" || utf8Bytes(value) > 384) return undefined;
	if (!BOUNDED_PATH_PATTERN.test(value) || value.includes("..") || value.includes("//")) return undefined;
	return value;
}

function boundedDetailsData(
	value: unknown,
	depth: number,
	active: WeakSet<object>,
	state: { bytes: number },
): boolean {
	const add = (amount: number): boolean => {
		state.bytes += amount;
		return state.bytes <= BOUNDED_DETAILS_MAX_BYTES;
	};
	if (value === null) return add(4);
	if (typeof value === "boolean") return add(value ? 4 : 5);
	if (typeof value === "number") return Number.isFinite(value) && add(utf8Bytes(String(value)));
	if (typeof value === "string") {
		return utf8Bytes(value) <= BOUNDED_DETAILS_MAX_STRING_BYTES && add(utf8Bytes(JSON.stringify(value)));
	}
	if (typeof value !== "object" || utilTypes.isProxy(value) || depth >= BOUNDED_DETAILS_MAX_DEPTH) return false;
	if (active.has(value)) return false;
	active.add(value);
	try {
		if (Object.getOwnPropertySymbols(value).length !== 0) return false;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const entries = Object.entries(descriptors).filter(([key, descriptor]) => key !== "length" && descriptor.enumerable === true);
		if (entries.length > BOUNDED_DETAILS_MAX_KEYS) return false;
		if (Array.isArray(value) && value.length > BOUNDED_DETAILS_MAX_KEYS) return false;
		if (!Array.isArray(value)) {
			const prototype = Object.getPrototypeOf(value);
			if (prototype !== Object.prototype && prototype !== null) return false;
		}
		if (!add(2 + Math.max(0, entries.length - 1))) return false;
		for (const [key, descriptor] of entries) {
			if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) return false;
			if (utf8Bytes(key) > 128 || !add(utf8Bytes(JSON.stringify(key)) + 1)) return false;
			if (!boundedDetailsData(descriptor.value, depth + 1, active, state)) return false;
		}
		return true;
	} finally {
		active.delete(value);
	}
}

function isBoundedProjectedDetails(details: object): boolean {
	return boundedDetailsData(details, 0, new WeakSet<object>(), { bytes: 0 });
}

function hasTrustedEnvelope(details: object): boolean {
	const envelope = dataValue(details, "output_envelope");
	if (envelope === null || typeof envelope !== "object" || utilTypes.isProxy(envelope)) return false;
	const schema = dataValue(envelope, "schema");
	const policy = dataValue(envelope, "policy");
	const truncated = dataValue(envelope, "truncated");
	const reason = dataValue(envelope, "reason");
	if (schema !== "workbench-output-v1"
		|| typeof policy !== "string" || !ENVELOPE_POLICIES.has(policy)
		|| typeof truncated !== "boolean"
		|| typeof reason !== "string" || !ENVELOPE_REASONS.has(reason)) return false;
	for (const key of [
		"originalTextBytes", "originalTextLines", "shownTextBytes", "shownTextLines", "omittedTextBytes", "omittedTextLines",
		"originalImageCount", "shownImageCount", "omittedImageCount",
	]) {
		const value = dataValue(envelope, key);
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return false;
	}
	return true;
}

function pointerFromDetails(details: unknown, toolName: string): { key: "source" | "receipt"; value: string } | undefined {
	if (details === null || typeof details !== "object" || utilTypes.isProxy(details)) return undefined;
	if (!isBoundedProjectedDetails(details)) return undefined;
	if (!hasTrustedEnvelope(details)) return undefined;
	const descriptors = Object.getOwnPropertyDescriptors(details);
	const keys = Object.keys(descriptors);
	if (keys.length > 32) return undefined;
	for (const descriptor of Object.values(descriptors)) {
		if (descriptor.enumerable === true && !Object.prototype.hasOwnProperty.call(descriptor, "value")) return undefined;
	}

	const receipt = dataValue(details, "receipt");
	if (receipt !== null && typeof receipt === "object" && !utilTypes.isProxy(receipt)) {
		const receiptDescriptors = Object.getOwnPropertyDescriptors(receipt);
		if (Object.keys(receiptDescriptors).length <= 8
			&& Object.values(receiptDescriptors).every((descriptor) => (
				descriptor.enumerable !== true || Object.prototype.hasOwnProperty.call(descriptor, "value")
			))) {
			const available = dataValue(receipt, "available");
			const receiptId = dataValue(receipt, "result_id");
			const receiptPath = boundedPointer(dataValue(receipt, "path"));
			if (available === true && typeof receiptId === "string" && RECEIPT_ID_PATTERN.test(receiptId)) {
				return { key: "receipt", value: receiptPath ?? receiptId };
			}
		}
	}

	for (const key of SOURCE_FIELDS_BY_TOOL[toolName] ?? []) {
		const candidate = boundedPointer(dataValue(details, key));
		if (candidate) return { key: "source", value: candidate };
	}
	return undefined;
}

function historicalDescriptor(message: AgentMessage, descriptorMaxBytes: number): string {
	const cap = Math.min(HISTORY_DESCRIPTOR_MAX_BYTES, Math.max(0, Math.floor(descriptorMaxBytes)));
	if (cap === 0) return "";
	const rawToolName = dataValue(message, "toolName");
	const toolName = typeof rawToolName === "string" ? (boundedInline(rawToolName, 64) || "unknown") : "unknown";
	const status = dataValue(message, "isError") === true ? "error" : "success";
	const originalBytes = toolResultTextBytes(message);
	const pointer = pointerFromDetails(dataValue(message, "details"), typeof rawToolName === "string" ? rawToolName : "");
	const base = [
		"[historical tool result collapsed]",
		`tool=${toolName} status=${status}`,
		`original_bytes=${originalBytes} shown_in_history=0`,
	];
	const pointerLine = pointer ? `${pointer.key}=${pointer.value}` : undefined;
	const descriptor = [
		...base,
		pointerLine && utf8Bytes([...base, pointerLine].join("\n")) <= cap
			? pointerLine
			: "action=re-query this tool with a bounded request",
	].join("\n");
	return utf8Prefix(descriptor, cap);
}

/** Replace one result's content with a bounded, raw-output-free descriptor. */
export function collapseHistoricalToolResult(
	message: AgentMessage,
	descriptorMaxBytes = HISTORY_DESCRIPTOR_MAX_BYTES,
): AgentMessage {
	try {
		if (roleOf(message) !== "toolResult") return message;
		const descriptor = historicalDescriptor(message, descriptorMaxBytes);
		return replaceMessageContent(message, descriptor ? [{ type: "text", text: descriptor }] : []);
	} catch {
		// A hostile details value must never cause raw result content to escape.
		try {
			return replaceMessageContent(message, []);
		} catch {
			throw new Error("history result projection failed closed");
		}
	}
}

function stripToolCalls(message: AgentMessage): AgentMessage | undefined {
	if (roleOf(message) !== "assistant") return message;
	const content = contentOf(message).filter((block) => blockType(block) !== "toolCall");
	if (content.length === 0) return undefined;
	return replaceMessageContent(message, content);
}

function timestampOf(message: AgentMessage | undefined): number {
	if (!message) return 0;
	const timestamp = dataValue(message, "timestamp");
	return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : 0;
}

function hiddenProjectionMessage(input: {
	bundles: number;
	results: number;
	omittedBytes: number;
	timestamp: number;
}): AgentMessage {
	return {
		role: "custom",
		customType: "workbench-history-projection",
		content: [
			"[workbench history projection]",
			`collapsed_bundles=${input.bundles} collapsed_results=${input.results} omitted_tool_text_bytes=${input.omittedBytes}`,
			"Authoritative evidence remains in bounded paths already recorded by the session.",
		].join("\n"),
		display: false,
		details: {
			collapsed_bundles: input.bundles,
			collapsed_results: input.results,
			omitted_tool_text_bytes: input.omittedBytes,
		},
		timestamp: input.timestamp,
	} as AgentMessage;
}

function projectionFailureMessage(omittedToolTextBytes = 0): AgentMessage {
	return {
		role: "custom",
		customType: "workbench-history-projection-failure",
		content: "[workbench history projection failure]\nTool history was omitted because safe pairing could not be established.",
		display: false,
		details: {
			projection_failed: 1,
			omitted_tool_text_bytes: Math.max(0, Math.floor(omittedToolTextBytes)),
		},
		timestamp: 0,
	} as AgentMessage;
}

/**
 * Absolute fail-closed projection. This helper deliberately accepts no
 * history input, so callers can use it after any hostile inspection fails
 * without touching the failed value a second time.
 */
export function safeHistoryProjectionFailureMessages(): AgentMessage[] {
	return [projectionFailureMessage()];
}

function roleCeiling(role: ProjectContextHistoryInput["role"]): number {
	return role === "commander" ? COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES : WORKER_HISTORY_TOOL_TEXT_MAX_BYTES;
}

function effectiveByteCap(input: ProjectContextHistoryInput): number {
	const requested = input.maxToolTextBytes;
	if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return 0;
	return Math.min(Math.floor(requested), roleCeiling(input.role));
}

function effectiveBundleCap(value: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 1;
	return Math.min(HISTORY_MAX_BUNDLES, Math.max(1, Math.floor(value)));
}

function effectiveDescriptorCap(value: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.min(HISTORY_DESCRIPTOR_MAX_BYTES, Math.floor(value));
}

function localCompleteBundles(messages: readonly AgentMessage[]): ToolBundle[] {
	const bundles: ToolBundle[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const assistant = messages[index];
		if (!assistant || roleOf(assistant) !== "assistant") continue;
		const calls = extractToolCalls(assistant);
		if (!calls || calls.length === 0) continue;
		const expected = new Map(calls.map((call) => [call.id, call.name]));
		const resultIndices: number[] = [];
		let cursor = index + 1;
		let valid = true;
		while (cursor < messages.length && roleOf(messages[cursor]!) === "toolResult") {
			const result = extractToolResultIdentity(messages[cursor]!);
			if (!result || expected.get(result.id) !== result.name) {
				valid = false;
				break;
			}
			expected.delete(result.id);
			resultIndices.push(cursor);
			cursor += 1;
		}
		if (!valid || expected.size !== 0 || resultIndices.length !== calls.length) continue;
		bundles.push({
			assistantIndex: index,
			resultIndices,
			calls,
			rawTextBytes: resultIndices.reduce((sum, resultIndex) => sum + toolResultTextBytes(messages[resultIndex]!), 0),
		});
	}
	return bundles;
}

function collapseIndicesToTotal(
	working: Array<AgentMessage | undefined>,
	original: readonly AgentMessage[],
	indices: readonly number[],
	totalBytes: number,
	descriptorMaxBytes: number,
): void {
	let remaining = Math.max(0, totalBytes);
	for (let position = 0; position < indices.length; position += 1) {
		const index = indices[position]!;
		const remainingResults = indices.length - position;
		const allocation = Math.min(descriptorMaxBytes, Math.floor(remaining / remainingResults));
		const projected = collapseHistoricalToolResult(original[index]!, allocation);
		working[index] = projected;
		remaining -= toolResultTextBytes(projected);
	}
}

function buildFailureProjection(
	messages: readonly AgentMessage[],
	maxToolTextBytes: number,
	descriptorMaxBytes: number,
): FailureProjection {
	const candidates = localCompleteBundles(messages);
	const selected = candidates.at(-1);
	const selectedIndices = new Set<number>();
	if (selected) {
		selectedIndices.add(selected.assistantIndex);
		for (const index of selected.resultIndices) selectedIndices.add(index);
	}

	const working: Array<AgentMessage | undefined> = Array.from(messages);
	let collapsedSelected = 0;
	if (selected && selected.rawTextBytes > maxToolTextBytes) {
		collapseIndicesToTotal(working, messages, selected.resultIndices, maxToolTextBytes, descriptorMaxBytes);
		collapsedSelected = selected.resultIndices.length;
	}

	const output: AgentMessage[] = [];
	let removedBundles = 0;
	let removedResults = 0;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index]!;
		if (selectedIndices.has(index)) {
			output.push(working[index]!);
			continue;
		}
		if (roleOf(message) === "toolResult") {
			removedResults += 1;
			continue;
		}
		if (hasToolCallBlock(message)) {
			removedBundles += 1;
			const stripped = stripToolCalls(message);
			if (stripped) output.push(stripped);
			continue;
		}
		output.push(message);
	}

	const finalBytes = historyToolTextBytes(output);
	const originalBytes = historyToolTextBytes(messages);
	const collapsedResults = removedResults + collapsedSelected;
	if (removedBundles > 0 || collapsedResults > 0) {
		output.push(hiddenProjectionMessage({
			bundles: removedBundles,
			results: collapsedResults,
			omittedBytes: Math.max(0, originalBytes - finalBytes),
			timestamp: timestampOf(messages.at(-1)),
		}));
	}
	output.push(projectionFailureMessage(Math.max(0, originalBytes - finalBytes)));

	if (!validateContextToolPairing(output) || historyToolTextBytes(output) > maxToolTextBytes) {
		// Absolute last-resort safety boundary: no tool material can escape.
		return { messages: [projectionFailureMessage(originalBytes)], removedBundles, collapsedResults, protectedLatestBundles: 0 };
	}
	return {
		messages: output,
		removedBundles,
		collapsedResults,
		protectedLatestBundles: selected ? 1 : 0,
	};
}

/**
 * Build the fail-closed context used when global pairing is already corrupt.
 * It preserves ordinary messages and, when locally valid, the latest complete
 * tool batch. The public helper defaults to the safer worker/other ceiling.
 */
export function historyProjectionFailureMessages(
	messages: readonly AgentMessage[],
	maxToolTextBytes = OTHER_HISTORY_TOOL_TEXT_MAX_BYTES,
	descriptorMaxBytes = HISTORY_DESCRIPTOR_MAX_BYTES,
): AgentMessage[] {
	try {
		const byteCap = typeof maxToolTextBytes === "number" && Number.isFinite(maxToolTextBytes) && maxToolTextBytes > 0
			? Math.min(Math.floor(maxToolTextBytes), OTHER_HISTORY_TOOL_TEXT_MAX_BYTES)
			: 0;
		const descriptorCap = effectiveDescriptorCap(descriptorMaxBytes);
		return buildFailureProjection(messages, byteCap, descriptorCap).messages;
	} catch {
		return safeHistoryProjectionFailureMessages();
	}
}

function groupedRemovalRanges(removed: readonly ToolBundle[], messages: readonly AgentMessage[]): RemovalRange[] {
	const ranges: RemovalRange[] = [];
	for (const bundle of removed) {
		const end = bundle.resultIndices.at(-1) ?? bundle.assistantIndex;
		const next: RemovalRange = {
			start: bundle.assistantIndex,
			end,
			bundles: 1,
			results: bundle.resultIndices.length,
			omittedBytes: bundle.rawTextBytes,
			timestamp: timestampOf(messages[end]),
		};
		const previous = ranges.at(-1);
		if (previous && next.start <= previous.end + 1) {
			previous.end = next.end;
			previous.bundles += next.bundles;
			previous.results += next.results;
			previous.omittedBytes += next.omittedBytes;
			previous.timestamp = next.timestamp;
		} else {
			ranges.push(next);
		}
	}
	return ranges;
}

function reconstructAfterRemoval(
	working: readonly (AgentMessage | undefined)[],
	original: readonly AgentMessage[],
	removed: readonly ToolBundle[],
): AgentMessage[] {
	if (removed.length === 0) return working.filter((message): message is AgentMessage => message !== undefined);
	const removedAssistants = new Set(removed.map((bundle) => bundle.assistantIndex));
	const removedResults = new Set(removed.flatMap((bundle) => bundle.resultIndices));
	const ranges = groupedRemovalRanges(removed, original);
	const rangeByEnd = new Map(ranges.map((range) => [range.end, range]));
	const output: AgentMessage[] = [];

	for (let index = 0; index < original.length; index += 1) {
		if (removedAssistants.has(index)) {
			const stripped = stripToolCalls(original[index]!);
			if (stripped) output.push(stripped);
		} else if (!removedResults.has(index)) {
			const message = working[index];
			if (message) output.push(message);
		}
		const range = rangeByEnd.get(index);
		if (range) {
			output.push(hiddenProjectionMessage({
				bundles: range.bundles,
				results: range.results,
				omittedBytes: range.omittedBytes,
				timestamp: range.timestamp,
			}));
		}
	}
	return output;
}

/**
 * Project outgoing history without mutating the session or its input messages.
 * All configurable limits are downward-only from fixed role/global ceilings.
 */
export function projectContextHistory(input: ProjectContextHistoryInput): ProjectContextHistoryResult {
	let originalToolTextBytes = 0;
	try {
		originalToolTextBytes = historyToolTextBytes(input.messages);
		const maxToolTextBytes = effectiveByteCap(input);
		const maxBundles = effectiveBundleCap(input.maxBundles);
		const descriptorMaxBytes = effectiveDescriptorCap(input.descriptorMaxBytes);
		const analysis = analyzeContextHistory(input.messages);
		if (!analysis.valid) {
			const failure = buildFailureProjection(input.messages, maxToolTextBytes, descriptorMaxBytes);
			return {
				messages: failure.messages,
				facts: {
					originalToolTextBytes,
					finalToolTextBytes: historyToolTextBytes(failure.messages),
					collapsedResults: failure.collapsedResults,
					removedBundles: failure.removedBundles,
					protectedLatestBundles: failure.protectedLatestBundles,
				},
			};
		}

		const bundles = analysis.bundles;
		let protectedLatestBundles = 0;
		if (bundles.length > 0) {
			protectedLatestBundles = 1;
			if (bundles.length >= 2 && maxBundles >= 2) {
				const latestTwoBytes = bundles[bundles.length - 1]!.rawTextBytes + bundles[bundles.length - 2]!.rawTextBytes;
				if (latestTwoBytes <= maxToolTextBytes) protectedLatestBundles = 2;
			}
		}

		if (originalToolTextBytes <= maxToolTextBytes && bundles.length <= maxBundles) {
			return {
				messages: Array.from(input.messages),
				facts: {
					originalToolTextBytes,
					finalToolTextBytes: originalToolTextBytes,
					collapsedResults: 0,
					removedBundles: 0,
					protectedLatestBundles,
				},
			};
		}

		const working: Array<AgentMessage | undefined> = Array.from(input.messages);
		const collapsedIndices = new Set<number>();
		const removed: ToolBundle[] = [];
		const removableCount = bundles.length - protectedLatestBundles;
		let retainedBundles = bundles.length;

		// Collapse old results before any whole-bundle deletion.
		for (let bundleIndex = 0; bundleIndex < removableCount; bundleIndex += 1) {
			if (historyToolTextBytes(working.filter((message): message is AgentMessage => message !== undefined)) <= maxToolTextBytes
				&& retainedBundles <= maxBundles) break;
			for (const resultIndex of bundles[bundleIndex]!.resultIndices) {
				working[resultIndex] = collapseHistoricalToolResult(input.messages[resultIndex]!, descriptorMaxBytes);
				collapsedIndices.add(resultIndex);
			}
		}

		for (let bundleIndex = 0; bundleIndex < removableCount; bundleIndex += 1) {
			const currentBytes = historyToolTextBytes(working.filter((message): message is AgentMessage => message !== undefined));
			if (currentBytes <= maxToolTextBytes && retainedBundles <= maxBundles) break;
			const bundle = bundles[bundleIndex]!;
			removed.push(bundle);
			for (const resultIndex of bundle.resultIndices) working[resultIndex] = undefined;
			retainedBundles -= 1;
		}

		let current = historyToolTextBytes(working.filter((message): message is AgentMessage => message !== undefined));
		if (current > maxToolTextBytes && protectedLatestBundles > 0) {
			const protectedBundles = bundles.slice(bundles.length - protectedLatestBundles);
			const protectedIndices = protectedBundles.flatMap((bundle) => bundle.resultIndices);
			const protectedSet = new Set(protectedIndices);
			const outsideBytes = working.reduce((sum, message, index) => {
				if (!message || protectedSet.has(index)) return sum;
				return sum + toolResultTextBytes(message);
			}, 0);
			collapseIndicesToTotal(
				working,
				input.messages,
				protectedIndices,
				Math.max(0, maxToolTextBytes - outsideBytes),
				descriptorMaxBytes,
			);
			for (const index of protectedIndices) collapsedIndices.add(index);
			current = historyToolTextBytes(working.filter((message): message is AgentMessage => message !== undefined));
		}

		const projected = reconstructAfterRemoval(working, input.messages, removed);
		const removedResultIndices = new Set(removed.flatMap((bundle) => bundle.resultIndices));
		const survivingCollapsedIndices = Array.from(collapsedIndices).filter((index) => !removedResultIndices.has(index));
		if (survivingCollapsedIndices.length > 0) {
			const omittedByCollapse = survivingCollapsedIndices.reduce((sum, index) => (
				sum + Math.max(0, toolResultTextBytes(input.messages[index]!) - toolResultTextBytes(working[index]!))
			), 0);
			projected.push(hiddenProjectionMessage({
				bundles: 0,
				results: survivingCollapsedIndices.length,
				omittedBytes: omittedByCollapse,
				timestamp: timestampOf(projected.at(-1)),
			}));
		}
		const finalToolTextBytes = historyToolTextBytes(projected);
		if (current > maxToolTextBytes
			|| finalToolTextBytes > maxToolTextBytes
			|| retainedBundles > maxBundles
			|| !validateContextToolPairing(projected)) {
			const failure = buildFailureProjection(input.messages, maxToolTextBytes, descriptorMaxBytes);
			return {
				messages: failure.messages,
				facts: {
					originalToolTextBytes,
					finalToolTextBytes: historyToolTextBytes(failure.messages),
					collapsedResults: failure.collapsedResults,
					removedBundles: failure.removedBundles,
					protectedLatestBundles: failure.protectedLatestBundles,
				},
			};
		}

		return {
			messages: projected,
			facts: {
				originalToolTextBytes,
				finalToolTextBytes,
				collapsedResults: collapsedIndices.size,
				removedBundles: removed.length,
				protectedLatestBundles,
			},
		};
	} catch {
		return {
			messages: [projectionFailureMessage(originalToolTextBytes)],
			facts: {
				originalToolTextBytes,
				finalToolTextBytes: 0,
				collapsedResults: 0,
				removedBundles: 0,
				protectedLatestBundles: 0,
			},
		};
	}
}

const HISTORY_PROJECTION_STATE_SCHEMA_VERSION = 1 as const;
const EMPTY_HISTORY_HASH = "0".repeat(64);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HISTORY_PROJECTION_STATE_KEYS = Object.freeze([
	"active", "epoch", "epochHash", "hardBundles", "hardToolTextBytes", "lowBundles", "lowToolTextBytes",
	"prefixHash", "prefixMessageCount", "projectedBundles", "projectedPrefixHash", "projectedToolTextBytes",
	"rawBundles", "rawToolTextBytes", "schemaVersion", "transitionCollapsedResults", "transitionRemovedBundles",
].sort());

interface FrozenHistoryProjectionEpoch {
	epoch: number;
	epochHash: string;
	prefixMessageCount: number;
	prefixHash: string;
	projectedPrefixHash: string;
	hardToolTextBytes: number;
	hardBundles: number;
	lowToolTextBytes: number;
	lowBundles: number;
	transitionCollapsedResults: number;
	transitionRemovedBundles: number;
}

interface HistoryPressureFacts {
	rawToolTextBytes: number;
	rawBundles: number;
	projectedToolTextBytes: number;
	projectedBundles: number;
}

function safeNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function updateCanonicalHashString(hash: Hash, tag: string, value: string): void {
	hash.update(tag);
	hash.update(String(utf8Bytes(value)));
	hash.update(":");
	hash.update(value);
	hash.update(";");
}

/**
 * Hash JSON-like history values without property access or JSON.stringify.
 * Proxies, accessors, custom prototypes, cycles and toJSON hooks are rejected
 * before they can execute; the controller then takes its fixed fail-closed
 * path. Only a digest escapes this routine.
 */
function updateCanonicalHistoryHash(hash: Hash, value: unknown, active: WeakSet<object>): void {
	if (value === null) {
		hash.update("null;");
		return;
	}
	switch (typeof value) {
		case "string":
			updateCanonicalHashString(hash, "s", value);
			return;
		case "boolean":
			hash.update(value ? "b1;" : "b0;");
			return;
		case "number":
			if (!Number.isFinite(value)) throw new Error("non-finite history number");
			updateCanonicalHashString(hash, "n", Object.is(value, -0) ? "0" : String(value));
			return;
		case "undefined":
			hash.update("u;");
			return;
		case "object":
			break;
		default:
			throw new Error("unsupported history value");
	}

	if (utilTypes.isProxy(value)) throw new Error("proxy history value is not hashable");
	if (active.has(value)) throw new Error("cyclic history value");
	const isArray = Array.isArray(value);
	const prototype = Object.getPrototypeOf(value);
	if (isArray ? prototype !== Array.prototype : (prototype !== Object.prototype && prototype !== null)) {
		throw new Error("non-plain history value");
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Object.prototype.hasOwnProperty.call(descriptors, "toJSON")) {
		throw new Error("custom history toJSON is not permitted");
	}
	active.add(value);
	try {
		if (isArray) {
			const lengthDescriptor = descriptors.length;
			if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value")
				|| typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value)
				|| lengthDescriptor.value < 0) throw new Error("invalid history array length");
			const length = lengthDescriptor.value;
			updateCanonicalHashString(hash, "a", String(length));
			const indices = Object.entries(descriptors)
				.filter(([key, descriptor]) => descriptor.enumerable === true && /^(?:0|[1-9][0-9]*)$/.test(key))
				.map(([key, descriptor]) => ({ key, index: Number(key), descriptor }))
				.filter(({ index }) => Number.isSafeInteger(index) && index >= 0 && index < length)
				.sort((left, right) => left.index - right.index);
			for (const { key, descriptor } of indices) {
				if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) throw new Error("history array accessor");
				updateCanonicalHashString(hash, "i", key);
				updateCanonicalHistoryHash(hash, descriptor.value, active);
			}
			hash.update("];");
			return;
		}

		hash.update("o;");
		const entries = Object.entries(descriptors)
			.filter(([, descriptor]) => descriptor.enumerable === true)
			.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
		for (const [key, descriptor] of entries) {
			if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) throw new Error("history object accessor");
			updateCanonicalHashString(hash, "k", key);
			updateCanonicalHistoryHash(hash, descriptor.value, active);
		}
		hash.update("};");
	} finally {
		active.delete(value);
	}
}

function hashHistoryMessages(messages: readonly AgentMessage[]): string {
	const hash = createHash("sha256");
	hash.update("workbench-history-canonical-v1;");
	updateCanonicalHistoryHash(hash, messages, new WeakSet<object>());
	return hash.digest("hex");
}

function historyBundleCount(messages: readonly AgentMessage[]): number | undefined {
	const analysis = analyzeContextHistory(messages);
	return analysis.valid ? analysis.bundles.length : undefined;
}

function strictProjectionState(value: unknown): HistoryProjectionStateEntryData | undefined {
	try {
		if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return undefined;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Object.keys(descriptors).sort();
		if (keys.length !== HISTORY_PROJECTION_STATE_KEYS.length
			|| keys.some((key, index) => key !== HISTORY_PROJECTION_STATE_KEYS[index])) return undefined;
		if (Object.values(descriptors).some((descriptor) => (
			descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")
		))) return undefined;
		const record = value as Record<string, unknown>;
		if (record.schemaVersion !== HISTORY_PROJECTION_STATE_SCHEMA_VERSION) return undefined;
		if (record.active !== 0 && record.active !== 1) return undefined;
		for (const key of [
			"epoch", "prefixMessageCount", "hardToolTextBytes", "hardBundles", "lowToolTextBytes", "lowBundles",
			"transitionCollapsedResults", "transitionRemovedBundles", "rawToolTextBytes", "rawBundles",
			"projectedToolTextBytes", "projectedBundles",
		]) {
			if (safeNonNegativeInteger(record[key]) === undefined) return undefined;
		}
		if (typeof record.epochHash !== "string" || !SHA256_PATTERN.test(record.epochHash)) return undefined;
		if (typeof record.prefixHash !== "string" || !SHA256_PATTERN.test(record.prefixHash)) return undefined;
		if (typeof record.projectedPrefixHash !== "string" || !SHA256_PATTERN.test(record.projectedPrefixHash)) return undefined;
		if (record.active === 1) {
			if ((record.epoch as number) < 1 || (record.prefixMessageCount as number) < 1) return undefined;
			if ((record.lowToolTextBytes as number) > (record.hardToolTextBytes as number)) return undefined;
			if ((record.lowBundles as number) > (record.hardBundles as number)) return undefined;
		} else if (record.prefixMessageCount !== 0
			|| record.epochHash !== EMPTY_HISTORY_HASH
			|| record.prefixHash !== EMPTY_HISTORY_HASH
			|| record.projectedPrefixHash !== EMPTY_HISTORY_HASH) return undefined;
		return record as unknown as HistoryProjectionStateEntryData;
	} catch {
		return undefined;
	}
}

function projectionEntryData(entry: unknown): { matched: boolean; data?: unknown } {
	try {
		if (entry === null || typeof entry !== "object" || utilTypes.isProxy(entry)) return { matched: false };
		if (dataValue(entry, "customType") !== HISTORY_PROJECTION_ENTRY_TYPE) return { matched: false };
		return { matched: true, data: dataValue(entry, "data") };
	} catch {
		return { matched: false };
	}
}

/**
 * Session-scoped, I/O-free projection state machine.
 *
 * A threshold crossing freezes the complete current history as one epoch and
 * projects that prefix once to a 75% / 96-bundle low watermark. Later calls
 * deterministically replay the same frozen prefix projection and append the
 * untouched suffix. The epoch advances only when that combined result reaches
 * a hard ceiling, so Pi/provider payloads remain append-only inside an epoch.
 */
export class HistoryProjectionController {
	private frozen: FrozenHistoryProjectionEpoch | undefined;
	private epochCounter = 0;
	private pressure: HistoryPressureFacts = {
		rawToolTextBytes: 0,
		rawBundles: 0,
		projectedToolTextBytes: 0,
		projectedBundles: 0,
	};

	reset(): void {
		if (this.frozen) this.epochCounter = Math.max(this.epochCounter, this.frozen.epoch) + 1;
		this.frozen = undefined;
		this.pressure = { rawToolTextBytes: 0, rawBundles: 0, projectedToolTextBytes: 0, projectedBundles: 0 };
	}

	restoreFromEntries(entries: readonly unknown[]): boolean {
		try {
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const candidate = projectionEntryData(entries[index]);
				if (!candidate.matched) continue;
				const parsed = strictProjectionState(candidate.data);
				if (!parsed) {
					this.frozen = undefined;
					this.epochCounter = 0;
					this.pressure = { rawToolTextBytes: 0, rawBundles: 0, projectedToolTextBytes: 0, projectedBundles: 0 };
					return false;
				}
				this.epochCounter = parsed.epoch;
				this.pressure = {
					rawToolTextBytes: parsed.rawToolTextBytes,
					rawBundles: parsed.rawBundles,
					projectedToolTextBytes: parsed.projectedToolTextBytes,
					projectedBundles: parsed.projectedBundles,
				};
				this.frozen = parsed.active === 1 ? {
					epoch: parsed.epoch,
					epochHash: parsed.epochHash,
					prefixMessageCount: parsed.prefixMessageCount,
					prefixHash: parsed.prefixHash,
					projectedPrefixHash: parsed.projectedPrefixHash,
					hardToolTextBytes: parsed.hardToolTextBytes,
					hardBundles: parsed.hardBundles,
					lowToolTextBytes: parsed.lowToolTextBytes,
					lowBundles: parsed.lowBundles,
					transitionCollapsedResults: parsed.transitionCollapsedResults,
					transitionRemovedBundles: parsed.transitionRemovedBundles,
				} : undefined;
				return true;
			}
		} catch {
			this.frozen = undefined;
			this.epochCounter = 0;
			this.pressure = { rawToolTextBytes: 0, rawBundles: 0, projectedToolTextBytes: 0, projectedBundles: 0 };
			return false;
		}
		this.frozen = undefined;
		this.epochCounter = 0;
		this.pressure = { rawToolTextBytes: 0, rawBundles: 0, projectedToolTextBytes: 0, projectedBundles: 0 };
		return false;
	}

	serialize(): HistoryProjectionStateEntryData {
		const frozen = this.frozen;
		return {
			schemaVersion: HISTORY_PROJECTION_STATE_SCHEMA_VERSION,
			active: frozen ? 1 : 0,
			epoch: frozen?.epoch ?? this.epochCounter,
			epochHash: frozen?.epochHash ?? EMPTY_HISTORY_HASH,
			prefixMessageCount: frozen?.prefixMessageCount ?? 0,
			prefixHash: frozen?.prefixHash ?? EMPTY_HISTORY_HASH,
			projectedPrefixHash: frozen?.projectedPrefixHash ?? EMPTY_HISTORY_HASH,
			hardToolTextBytes: frozen?.hardToolTextBytes ?? 0,
			hardBundles: frozen?.hardBundles ?? 0,
			lowToolTextBytes: frozen?.lowToolTextBytes ?? 0,
			lowBundles: frozen?.lowBundles ?? 0,
			transitionCollapsedResults: frozen?.transitionCollapsedResults ?? 0,
			transitionRemovedBundles: frozen?.transitionRemovedBundles ?? 0,
			rawToolTextBytes: this.pressure.rawToolTextBytes,
			rawBundles: this.pressure.rawBundles,
			projectedToolTextBytes: this.pressure.projectedToolTextBytes,
			projectedBundles: this.pressure.projectedBundles,
		};
	}

	project(input: ProjectContextHistoryInput): HistoryProjectionControllerResult {
		let rawToolTextBytes = 0;
		let rawBundles = 0;
		let previousTransitionCollapsedResults = 0;
		let previousTransitionRemovedBundles = 0;
		try {
			rawToolTextBytes = historyToolTextBytes(input.messages);
			const analyzedBundles = historyBundleCount(input.messages);
			if (analyzedBundles === undefined) {
				this.frozen = undefined;
				const failure = projectContextHistory(input);
				return this.finish(failure, rawToolTextBytes, 0, true, failure.facts.collapsedResults, failure.facts.removedBundles);
			}
			rawBundles = analyzedBundles;
			const hardToolTextBytes = effectiveByteCap(input);
			const hardBundles = effectiveBundleCap(input.maxBundles);

			if (this.frozen) {
				const frozen = this.frozen;
				const compatible = frozen.hardToolTextBytes === hardToolTextBytes
					&& frozen.hardBundles === hardBundles
					&& input.messages.length >= frozen.prefixMessageCount;
				if (compatible) {
					const prefix = input.messages.slice(0, frozen.prefixMessageCount);
					const prefixHash = hashHistoryMessages(prefix);
					if (prefixHash === frozen.prefixHash) {
						const base = projectContextHistory({
							...input,
							messages: prefix,
							maxToolTextBytes: frozen.lowToolTextBytes,
							maxBundles: frozen.lowBundles,
						});
						if (hashHistoryMessages(base.messages) === frozen.projectedPrefixHash) {
							const combined = [...base.messages, ...input.messages.slice(frozen.prefixMessageCount)];
							const projectedBundles = historyBundleCount(combined);
							const projectedToolTextBytes = historyToolTextBytes(combined);
							if (projectedBundles !== undefined
								&& projectedToolTextBytes <= hardToolTextBytes
								&& projectedBundles <= hardBundles) {
								return this.finish({
									messages: combined,
									facts: {
										originalToolTextBytes: rawToolTextBytes,
										finalToolTextBytes: projectedToolTextBytes,
										collapsedResults: base.facts.collapsedResults,
										removedBundles: base.facts.removedBundles,
										protectedLatestBundles: base.facts.protectedLatestBundles,
									},
								}, rawToolTextBytes, rawBundles, false, 0, 0);
							}
							previousTransitionCollapsedResults = frozen.transitionCollapsedResults;
							previousTransitionRemovedBundles = frozen.transitionRemovedBundles;
						}
					}
				}
				// A branch, compacted prefix, changed policy, or implementation drift
				// invalidates the frozen boundary and starts a fresh epoch if needed.
				this.epochCounter = Math.max(this.epochCounter, frozen.epoch);
				this.frozen = undefined;
			}

			if (rawToolTextBytes <= hardToolTextBytes && rawBundles <= hardBundles) {
				return this.finish({
					messages: Array.from(input.messages),
					facts: {
						originalToolTextBytes: rawToolTextBytes,
						finalToolTextBytes: rawToolTextBytes,
						collapsedResults: 0,
						removedBundles: 0,
						protectedLatestBundles: rawBundles > 0 ? 1 : 0,
					},
				}, rawToolTextBytes, rawBundles, false, 0, 0);
			}

			const lowToolTextBytes = Math.floor(hardToolTextBytes * HISTORY_PROJECTION_LOW_WATERMARK_PERCENT / 100);
			const lowBundles = Math.min(hardBundles, HISTORY_PROJECTION_LOW_WATERMARK_BUNDLES);
			const projected = projectContextHistory({
				...input,
				maxToolTextBytes: lowToolTextBytes,
				maxBundles: lowBundles,
			});
			const projectedBundles = historyBundleCount(projected.messages);
			if (projectedBundles === undefined
				|| projected.facts.finalToolTextBytes > hardToolTextBytes
				|| projectedBundles > hardBundles) {
				this.frozen = undefined;
				const failure = projectContextHistory(input);
				return this.finish(failure, rawToolTextBytes, rawBundles, true, failure.facts.collapsedResults, failure.facts.removedBundles);
			}
			const prefixHash = hashHistoryMessages(input.messages);
			const projectedPrefixHash = hashHistoryMessages(projected.messages);
			const epoch = this.epochCounter + 1;
			const epochHash = createHash("sha256").update([
				"workbench-history-epoch-v1", String(epoch), prefixHash, projectedPrefixHash,
				String(hardToolTextBytes), String(hardBundles), String(lowToolTextBytes), String(lowBundles),
			].join("\n")).digest("hex");
			this.epochCounter = epoch;
			this.frozen = {
				epoch,
				epochHash,
				prefixMessageCount: input.messages.length,
				prefixHash,
				projectedPrefixHash,
				hardToolTextBytes,
				hardBundles,
				lowToolTextBytes,
				lowBundles,
				transitionCollapsedResults: projected.facts.collapsedResults,
				transitionRemovedBundles: projected.facts.removedBundles,
			};
			return this.finish(
				projected,
				rawToolTextBytes,
				rawBundles,
				true,
				Math.max(0, projected.facts.collapsedResults - previousTransitionCollapsedResults),
				Math.max(0, projected.facts.removedBundles - previousTransitionRemovedBundles),
			);
		} catch {
			this.frozen = undefined;
			const messages = safeHistoryProjectionFailureMessages();
			const failure = {
				messages,
				facts: {
					originalToolTextBytes: rawToolTextBytes,
					finalToolTextBytes: 0,
					collapsedResults: 0,
					removedBundles: 0,
					protectedLatestBundles: 0,
				},
			};
			return this.finish(failure, rawToolTextBytes, rawBundles, true, 0, 0);
		}
	}

	private finish(
		projection: ProjectContextHistoryResult,
		rawToolTextBytes: number,
		rawBundles: number,
		epochTransitioned: boolean,
		newlyCollapsedResults: number,
		newlyRemovedBundles: number,
	): HistoryProjectionControllerResult {
		const projectedBundles = historyBundleCount(projection.messages) ?? 0;
		this.pressure = {
			rawToolTextBytes: Math.max(0, rawToolTextBytes),
			rawBundles: Math.max(0, rawBundles),
			projectedToolTextBytes: Math.max(0, projection.facts.finalToolTextBytes),
			projectedBundles,
		};
		return {
			...projection,
			epoch: this.frozen?.epoch ?? this.epochCounter,
			epochHash: this.frozen?.epochHash ?? null,
			epochTransitioned,
			newlyCollapsedResults: Math.max(0, newlyCollapsedResults),
			newlyRemovedBundles: Math.max(0, newlyRemovedBundles),
			rawBundleCount: Math.max(0, rawBundles),
			projectedBundleCount: projectedBundles,
		};
	}
}
