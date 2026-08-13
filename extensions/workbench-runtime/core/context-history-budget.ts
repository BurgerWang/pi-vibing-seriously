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
		return [projectionFailureMessage()];
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
