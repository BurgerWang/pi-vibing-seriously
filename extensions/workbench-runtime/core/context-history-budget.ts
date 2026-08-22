import { createHash, type Hash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import {
	COMMANDER_HISTORY_MAX_BYTES,
	COMMANDER_TURN_MAX_BYTES,
	HISTORY_MAX_TOOL_BUNDLES,
	OTHER_HISTORY_MAX_BYTES,
	WORKER_HISTORY_MAX_BYTES,
	WORKER_TURN_MAX_BYTES,
} from "./output-policy.ts";

/** The message union Pi exposes to the extension `context` event. */
export type AgentMessage = ContextEvent["messages"][number];

export type HistoryProjectionRole = "commander" | "worker" | "other";

export const COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES = COMMANDER_HISTORY_MAX_BYTES;
export const WORKER_HISTORY_TOOL_TEXT_MAX_BYTES = WORKER_HISTORY_MAX_BYTES;
export const OTHER_HISTORY_TOOL_TEXT_MAX_BYTES = OTHER_HISTORY_MAX_BYTES;
export const HISTORY_MAX_BUNDLES = HISTORY_MAX_TOOL_BUNDLES;
export const HISTORY_DESCRIPTOR_MAX_BYTES = 384;
export const HISTORY_PROJECTION_MAX_SEGMENTS = 16;
export const HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES = 384;
export const HISTORY_PROJECTION_SEGMENT_MAX_BUNDLES = 1;
export const HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES = 16;
/** Highest persisted epoch; the remaining safe integer is reserved so advancement can never overflow. */
export const HISTORY_PROJECTION_MAX_EPOCH = Number.MAX_SAFE_INTEGER - 1;
export const HISTORY_PROJECTION_ENTRY_TYPE = "workbench-history-projection-state-v3";
export const LEGACY_HISTORY_PROJECTION_V2_ENTRY_TYPE = "workbench-history-projection-state-v2";
export const LEGACY_HISTORY_PROJECTION_ENTRY_TYPE = "workbench-history-projection-state-v1";
export const HISTORY_PROJECTION_LOW_WATERMARK_BUNDLES = HISTORY_MAX_BUNDLES
	- HISTORY_PROJECTION_MAX_SEGMENTS
	- HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES;

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

/** Stable, content-free event vocabulary mapped to telemetry event codes by index.ts. */
export const HISTORY_PROJECTION_EVENT_KINDS = Object.freeze([
	"none",
	"initial_hard_projection",
	"segment_seal",
	"epoch_checkpoint",
	"inactive_boundary",
	"fixed_failure",
	"recovery_boundary",
] as const);
export type HistoryProjectionEventKind = typeof HISTORY_PROJECTION_EVENT_KINDS[number];

/** Stable, content-free cause vocabulary mapped to telemetry cause codes by index.ts. */
export const HISTORY_PROJECTION_OBSERVATION_CAUSES = Object.freeze([
	"none",
	"initial_hard_limit",
	"hard_bytes",
	"hard_bundles",
	"segment_sealed",
	"prefix_changed",
	"policy_changed",
	"legacy_migration",
	"failure",
	"recovery",
] as const);
export type HistoryProjectionObservationCause = typeof HISTORY_PROJECTION_OBSERVATION_CAUSES[number];

/**
 * Exact numeric anatomy of one projection decision. This surface contains no
 * message text, marker text, hashes, paths, provider claims, or estimates.
 * Slice-only fields are zero when that slice is structurally inapplicable.
 */
export interface HistoryProjectionObservability {
	eventKind: HistoryProjectionEventKind;
	transitionCause: HistoryProjectionObservationCause;
	epoch: number;
	epochTransitioned: 0 | 1;
	segmentSealed: 0 | 1;
	byteOverflow: 0 | 1;
	bundleOverflow: 0 | 1;
	segmentsBefore: number;
	segmentsAfter: number;
	hardToolTextBytes: number;
	hardBundles: number;
	rawToolTextBytes: number;
	rawBundles: number;
	projectedToolTextBytes: number;
	projectedBundles: number;
	stableToolTextBytesBefore: number;
	stableBundlesBefore: number;
	activeToolTextBytesBefore: number;
	activeBundlesBefore: number;
	agedRawToolTextBytes: number;
	agedRawBundles: number;
	agedProjectedToolTextBytes: number;
	agedProjectedBundles: number;
	suffixRawToolTextBytes: number;
	suffixRawBundles: number;
}

export interface HistoryProjectionControllerResult extends ProjectContextHistoryResult {
	epoch: number;
	epochHash: string | null;
	epochTransitioned: boolean;
	segmentSealed: boolean;
	segmentChainHash: string | null;
	boundaryMarkers: readonly HistoryProjectionBoundaryMarker[];
	transitionCause: HistoryProjectionTransitionCause;
	newlyCollapsedResults: number;
	newlyRemovedBundles: number;
	rawBundleCount: number;
	projectedBundleCount: number;
	observability: HistoryProjectionObservability;
}

export interface HistoryProjectionBoundaryMarker {
	boundaryId: string;
	marker: string;
}

export type HistoryProjectionTransitionCause =
	| "none"
	| "initial_hard_limit"
	| "hard_bytes"
	| "hard_bundles"
	| "segment_sealed"
	| "prefix_changed"
	| "policy_changed"
	| "legacy_migration"
	| "failure";

export interface FrozenHistoryProjectionSlice {
	rawStartMessageCount: number;
	rawEndMessageCount: number;
	rawHash: string;
	projectedMessageCount: number;
	projectedHash: string;
	projectedToolTextBytes: number;
	projectedBundles: number;
	boundaryId: string;
	collapsedResults: number;
	removedBundles: number;
}

export interface HistoryProjectionStateEntryData {
	schemaVersion: 3;
	active: 0 | 1;
	epoch: number;
	epochHash: string;
	segmentChainHash: string;
	stateHash: string;
	hardToolTextBytes: number;
	hardBundles: number;
	descriptorMaxBytes: number;
	anchorToolTextBytes: number;
	anchorBundles: number;
	anchor: FrozenHistoryProjectionSlice;
	segments: FrozenHistoryProjectionSlice[];
	activeRawStartMessageCount: number;
	observedRawMessageCount: number;
	observedRawHash: string;
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
const INGRESS_METADATA_SCHEMA = "workbench-tool-result-ingress-metadata-v1";
const INGRESS_METADATA_BUDGET_BYTES = 4_096;
const INGRESS_METADATA_FIELDS = [
	"schema", "sourceKind", "sourcePath", "sourceIdentityKind", "sourceIdentityHash",
	"authorityHash", "projectionHash", "originalBytes", "projectedBytes", "bodyShownBytes",
	"omittedBytes", "budgetBytes", "requiredFactCount",
] as const;
const INGRESS_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_INGRESS_PATH_PATTERN = /^[A-Za-z0-9._/+-]+$/;
const SAFE_INGRESS_RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/;
const INGRESS_COMPARISON_ID_PATTERN = /^cmp1-[0-9a-f]{64}$/;
const INGRESS_SOURCE_CONTRACTS = Object.freeze({
	finalized_recipe_run: Object.freeze({ toolName: "workbench_run_recipe", requiredFactCount: 5 }),
	executed_gate_run: Object.freeze({ toolName: "workbench_run_gate", requiredFactCount: 3 }),
	immutable_comparison: Object.freeze({ toolName: "workbench_compare_runs", requiredFactCount: 4 }),
	completed_worker_report: Object.freeze({ toolName: "workbench_delegate_worker", requiredFactCount: 4 }),
	finalized_run_page: Object.freeze({ toolName: "workbench_read_run", requiredFactCount: 4 }),
	run_id_gate_page: Object.freeze({ toolName: "workbench_read_gate", requiredFactCount: 3 }),
});
type IngressSourceKind = keyof typeof INGRESS_SOURCE_CONTRACTS;
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

function interruptedToolBatchMessage(input: {
	batches: number;
	results: number;
	omittedBytes: number;
	timestamp: number;
}): AgentMessage {
	return {
		role: "custom",
		customType: "workbench-history-interrupted-tool-batch",
		content: [
			"[workbench interrupted tool batch]",
			"A previous tool batch ended without all results and was omitted after a later user turn proved it abandoned.",
			"Treat that batch as non-authoritative. Follow the latest complete persisted status or re-query durable state now; do not wait for another user confirmation.",
		].join("\n"),
		display: false,
		details: {
			interrupted_batches: Math.max(0, Math.floor(input.batches)),
			removed_results: Math.max(0, Math.floor(input.results)),
			omitted_tool_text_bytes: Math.max(0, Math.floor(input.omittedBytes)),
		},
		timestamp: input.timestamp,
	} as AgentMessage;
}

/**
 * Repair only a provably abandoned tool batch: one whose missing results are
 * followed by a later user message. This is the durable shape left when Pi is
 * interrupted or the machine loses power during a tool call. Orphan results,
 * mismatched names/ids, duplicates, and an incomplete current tail remain
 * unsafe and are deliberately left for the fixed fail-closed boundary.
 */
function repairInterruptedToolHistory(messages: readonly AgentMessage[]): AgentMessage[] | undefined {
	const output: AgentMessage[] = [];
	const seenCalls = new Set<string>();
	const seenResults = new Set<string>();
	let interruptedBatches = 0;

	for (let index = 0; index < messages.length;) {
		const message = messages[index];
		if (!message) return undefined;
		const role = roleOf(message);
		if (role === "toolResult") return undefined;
		if (role !== "assistant") {
			output.push(message);
			index += 1;
			continue;
		}

		const calls = extractToolCalls(message);
		if (!calls) return undefined;
		if (calls.length === 0) {
			output.push(message);
			index += 1;
			continue;
		}

		const expected = new Map<string, string>();
		for (const call of calls) {
			if (seenCalls.has(call.id)) return undefined;
			seenCalls.add(call.id);
			expected.set(call.id, call.name);
		}

		const results: AgentMessage[] = [];
		let cursor = index + 1;
		while (cursor < messages.length && roleOf(messages[cursor]!) === "toolResult") {
			const resultMessage = messages[cursor]!;
			const result = extractToolResultIdentity(resultMessage);
			if (!result || seenResults.has(result.id)) return undefined;
			const expectedName = expected.get(result.id);
			if (expectedName === undefined || expectedName !== result.name) return undefined;
			seenResults.add(result.id);
			expected.delete(result.id);
			results.push(resultMessage);
			cursor += 1;
		}

		if (expected.size === 0 && results.length === calls.length) {
			output.push(message, ...results);
			index = cursor;
			continue;
		}

		let boundary = cursor;
		while (boundary < messages.length) {
			const boundaryRole = roleOf(messages[boundary]!);
			if (boundaryRole === "user") break;
			if (boundaryRole === "assistant" || boundaryRole === "toolResult") return undefined;
			boundary += 1;
		}
		if (boundary >= messages.length || roleOf(messages[boundary]!) !== "user") return undefined;

		const stripped = stripToolCalls(message);
		if (stripped) output.push(stripped);
		interruptedBatches += 1;
		const removedBytes = results.reduce((sum, result) => sum + toolResultTextBytes(result), 0);
		output.push(interruptedToolBatchMessage({
			batches: 1,
			results: results.length,
			omittedBytes: removedBytes,
			timestamp: timestampOf(messages[boundary]),
		}));
		index = cursor;
	}

	if (interruptedBatches === 0) return undefined;
	return output;
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

function exactIngressMetadataRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
	if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== INGRESS_METADATA_FIELDS.length || keys.some((key) => typeof key !== "string")) return undefined;
	const expected = new Set<string>(INGRESS_METADATA_FIELDS);
	const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const key of keys) {
		if (typeof key !== "string" || !expected.has(key)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
			return undefined;
		}
		record[key] = descriptor.value;
	}
	return record;
}

function safeIngressInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function ingressSourcePathMatches(sourceKind: IngressSourceKind, sourcePath: unknown): sourcePath is string {
	if (typeof sourcePath !== "string"
		|| utf8Bytes(sourcePath) > HISTORY_DESCRIPTOR_MAX_BYTES
		|| !SAFE_INGRESS_PATH_PATTERN.test(sourcePath)
		|| sourcePath.startsWith("/")
		|| sourcePath.includes("\\")) return false;
	const parts = sourcePath.split("/");
	if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return false;
	if (sourceKind === "immutable_comparison") {
		return parts.length === 5
			&& parts[0] === ".pi"
			&& parts[1] === "workbench"
			&& parts[2] === "comparisons"
			&& INGRESS_COMPARISON_ID_PATTERN.test(parts[3] ?? "")
			&& parts[4] === "comparison.json";
	}
	if (sourceKind === "completed_worker_report") {
		return parts.length === 5
			&& parts[0] === ".pi"
			&& parts[1] === "workbench"
			&& parts[2] === "delegations"
			&& SAFE_INGRESS_RECORD_ID_PATTERN.test(parts[3] ?? "")
			&& parts[4] === "worker-report.md";
	}
	if (parts.length !== 5
		|| parts[0] !== ".pi"
		|| parts[1] !== "workbench"
		|| parts[2] !== "runs"
		|| !SAFE_INGRESS_RECORD_ID_PATTERN.test(parts[3] ?? "")) return false;
	if (sourceKind === "finalized_recipe_run") return parts[4] === "summary.json";
	if (sourceKind === "executed_gate_run" || sourceKind === "run_id_gate_page") return parts[4] === "gates.json";
	return sourceKind === "finalized_run_page"
		&& (parts[4] === "manifest.json" || parts[4] === "stdout.log" || parts[4] === "stderr.log");
}

function ingressPointerFromDetails(details: object, toolName: string): string | undefined {
	const ingressDescriptor = Object.getOwnPropertyDescriptor(details, "ingress_projection");
	if (!ingressDescriptor
		|| ingressDescriptor.enumerable !== true
		|| !Object.prototype.hasOwnProperty.call(ingressDescriptor, "value")) return undefined;
	const metadata = exactIngressMetadataRecord(ingressDescriptor.value);
	if (!metadata
		|| metadata.schema !== INGRESS_METADATA_SCHEMA
		|| typeof metadata.sourceKind !== "string"
		|| !Object.prototype.hasOwnProperty.call(INGRESS_SOURCE_CONTRACTS, metadata.sourceKind)) return undefined;
	const sourceKind = metadata.sourceKind as IngressSourceKind;
	const contract = INGRESS_SOURCE_CONTRACTS[sourceKind];
	if (contract.toolName !== toolName
		|| !ingressSourcePathMatches(sourceKind, metadata.sourcePath)
		|| (metadata.sourceIdentityKind !== "digest" && metadata.sourceIdentityKind !== "snapshot")
		|| typeof metadata.sourceIdentityHash !== "string" || !INGRESS_SHA256_PATTERN.test(metadata.sourceIdentityHash)
		|| typeof metadata.authorityHash !== "string" || !INGRESS_SHA256_PATTERN.test(metadata.authorityHash)
		|| typeof metadata.projectionHash !== "string" || !INGRESS_SHA256_PATTERN.test(metadata.projectionHash)
		|| !safeIngressInteger(metadata.originalBytes)
		|| !safeIngressInteger(metadata.projectedBytes)
		|| metadata.projectedBytes > INGRESS_METADATA_BUDGET_BYTES
		|| !safeIngressInteger(metadata.bodyShownBytes)
		|| metadata.bodyShownBytes > metadata.originalBytes
		|| !safeIngressInteger(metadata.omittedBytes)
		|| metadata.omittedBytes !== metadata.originalBytes - metadata.bodyShownBytes
		|| metadata.budgetBytes !== INGRESS_METADATA_BUDGET_BYTES
		|| metadata.requiredFactCount !== contract.requiredFactCount) return undefined;
	return metadata.sourcePath;
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
	const ingressSource = ingressPointerFromDetails(details, toolName);
	if (ingressSource) return { key: "source", value: ingressSource };

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
	return role === "commander"
		? COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES
		: role === "worker"
			? WORKER_HISTORY_TOOL_TEXT_MAX_BYTES
			: OTHER_HISTORY_TOOL_TEXT_MAX_BYTES;
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
	maxToolTextBytes: number = OTHER_HISTORY_TOOL_TEXT_MAX_BYTES,
	descriptorMaxBytes: number = HISTORY_DESCRIPTOR_MAX_BYTES,
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

const HISTORY_PROJECTION_STATE_SCHEMA_VERSION = 3 as const;
const LEGACY_HISTORY_PROJECTION_V2_STATE_SCHEMA_VERSION = 2 as const;
const LEGACY_HISTORY_PROJECTION_STATE_SCHEMA_VERSION = 1 as const;
const EMPTY_HISTORY_HASH = "0".repeat(64);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FAILURE_BOUNDARY_HASH = createHash("sha256")
	.update("workbench-history-projection-boundary-v1\nfailure")
	.digest("hex");
const RECOVERY_BOUNDARY_HASH = createHash("sha256")
	.update("workbench-history-projection-boundary-v1\nrecovery")
	.digest("hex");
const TOP_LEVEL_MESSAGE_METADATA = new Set(["timestamp", "details", "usage", "diagnostics"]);
const HISTORY_PROJECTION_STATE_KEYS = Object.freeze([
	"active", "activeRawStartMessageCount", "anchor", "anchorBundles", "anchorToolTextBytes", "descriptorMaxBytes",
	"epoch", "epochHash", "hardBundles", "hardToolTextBytes", "observedRawHash", "observedRawMessageCount",
	"projectedBundles", "projectedToolTextBytes", "rawBundles", "rawToolTextBytes", "schemaVersion",
	"segmentChainHash", "segments", "stateHash", "transitionCollapsedResults", "transitionRemovedBundles",
].sort());
const HISTORY_PROJECTION_SLICE_KEYS = Object.freeze([
	"boundaryId", "collapsedResults", "projectedBundles", "projectedHash", "projectedMessageCount",
	"projectedToolTextBytes", "rawEndMessageCount", "rawHash", "rawStartMessageCount", "removedBundles",
].sort());
const LEGACY_V2_HISTORY_PROJECTION_STATE_KEYS = Object.freeze([
	"active", "anchorBundles", "anchorProjectedBundles", "anchorProjectedHash", "anchorProjectedMessageCount",
	"anchorProjectedToolTextBytes", "anchorRawHash", "anchorRawMessageCount", "anchorToolTextBytes", "epoch",
	"epochHash", "descriptorMaxBytes", "hardBundles", "hardToolTextBytes", "observedRawHash", "observedRawMessageCount",
	"projectedBundles", "projectedToolTextBytes", "rawBundles", "rawToolTextBytes", "schemaVersion",
	"sealedTailBundles", "sealedTailProjectedBundles", "sealedTailProjectedHash",
	"sealedTailProjectedMessageCount", "sealedTailProjectedToolTextBytes", "sealedTailRawHash",
	"sealedTailRawMessageCount", "sealedTailToolTextBytes", "transitionCollapsedResults", "transitionRemovedBundles",
].sort());
const LEGACY_HISTORY_PROJECTION_STATE_KEYS = Object.freeze([
	"active", "epoch", "epochHash", "hardBundles", "hardToolTextBytes", "lowBundles", "lowToolTextBytes",
	"prefixHash", "prefixMessageCount", "projectedBundles", "projectedPrefixHash", "projectedToolTextBytes",
	"rawBundles", "rawToolTextBytes", "schemaVersion", "transitionCollapsedResults", "transitionRemovedBundles",
].sort());
const HISTORY_PROJECTION_RESTORE_MAX_ENTRIES = 262_144;

type FrozenHistoryProjectionEpoch = Omit<HistoryProjectionStateEntryData,
	"schemaVersion" | "active" | "stateHash" | "rawToolTextBytes" | "rawBundles" | "projectedToolTextBytes" | "projectedBundles">;

interface LegacyV2HistoryProjectionStateEntryData {
	schemaVersion: 2;
	active: 0 | 1;
	epoch: number;
	epochHash: string;
	hardToolTextBytes: number;
	hardBundles: number;
	descriptorMaxBytes: number;
	anchorToolTextBytes: number;
	anchorBundles: number;
	anchorRawMessageCount: number;
	anchorRawHash: string;
	anchorProjectedHash: string;
	anchorProjectedMessageCount: number;
	anchorProjectedToolTextBytes: number;
	anchorProjectedBundles: number;
	sealedTailRawMessageCount: number;
	sealedTailRawHash: string;
	sealedTailToolTextBytes: number;
	sealedTailBundles: number;
	sealedTailProjectedHash: string;
	sealedTailProjectedMessageCount: number;
	sealedTailProjectedToolTextBytes: number;
	sealedTailProjectedBundles: number;
	observedRawMessageCount: number;
	observedRawHash: string;
	transitionCollapsedResults: number;
	transitionRemovedBundles: number;
	rawToolTextBytes: number;
	rawBundles: number;
	projectedToolTextBytes: number;
	projectedBundles: number;
}

interface LegacyHistoryProjectionStateEntryData {
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

interface HistoryPressureFacts {
	rawToolTextBytes: number;
	rawBundles: number;
	projectedToolTextBytes: number;
	projectedBundles: number;
}

interface HistoryProjectionObservationSeed {
	eventKind: Exclude<HistoryProjectionEventKind, "recovery_boundary">;
	transitionCause: Exclude<HistoryProjectionObservationCause, "recovery">;
	hardToolTextBytes: number;
	hardBundles: number;
	byteOverflow: boolean;
	bundleOverflow: boolean;
	segmentsBefore: number;
	stableToolTextBytesBefore: number;
	stableBundlesBefore: number;
	activeToolTextBytesBefore: number;
	activeBundlesBefore: number;
	agedRawToolTextBytes: number;
	agedRawBundles: number;
	agedProjectedToolTextBytes: number;
	agedProjectedBundles: number;
	suffixRawToolTextBytes: number;
	suffixRawBundles: number;
}

type HistoryProjectionDecisionFacts = Pick<HistoryProjectionObservationSeed,
	| "hardToolTextBytes"
	| "hardBundles"
	| "byteOverflow"
	| "bundleOverflow"
	| "segmentsBefore"
	| "stableToolTextBytesBefore"
	| "stableBundlesBefore"
	| "activeToolTextBytesBefore"
	| "activeBundlesBefore"
>;

interface ReplayProjection {
	anchor: ProjectContextHistoryResult;
	segments: ProjectContextHistoryResult[];
	active: AgentMessage[];
	messages: AgentMessage[];
	projectedToolTextBytes: number;
	projectedBundles: number;
}

type ReplayResult =
	| { status: "ok"; replay: ReplayProjection }
	| { status: "policy_changed" }
	| { status: "prefix_changed" };

function safeNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function advanceHistoryProjectionEpoch(currentEpoch: number): number | undefined {
	if (!Number.isSafeInteger(currentEpoch) || currentEpoch < 0 || currentEpoch >= HISTORY_PROJECTION_MAX_EPOCH) {
		return undefined;
	}
	return currentEpoch + 1;
}

function inactiveHistoryProjectionBoundaryHash(input: {
	epoch: number;
	previousEpochHash: string;
	cause: "prefix_changed" | "policy_changed" | "legacy_migration";
	rawHash: string;
	hardToolTextBytes: number;
	hardBundles: number;
	descriptorMaxBytes: number;
	role: ProjectContextHistoryInput["role"];
}): string {
	return createHash("sha256").update([
		"workbench-history-inactive-boundary-v3",
		String(input.epoch),
		input.previousEpochHash,
		input.cause,
		input.rawHash,
		String(input.hardToolTextBytes),
		String(input.hardBundles),
		String(input.descriptorMaxBytes),
		input.role === "commander" ? "commander" : "worker",
	].join("\n")).digest("hex");
}

const CANONICAL_STRING_CHUNK_CODE_UNITS = 4_096;
const CANONICAL_HISTORY_MAX_ARRAY_LENGTH = 32_768;
const CANONICAL_HISTORY_MAX_OWN_PROPERTIES = CANONICAL_HISTORY_MAX_ARRAY_LENGTH + 1;
const CANONICAL_HISTORY_MAX_DEPTH = 128;
const CANONICAL_HISTORY_MAX_WORK_UNITS = 262_144;

interface CanonicalHistoryHashBudget {
	remainingWorkUnits: number;
}

function consumeCanonicalHistoryWork(budget: CanonicalHistoryHashBudget, units = 1): void {
	if (!Number.isSafeInteger(units) || units < 0 || units > budget.remainingWorkUnits) {
		throw new Error("canonical history work budget exceeded");
	}
	budget.remainingWorkUnits -= units;
}

function boundedCanonicalArrayLength(value: object): number {
	const descriptor = Object.getOwnPropertyDescriptor(value, "length");
	if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")
		|| typeof descriptor.value !== "number" || !Number.isSafeInteger(descriptor.value)
		|| descriptor.value < 0 || descriptor.value > CANONICAL_HISTORY_MAX_ARRAY_LENGTH) {
		throw new Error("canonical history array length exceeds limit");
	}
	return descriptor.value;
}

/**
 * Frame a JavaScript string by its exact UTF-16 code units. Node's default
 * UTF-8 string hashing replaces lone surrogates with U+FFFD, which would make
 * two different provider-visible histories share an identity. The fixed-size
 * binary chunk keeps allocation bounded independently of the input length.
 */
function updateCanonicalHashString(hash: Hash, tag: string, value: string): void {
	hash.update("js-utf16be-code-units-v1;");
	hash.update(String(tag.length));
	hash.update(":");
	hash.update(tag);
	hash.update(";");
	hash.update(String(value.length));
	hash.update(":");
	if (value.length > 0) {
		const chunk = Buffer.allocUnsafe(Math.min(value.length, CANONICAL_STRING_CHUNK_CODE_UNITS) * 2);
		for (let start = 0; start < value.length; start += CANONICAL_STRING_CHUNK_CODE_UNITS) {
			const codeUnits = Math.min(CANONICAL_STRING_CHUNK_CODE_UNITS, value.length - start);
			for (let offset = 0; offset < codeUnits; offset += 1) {
				chunk.writeUInt16BE(value.charCodeAt(start + offset), offset * 2);
			}
			hash.update(chunk.subarray(0, codeUnits * 2));
		}
	}
	hash.update(";");
}

function dataDescriptors(value: object, budget: CanonicalHistoryHashBudget): PropertyDescriptorMap {
	if (utilTypes.isProxy(value)) throw new Error("proxy history value is not hashable");
	const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
	const keys = Reflect.ownKeys(descriptors);
	if (keys.length > CANONICAL_HISTORY_MAX_OWN_PROPERTIES) {
		throw new Error("canonical history property count exceeds limit");
	}
	consumeCanonicalHistoryWork(budget, keys.length);
	for (const key of keys) {
		const descriptor = Reflect.getOwnPropertyDescriptor(descriptors, key)?.value as PropertyDescriptor | undefined;
		if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
			throw new Error("history accessor is not hashable");
		}
	}
	if (Object.prototype.hasOwnProperty.call(descriptors, "toJSON")) {
		throw new Error("custom history toJSON is not permitted");
	}
	return descriptors;
}

function canonicalArrayIndexInRange(key: string, length: number): boolean {
	if (key === "0") return length > 0;
	if (key.length < 1 || key.length > 5) return false;
	const first = key.charCodeAt(0);
	if (first < 0x31 || first > 0x39) return false;
	let index = first - 0x30;
	for (let offset = 1; offset < key.length; offset += 1) {
		const unit = key.charCodeAt(offset);
		if (unit < 0x30 || unit > 0x39) return false;
		index = index * 10 + unit - 0x30;
	}
	return index < length;
}

function validateCanonicalArrayDescriptors(
	descriptors: PropertyDescriptorMap,
	length: number,
	budget: CanonicalHistoryHashBudget,
): void {
	const keys = Reflect.ownKeys(descriptors);
	consumeCanonicalHistoryWork(budget, keys.length);
	for (const key of keys) {
		if (typeof key !== "string" || (key !== "length" && !canonicalArrayIndexInRange(key, length))) {
			throw new Error("canonical history array has an unsupported own key");
		}
	}
}

function jsonObjectOmits(value: unknown): boolean {
	return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/**
 * Canonicalize exactly the JSONL/provider-relevant data boundary without
 * invoking application code. Object undefined keys are omitted like
 * JSON.stringify; array holes/undefined become null. Only direct message
 * metadata is ignored — identically named nested tool arguments remain part
 * of the digest. Proxies, accessors, toJSON, cycles and non-plain objects are
 * rejected before any user trap can run.
 */
function updateCanonicalHistoryHash(
	hash: Hash,
	value: unknown,
	active: WeakSet<object>,
	budget: CanonicalHistoryHashBudget,
	topLevelMessage = false,
	depth = 0,
): void {
	if (depth > CANONICAL_HISTORY_MAX_DEPTH) throw new Error("canonical history nesting exceeds limit");
	consumeCanonicalHistoryWork(budget);
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
			if (!Number.isFinite(value)) {
				hash.update("null;");
				return;
			}
			updateCanonicalHashString(hash, "n", Object.is(value, -0) ? "0" : String(value));
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
	const length = isArray ? boundedCanonicalArrayLength(value) : undefined;
	const descriptors = dataDescriptors(value, budget);
	if (isArray) validateCanonicalArrayDescriptors(descriptors, length!, budget);
	active.add(value);
	try {
		if (isArray) {
			consumeCanonicalHistoryWork(budget, length!);
			updateCanonicalHashString(hash, "a", String(length));
			for (let index = 0; index < length!; index += 1) {
				updateCanonicalHashString(hash, "i", String(index));
				const descriptor = descriptors[String(index)];
				const item = descriptor?.value;
				if (!descriptor || jsonObjectOmits(item)) hash.update("null;");
				else updateCanonicalHistoryHash(hash, item, active, budget, false, depth + 1);
			}
			hash.update("];");
			return;
		}

		hash.update("o;");
		// Object.entries follows JSON's property order: array-index keys first
		// in ascending order, followed by other string keys in insertion order.
		const entries = Object.entries(descriptors)
			.filter(([key, descriptor]) => (
				descriptor.enumerable === true
					&& !(topLevelMessage && TOP_LEVEL_MESSAGE_METADATA.has(key))
					&& !jsonObjectOmits(descriptor.value)
			));
		for (const [key, descriptor] of entries) {
			updateCanonicalHashString(hash, "k", key);
			updateCanonicalHistoryHash(hash, descriptor.value, active, budget, false, depth + 1);
		}
		hash.update("};");
	} finally {
		active.delete(value);
	}
}

function hashHistoryMessages(messages: readonly AgentMessage[]): string {
	if (utilTypes.isProxy(messages) || !Array.isArray(messages)) throw new Error("history messages must be a plain array");
	if (Object.getPrototypeOf(messages) !== Array.prototype) throw new Error("history messages must use Array.prototype");
	const length = boundedCanonicalArrayLength(messages);
	const budget: CanonicalHistoryHashBudget = { remainingWorkUnits: CANONICAL_HISTORY_MAX_WORK_UNITS };
	consumeCanonicalHistoryWork(budget, 1 + length);
	const descriptors = dataDescriptors(messages, budget);
	validateCanonicalArrayDescriptors(descriptors, length, budget);
	const hash = createHash("sha256");
	hash.update("workbench-history-canonical-v3;");
	updateCanonicalHashString(hash, "a", String(length));
	const active = new WeakSet<object>();
	for (let index = 0; index < length; index += 1) {
		updateCanonicalHashString(hash, "i", String(index));
		const descriptor = descriptors[String(index)];
		const item = descriptor?.value;
		if (!descriptor || jsonObjectOmits(item)) hash.update("null;");
		else updateCanonicalHistoryHash(hash, item, active, budget, true, 1);
	}
	hash.update("];");
	return hash.digest("hex");
}

function historyBundleCount(messages: readonly AgentMessage[]): number | undefined {
	const analysis = analyzeContextHistory(messages);
	return analysis.valid ? analysis.bundles.length : undefined;
}

function strictPlainRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Object.keys(descriptors).sort();
	if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return undefined;
	if (Object.values(descriptors).some((descriptor) => (
		descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")
	))) return undefined;
	return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function validRestoredAnchorCap(hardToolTextBytes: number, anchorToolTextBytes: number): boolean {
	if (hardToolTextBytes < 1 || hardToolTextBytes > COMMANDER_HISTORY_MAX_BYTES) return false;
	// Role is deliberately absent from persisted state. Accept either role's
	// exact downward-only derivation when its hard ceiling permits that value;
	// e.g. 64 KiB can be worker production or Commander explicitly lowered.
	const commanderCandidate = Math.max(0, hardToolTextBytes - COMMANDER_TURN_MAX_BYTES);
	const workerCandidate = hardToolTextBytes <= WORKER_HISTORY_MAX_BYTES
		? Math.max(0, hardToolTextBytes - WORKER_TURN_MAX_BYTES)
		: undefined;
	return anchorToolTextBytes === commanderCandidate || anchorToolTextBytes === workerCandidate;
}

function legacyV2EpochHashFor(state: LegacyV2HistoryProjectionStateEntryData): string {
	return createHash("sha256").update([
		"workbench-history-epoch-v2",
		String(state.epoch),
		String(state.hardToolTextBytes),
		String(state.hardBundles),
		String(state.descriptorMaxBytes),
		String(state.anchorToolTextBytes),
		String(state.anchorBundles),
		String(state.anchorRawMessageCount),
		state.anchorRawHash,
		String(state.anchorProjectedMessageCount),
		state.anchorProjectedHash,
		String(state.anchorProjectedToolTextBytes),
		String(state.anchorProjectedBundles),
		String(state.sealedTailRawMessageCount),
		state.sealedTailRawHash,
		String(state.sealedTailToolTextBytes),
		String(state.sealedTailBundles),
		String(state.sealedTailProjectedMessageCount),
		state.sealedTailProjectedHash,
		String(state.sealedTailProjectedToolTextBytes),
		String(state.sealedTailProjectedBundles),
	].join("\n")).digest("hex");
}

function strictLegacyProjectionStateV2(value: unknown): LegacyV2HistoryProjectionStateEntryData | undefined {
	try {
		const record = strictPlainRecord(value, LEGACY_V2_HISTORY_PROJECTION_STATE_KEYS);
		if (!record || record.schemaVersion !== LEGACY_HISTORY_PROJECTION_V2_STATE_SCHEMA_VERSION) return undefined;
		if (record.active !== 0 && record.active !== 1) return undefined;
		const integerKeys = LEGACY_V2_HISTORY_PROJECTION_STATE_KEYS.filter((key) => (
			key !== "epochHash" && key !== "anchorRawHash" && key !== "anchorProjectedHash"
			&& key !== "sealedTailRawHash" && key !== "sealedTailProjectedHash" && key !== "observedRawHash"
		));
		for (const key of integerKeys) {
			if (safeNonNegativeInteger(record[key]) === undefined) return undefined;
		}
		if ((record.epoch as number) > HISTORY_PROJECTION_MAX_EPOCH) return undefined;
		for (const key of [
			"epochHash", "anchorRawHash", "anchorProjectedHash", "sealedTailRawHash", "sealedTailProjectedHash", "observedRawHash",
		]) {
			if (typeof record[key] !== "string" || !SHA256_PATTERN.test(record[key] as string)) return undefined;
		}
		if (record.active === 0) {
			for (const key of [
				"hardToolTextBytes", "hardBundles", "descriptorMaxBytes", "anchorToolTextBytes", "anchorBundles", "anchorRawMessageCount",
				"anchorProjectedMessageCount", "anchorProjectedToolTextBytes", "anchorProjectedBundles",
				"sealedTailRawMessageCount", "sealedTailToolTextBytes", "sealedTailBundles",
				"sealedTailProjectedMessageCount", "sealedTailProjectedToolTextBytes", "sealedTailProjectedBundles",
				"observedRawMessageCount", "transitionCollapsedResults", "transitionRemovedBundles",
			]) if (record[key] !== 0) return undefined;
			for (const key of [
				"epochHash", "anchorRawHash", "anchorProjectedHash", "sealedTailRawHash", "sealedTailProjectedHash", "observedRawHash",
			]) {
				if (record[key] !== EMPTY_HISTORY_HASH) return undefined;
			}
			return record as unknown as LegacyV2HistoryProjectionStateEntryData;
		}

		const epoch = record.epoch as number;
		const hardToolTextBytes = record.hardToolTextBytes as number;
		const hardBundles = record.hardBundles as number;
		const descriptorMaxBytes = record.descriptorMaxBytes as number;
		const anchorToolTextBytes = record.anchorToolTextBytes as number;
		const anchorBundles = record.anchorBundles as number;
		const anchorRawMessageCount = record.anchorRawMessageCount as number;
		const anchorProjectedMessageCount = record.anchorProjectedMessageCount as number;
		const anchorProjectedToolTextBytes = record.anchorProjectedToolTextBytes as number;
		const anchorProjectedBundles = record.anchorProjectedBundles as number;
		const sealedTailRawMessageCount = record.sealedTailRawMessageCount as number;
		const sealedTailProjectedMessageCount = record.sealedTailProjectedMessageCount as number;
		const sealedTailProjectedToolTextBytes = record.sealedTailProjectedToolTextBytes as number;
		const sealedTailProjectedBundles = record.sealedTailProjectedBundles as number;
		const observedRawMessageCount = record.observedRawMessageCount as number;
		const rawToolTextBytes = record.rawToolTextBytes as number;
		const rawBundles = record.rawBundles as number;
		const projectedToolTextBytes = record.projectedToolTextBytes as number;
		const projectedBundles = record.projectedBundles as number;
		const transitionCollapsedResults = record.transitionCollapsedResults as number;
		const transitionRemovedBundles = record.transitionRemovedBundles as number;
		if (epoch < 1 || !validRestoredAnchorCap(hardToolTextBytes, anchorToolTextBytes)) return undefined;
		if (hardBundles < 1 || hardBundles > HISTORY_MAX_TOOL_BUNDLES) return undefined;
		if (descriptorMaxBytes > HISTORY_DESCRIPTOR_MAX_BYTES) return undefined;
		if (anchorBundles !== Math.min(hardBundles, HISTORY_PROJECTION_LOW_WATERMARK_BUNDLES)) return undefined;
		if ((record.anchorProjectedToolTextBytes as number) > (record.anchorToolTextBytes as number)) return undefined;
		if (anchorProjectedBundles > anchorBundles || anchorProjectedBundles > anchorProjectedMessageCount) return undefined;
		if (sealedTailRawMessageCount < anchorRawMessageCount || observedRawMessageCount < sealedTailRawMessageCount) return undefined;
		if ((record.sealedTailToolTextBytes as number) !== Math.max(0, anchorToolTextBytes - anchorProjectedToolTextBytes)) return undefined;
		const expectedTailBundles = Math.max(1, Math.min(hardBundles, anchorBundles - anchorProjectedBundles));
		if ((record.sealedTailBundles as number) !== expectedTailBundles) return undefined;
		if ((record.sealedTailProjectedToolTextBytes as number) > (record.sealedTailToolTextBytes as number)) return undefined;
		if (sealedTailProjectedBundles > expectedTailBundles || sealedTailProjectedBundles > sealedTailProjectedMessageCount) return undefined;
		if (anchorProjectedToolTextBytes + sealedTailProjectedToolTextBytes > anchorToolTextBytes) return undefined;
		if (anchorProjectedBundles + sealedTailProjectedBundles > hardBundles) return undefined;
		if (projectedToolTextBytes > hardToolTextBytes || projectedBundles > hardBundles) return undefined;
		if (rawBundles < 1 || projectedBundles < 1 || rawBundles > observedRawMessageCount) return undefined;
		if (projectedBundles < anchorProjectedBundles + sealedTailProjectedBundles) return undefined;
		if (projectedToolTextBytes < anchorProjectedToolTextBytes + sealedTailProjectedToolTextBytes) return undefined;
		if (rawBundles !== projectedBundles + transitionRemovedBundles) return undefined;
		if (transitionCollapsedResults > observedRawMessageCount) return undefined;
		if (rawToolTextBytes <= hardToolTextBytes && rawBundles <= hardBundles) return undefined;
		const parsed = record as unknown as LegacyV2HistoryProjectionStateEntryData;
		if (parsed.epochHash !== legacyV2EpochHashFor(parsed)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function strictProjectionStateV1(value: unknown): LegacyHistoryProjectionStateEntryData | undefined {
	try {
		const record = strictPlainRecord(value, LEGACY_HISTORY_PROJECTION_STATE_KEYS);
		if (!record || record.schemaVersion !== LEGACY_HISTORY_PROJECTION_STATE_SCHEMA_VERSION) return undefined;
		if (record.active !== 0 && record.active !== 1) return undefined;
		for (const key of [
			"epoch", "prefixMessageCount", "hardToolTextBytes", "hardBundles", "lowToolTextBytes", "lowBundles",
			"transitionCollapsedResults", "transitionRemovedBundles", "rawToolTextBytes", "rawBundles",
			"projectedToolTextBytes", "projectedBundles",
		]) if (safeNonNegativeInteger(record[key]) === undefined) return undefined;
		if ((record.epoch as number) > HISTORY_PROJECTION_MAX_EPOCH) return undefined;
		for (const key of ["epochHash", "prefixHash", "projectedPrefixHash"]) {
			if (typeof record[key] !== "string" || !SHA256_PATTERN.test(record[key] as string)) return undefined;
		}
		if (record.active === 1) {
			if ((record.epoch as number) < 1 || (record.prefixMessageCount as number) < 1) return undefined;
			if ((record.lowToolTextBytes as number) > (record.hardToolTextBytes as number)) return undefined;
			if ((record.lowBundles as number) > (record.hardBundles as number)) return undefined;
		} else if (record.prefixMessageCount !== 0
			|| record.epochHash !== EMPTY_HISTORY_HASH
			|| record.prefixHash !== EMPTY_HISTORY_HASH
			|| record.projectedPrefixHash !== EMPTY_HISTORY_HASH) return undefined;
		return record as unknown as LegacyHistoryProjectionStateEntryData;
	} catch {
		return undefined;
	}
}

/**
 * Snapshot an outer JSONL entry array without reading its length or indexes
 * through user-controlled property access. The upper bound is deliberately
 * far above a production session while keeping descriptor work finite.
 */
function strictProjectionEntries(value: unknown): unknown[] | undefined {
	try {
		if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || !Array.isArray(value)) return undefined;
		if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
		const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
		if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value")
			|| typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value)
			|| lengthDescriptor.value < 0 || lengthDescriptor.value > HISTORY_PROJECTION_RESTORE_MAX_ENTRIES) return undefined;
		const length = lengthDescriptor.value;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Reflect.ownKeys(descriptors);
		if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string")) return undefined;
		const entries: unknown[] = [];
		for (let index = 0; index < length; index += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(descriptors, String(index))?.value as PropertyDescriptor | undefined;
			if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return undefined;
			entries.push(descriptor.value);
		}
		return entries;
	} catch {
		return undefined;
	}
}

type ProjectionEntryCandidate =
	| { readonly kind: "unrelated" }
	| { readonly kind: "unsafe" }
	| { readonly kind: "matched"; readonly version: 1 | 2 | 3; readonly data: unknown };

/** Classify a JSONL entry using own data descriptors without invoking application code. */
function projectionEntryData(entry: unknown): ProjectionEntryCandidate {
	try {
		if (entry === null || typeof entry !== "object") return { kind: "unrelated" };
		if (utilTypes.isProxy(entry)) return { kind: "unsafe" };
		const prototype = Object.getPrototypeOf(entry);
		if (prototype !== Object.prototype && prototype !== null) return { kind: "unsafe" };
		if (Object.getOwnPropertySymbols(entry).length !== 0) return { kind: "unsafe" };

		const customTypeDescriptor = Object.getOwnPropertyDescriptor(entry, "customType");
		if (!customTypeDescriptor) return { kind: "unrelated" };
		if (customTypeDescriptor.enumerable !== true
			|| !Object.prototype.hasOwnProperty.call(customTypeDescriptor, "value")) return { kind: "unsafe" };

		const version = customTypeDescriptor.value === HISTORY_PROJECTION_ENTRY_TYPE
			? 3
			: customTypeDescriptor.value === LEGACY_HISTORY_PROJECTION_V2_ENTRY_TYPE
				? 2
				: customTypeDescriptor.value === LEGACY_HISTORY_PROJECTION_ENTRY_TYPE
					? 1
					: undefined;
		if (version === undefined) return { kind: "unrelated" };

		const dataDescriptor = Object.getOwnPropertyDescriptor(entry, "data");
		if (!dataDescriptor || dataDescriptor.enumerable !== true
			|| !Object.prototype.hasOwnProperty.call(dataDescriptor, "value")) return { kind: "unsafe" };
		return { kind: "matched", version, data: dataDescriptor.value };
	} catch {
		return { kind: "unsafe" };
	}
}

function turnCapForRole(role: ProjectContextHistoryInput["role"]): number {
	return role === "commander" ? COMMANDER_TURN_MAX_BYTES : WORKER_TURN_MAX_BYTES;
}

function anchorByteCap(hardToolTextBytes: number, role: ProjectContextHistoryInput["role"]): number {
	return Math.max(
		0,
		hardToolTextBytes
			- turnCapForRole(role)
			- HISTORY_PROJECTION_MAX_SEGMENTS * HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES,
	);
}

function anchorBundleCap(hardBundles: number): number {
	return Math.max(
		0,
		hardBundles - HISTORY_PROJECTION_MAX_SEGMENTS - HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES,
	);
}

function sliceProjection(
	input: ProjectContextHistoryInput,
	messages: readonly AgentMessage[],
	maxToolTextBytes: number,
	maxBundles: number,
): ProjectContextHistoryResult {
	return projectContextHistory({ ...input, messages, maxToolTextBytes, maxBundles });
}

function emptyProjection(): ProjectContextHistoryResult {
	return {
		messages: [],
		facts: {
			originalToolTextBytes: 0,
			finalToolTextBytes: 0,
			collapsedResults: 0,
			removedBundles: 0,
			protectedLatestBundles: 0,
		},
	};
}

function projectionMatches(
	projection: ProjectContextHistoryResult,
	hash: string,
	messageCount: number,
	toolTextBytes: number,
	bundles: number,
): boolean {
	return projection.messages.length === messageCount
		&& projection.facts.finalToolTextBytes === toolTextBytes
		&& historyBundleCount(projection.messages) === bundles
		&& hashHistoryMessages(projection.messages) === hash;
}

function boundaryMarkerText(boundaryId: string): string {
	return `[workbench history cache boundary]\nboundary_id=${boundaryId}`;
}

function boundaryMarkerMessage(boundaryId: string): AgentMessage {
	return {
		role: "custom",
		customType: "workbench-history-projection-boundary",
		content: boundaryMarkerText(boundaryId),
		display: false,
		details: { boundary_id: boundaryId },
		timestamp: 0,
	} as AgentMessage;
}

function boundaryIdFor(
	kind: "anchor" | "segment",
	ordinal: number,
	projection: ProjectContextHistoryResult,
): string {
	return createHash("sha256").update([
		"workbench-history-provider-boundary-v3",
		kind,
		String(ordinal),
		hashHistoryMessages(projection.messages),
		String(projection.messages.length),
		String(projection.facts.finalToolTextBytes),
		String(historyBundleCount(projection.messages) ?? -1),
	].join("\n")).digest("hex");
}

interface MarkedProjection {
	projection: ProjectContextHistoryResult;
	boundaryId: string;
}

function markedSliceProjection(
	input: ProjectContextHistoryInput,
	messages: readonly AgentMessage[],
	maxToolTextBytes: number,
	maxBundles: number,
	kind: "anchor" | "segment",
	ordinal: number,
): MarkedProjection {
	const projected = sliceProjection(input, messages, maxToolTextBytes, Math.max(1, maxBundles));
	const projectedBundles = historyBundleCount(projected.messages);
	if (projectedBundles === undefined
		|| projected.facts.finalToolTextBytes > maxToolTextBytes
		|| projectedBundles > maxBundles) {
		throw new Error("projected slice exceeds its fixed reserve");
	}
	const boundaryId = boundaryIdFor(kind, ordinal, projected);
	return {
		boundaryId,
		projection: {
			messages: [...projected.messages, boundaryMarkerMessage(boundaryId)],
			facts: projected.facts,
		},
	};
}

function zeroFrozenSlice(): FrozenHistoryProjectionSlice {
	return {
		rawStartMessageCount: 0,
		rawEndMessageCount: 0,
		rawHash: EMPTY_HISTORY_HASH,
		projectedMessageCount: 0,
		projectedHash: EMPTY_HISTORY_HASH,
		projectedToolTextBytes: 0,
		projectedBundles: 0,
		boundaryId: EMPTY_HISTORY_HASH,
		collapsedResults: 0,
		removedBundles: 0,
	};
}

function frozenSliceFromProjection(input: {
	rawStartMessageCount: number;
	rawEndMessageCount: number;
	raw: readonly AgentMessage[];
	marked: MarkedProjection;
}): FrozenHistoryProjectionSlice {
	const projectedBundles = historyBundleCount(input.marked.projection.messages);
	if (projectedBundles === undefined) throw new Error("invalid projected slice pairing");
	return {
		rawStartMessageCount: input.rawStartMessageCount,
		rawEndMessageCount: input.rawEndMessageCount,
		rawHash: hashHistoryMessages(input.raw),
		projectedMessageCount: input.marked.projection.messages.length,
		projectedHash: hashHistoryMessages(input.marked.projection.messages),
		projectedToolTextBytes: input.marked.projection.facts.finalToolTextBytes,
		projectedBundles,
		boundaryId: input.marked.boundaryId,
		collapsedResults: input.marked.projection.facts.collapsedResults,
		removedBundles: input.marked.projection.facts.removedBundles,
	};
}

function sliceHashLines(slice: FrozenHistoryProjectionSlice): string[] {
	return [
		String(slice.rawStartMessageCount),
		String(slice.rawEndMessageCount),
		slice.rawHash,
		String(slice.projectedMessageCount),
		slice.projectedHash,
		String(slice.projectedToolTextBytes),
		String(slice.projectedBundles),
		slice.boundaryId,
		String(slice.collapsedResults),
		String(slice.removedBundles),
	];
}

function epochHashFor(state: Pick<FrozenHistoryProjectionEpoch,
	"epoch" | "hardToolTextBytes" | "hardBundles" | "descriptorMaxBytes" | "anchorToolTextBytes" | "anchorBundles" | "anchor"
>): string {
	return createHash("sha256").update([
		"workbench-history-epoch-v3",
		String(state.epoch),
		String(state.hardToolTextBytes),
		String(state.hardBundles),
		String(state.descriptorMaxBytes),
		String(state.anchorToolTextBytes),
		String(state.anchorBundles),
		...sliceHashLines(state.anchor),
	].join("\n")).digest("hex");
}

function segmentChainHashFor(epochHash: string, segments: readonly FrozenHistoryProjectionSlice[]): string {
	const hash = createHash("sha256");
	hash.update("workbench-history-segment-chain-v3\n");
	hash.update(epochHash);
	for (const segment of segments) {
		hash.update("\nsegment\n");
		hash.update(sliceHashLines(segment).join("\n"));
	}
	return hash.digest("hex");
}

function stateHashFor(state: Omit<HistoryProjectionStateEntryData, "stateHash">): string {
	return createHash("sha256").update([
		"workbench-history-state-v3",
		String(state.schemaVersion),
		String(state.active),
		String(state.epoch),
		state.epochHash,
		state.segmentChainHash,
		String(state.hardToolTextBytes),
		String(state.hardBundles),
		String(state.descriptorMaxBytes),
		String(state.anchorToolTextBytes),
		String(state.anchorBundles),
		...sliceHashLines(state.anchor),
		String(state.segments.length),
		...state.segments.flatMap((segment) => sliceHashLines(segment)),
		String(state.activeRawStartMessageCount),
		String(state.observedRawMessageCount),
		state.observedRawHash,
		String(state.transitionCollapsedResults),
		String(state.transitionRemovedBundles),
		String(state.rawToolTextBytes),
		String(state.rawBundles),
		String(state.projectedToolTextBytes),
		String(state.projectedBundles),
	].join("\n")).digest("hex");
}

function strictProjectionSlice(value: unknown): FrozenHistoryProjectionSlice | undefined {
	const record = strictPlainRecord(value, HISTORY_PROJECTION_SLICE_KEYS);
	if (!record) return undefined;
	for (const key of [
		"rawStartMessageCount", "rawEndMessageCount", "projectedMessageCount", "projectedToolTextBytes",
		"projectedBundles", "collapsedResults", "removedBundles",
	]) if (safeNonNegativeInteger(record[key]) === undefined) return undefined;
	for (const key of ["rawHash", "projectedHash", "boundaryId"]) {
		if (typeof record[key] !== "string" || !SHA256_PATTERN.test(record[key] as string)) return undefined;
	}
	return record as unknown as FrozenHistoryProjectionSlice;
}

function strictProjectionSlices(value: unknown): FrozenHistoryProjectionSlice[] | undefined {
	if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
	if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
	const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
	const lengthDescriptor = descriptors.length;
	if (!lengthDescriptor || Object.prototype.hasOwnProperty.call(lengthDescriptor, "get")
		|| typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value)
		|| lengthDescriptor.value < 0 || lengthDescriptor.value > HISTORY_PROJECTION_MAX_SEGMENTS) return undefined;
	const expectedKeys = [
		...Array.from({ length: lengthDescriptor.value }, (_, index) => String(index)),
		"length",
	].sort();
	const keys = Object.keys(descriptors).sort();
	if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return undefined;
	const output: FrozenHistoryProjectionSlice[] = [];
	for (let index = 0; index < lengthDescriptor.value; index += 1) {
		const descriptor = descriptors[String(index)];
		if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return undefined;
		const slice = strictProjectionSlice(descriptor.value);
		if (!slice) return undefined;
		output.push(slice);
	}
	return output;
}

function isZeroFrozenSlice(slice: FrozenHistoryProjectionSlice): boolean {
	return slice.rawStartMessageCount === 0
		&& slice.rawEndMessageCount === 0
		&& slice.rawHash === EMPTY_HISTORY_HASH
		&& slice.projectedMessageCount === 0
		&& slice.projectedHash === EMPTY_HISTORY_HASH
		&& slice.projectedToolTextBytes === 0
		&& slice.projectedBundles === 0
		&& slice.boundaryId === EMPTY_HISTORY_HASH
		&& slice.collapsedResults === 0
		&& slice.removedBundles === 0;
}

function validRestoredV3AnchorCap(hardToolTextBytes: number, anchorToolTextBytes: number): boolean {
	if (hardToolTextBytes < 1 || hardToolTextBytes > COMMANDER_HISTORY_MAX_BYTES) return false;
	const segmentReserve = HISTORY_PROJECTION_MAX_SEGMENTS * HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES;
	const commanderCandidate = Math.max(0, hardToolTextBytes - COMMANDER_TURN_MAX_BYTES - segmentReserve);
	const workerCandidate = hardToolTextBytes <= WORKER_HISTORY_MAX_BYTES
		? Math.max(0, hardToolTextBytes - WORKER_TURN_MAX_BYTES - segmentReserve)
		: undefined;
	return anchorToolTextBytes === commanderCandidate || anchorToolTextBytes === workerCandidate;
}

function strictProjectionStateV3(value: unknown): HistoryProjectionStateEntryData | undefined {
	try {
		const record = strictPlainRecord(value, HISTORY_PROJECTION_STATE_KEYS);
		if (!record || record.schemaVersion !== HISTORY_PROJECTION_STATE_SCHEMA_VERSION) return undefined;
		if (record.active !== 0 && record.active !== 1) return undefined;
		for (const key of [
			"schemaVersion", "active", "epoch", "hardToolTextBytes", "hardBundles", "descriptorMaxBytes",
			"anchorToolTextBytes", "anchorBundles", "activeRawStartMessageCount", "observedRawMessageCount",
			"transitionCollapsedResults", "transitionRemovedBundles", "rawToolTextBytes", "rawBundles",
			"projectedToolTextBytes", "projectedBundles",
		]) if (safeNonNegativeInteger(record[key]) === undefined) return undefined;
		if ((record.epoch as number) > HISTORY_PROJECTION_MAX_EPOCH) return undefined;
		for (const key of ["epochHash", "segmentChainHash", "stateHash", "observedRawHash"]) {
			if (typeof record[key] !== "string" || !SHA256_PATTERN.test(record[key] as string)) return undefined;
		}
		const anchor = strictProjectionSlice(record.anchor);
		const segments = strictProjectionSlices(record.segments);
		if (!anchor || !segments) return undefined;
		const parsed = { ...record, anchor, segments } as unknown as HistoryProjectionStateEntryData;
		if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > 32 * 1_024) return undefined;

		if (parsed.active === 0) {
			if (!isZeroFrozenSlice(anchor) || segments.length !== 0) return undefined;
			if (parsed.hardToolTextBytes !== 0 || parsed.hardBundles !== 0 || parsed.descriptorMaxBytes !== 0
				|| parsed.anchorToolTextBytes !== 0 || parsed.anchorBundles !== 0
				|| parsed.activeRawStartMessageCount !== 0 || parsed.observedRawMessageCount !== 0
				|| parsed.transitionCollapsedResults !== 0 || parsed.transitionRemovedBundles !== 0) return undefined;
			if ((parsed.epochHash !== EMPTY_HISTORY_HASH && parsed.epochHash !== FAILURE_BOUNDARY_HASH)
				|| parsed.segmentChainHash !== EMPTY_HISTORY_HASH
				|| parsed.observedRawHash !== EMPTY_HISTORY_HASH) return undefined;
			const { stateHash, ...stateWithoutHash } = parsed;
			if (stateHash !== stateHashFor(stateWithoutHash)) return undefined;
			return parsed;
		}

		if (parsed.epoch < 1 || !validRestoredV3AnchorCap(parsed.hardToolTextBytes, parsed.anchorToolTextBytes)) return undefined;
		if (parsed.hardBundles < 1 || parsed.hardBundles > HISTORY_MAX_BUNDLES) return undefined;
		if (parsed.descriptorMaxBytes > HISTORY_DESCRIPTOR_MAX_BYTES) return undefined;
		if (parsed.anchorBundles !== anchorBundleCap(parsed.hardBundles)) return undefined;
		if (anchor.rawStartMessageCount !== 0 || anchor.rawEndMessageCount > parsed.observedRawMessageCount) return undefined;
		if (anchor.projectedMessageCount < 1 || anchor.projectedToolTextBytes > parsed.anchorToolTextBytes
			|| anchor.projectedBundles > parsed.anchorBundles) return undefined;
		let expectedStart = anchor.rawEndMessageCount;
		let stableToolTextBytes = anchor.projectedToolTextBytes;
		let stableBundles = anchor.projectedBundles;
		let collapsedResults = anchor.collapsedResults;
		let removedBundles = anchor.removedBundles;
		for (const segment of segments) {
			if (segment.rawStartMessageCount !== expectedStart || segment.rawEndMessageCount <= expectedStart
				|| segment.rawEndMessageCount > parsed.observedRawMessageCount) return undefined;
			if (segment.projectedMessageCount < 1
				|| segment.projectedToolTextBytes > HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES
				|| segment.projectedBundles > HISTORY_PROJECTION_SEGMENT_MAX_BUNDLES) return undefined;
			expectedStart = segment.rawEndMessageCount;
			stableToolTextBytes += segment.projectedToolTextBytes;
			stableBundles += segment.projectedBundles;
			collapsedResults += segment.collapsedResults;
			removedBundles += segment.removedBundles;
		}
		if (parsed.activeRawStartMessageCount !== expectedStart
			|| parsed.observedRawMessageCount < expectedStart) return undefined;
		if (parsed.transitionCollapsedResults !== collapsedResults || parsed.transitionRemovedBundles !== removedBundles) return undefined;
		if (parsed.projectedToolTextBytes < stableToolTextBytes || parsed.projectedBundles < stableBundles) return undefined;
		// The active turn reserve sizes the suffix retained after a real hard-cap crossing;
		// an append-only active tail may grow beyond that reserve while these total caps still hold.
		if (parsed.projectedToolTextBytes > parsed.hardToolTextBytes || parsed.projectedBundles > parsed.hardBundles) return undefined;
		if (parsed.rawBundles !== parsed.projectedBundles + parsed.transitionRemovedBundles) return undefined;
		if (parsed.rawBundles < 1 || parsed.rawBundles > parsed.observedRawMessageCount) return undefined;
		if (parsed.transitionCollapsedResults > parsed.observedRawMessageCount) return undefined;
		if (parsed.epochHash !== epochHashFor(parsed)) return undefined;
		if (parsed.segmentChainHash !== segmentChainHashFor(parsed.epochHash, segments)) return undefined;
		const { stateHash, ...stateWithoutHash } = parsed;
		if (stateHash !== stateHashFor(stateWithoutHash)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function frozenFromState(state: HistoryProjectionStateEntryData): FrozenHistoryProjectionEpoch {
	const {
		schemaVersion: _schemaVersion,
		active: _active,
		stateHash: _stateHash,
		rawToolTextBytes: _rawToolTextBytes,
		rawBundles: _rawBundles,
		projectedToolTextBytes: _projectedToolTextBytes,
		projectedBundles: _projectedBundles,
		...frozen
	} = state;
	return {
		...frozen,
		anchor: { ...frozen.anchor },
		segments: frozen.segments.map((segment) => ({ ...segment })),
	};
}

function latestRawSuffixStart(
	messages: readonly AgentMessage[],
	analysis: HistoryAnalysis,
	maxToolTextBytes: number,
	maxBundles: number,
): number {
	let selected = 0;
	let selectedBytes = 0;
	let start = messages.length;
	for (let index = analysis.bundles.length - 1; index >= 0 && selected < maxBundles; index -= 1) {
		const bundle = analysis.bundles[index]!;
		if (selectedBytes + bundle.rawTextBytes > maxToolTextBytes) break;
		selectedBytes += bundle.rawTextBytes;
		selected += 1;
		start = bundle.assistantIndex;
	}
	return start;
}

function boundaryMarkersFor(frozen: FrozenHistoryProjectionEpoch | undefined): HistoryProjectionBoundaryMarker[] {
	if (!frozen) return [];
	return [frozen.anchor, ...frozen.segments].map((slice) => ({
		boundaryId: slice.boundaryId,
		marker: boundaryMarkerText(slice.boundaryId),
	}));
}

function stableProjectionPressure(frozen: FrozenHistoryProjectionEpoch | undefined): {
	toolTextBytes: number;
	bundles: number;
} {
	if (!frozen) return { toolTextBytes: 0, bundles: 0 };
	let toolTextBytes = frozen.anchor.projectedToolTextBytes;
	let bundles = frozen.anchor.projectedBundles;
	for (const segment of frozen.segments) {
		toolTextBytes += segment.projectedToolTextBytes;
		bundles += segment.projectedBundles;
	}
	return { toolTextBytes, bundles };
}

/**
 * Session-scoped, I/O-free immutable segmented projection state machine.
 *
 * V3 freezes one bounded anchor and then appends at most sixteen independently
 * projected tail segments. A seal never rewrites the anchor or an earlier
 * segment. The seventeenth seal performs one bounded checkpoint. Persisted
 * state contains only safe integers and domain-separated hashes; projections
 * are reconstructed from Pi's JSONL history after reload.
 */
export class HistoryProjectionController {
	private frozen: FrozenHistoryProjectionEpoch | undefined;
	private epochCounter = 0;
	private legacyMigrationPending = false;
	private failureBoundaryActive = false;
	private pressure: HistoryPressureFacts = {
		rawToolTextBytes: 0,
		rawBundles: 0,
		projectedToolTextBytes: 0,
		projectedBundles: 0,
	};

	private clear(epoch = 0): void {
		this.frozen = undefined;
		this.epochCounter = epoch;
		this.legacyMigrationPending = false;
		this.failureBoundaryActive = false;
		this.pressure = { rawToolTextBytes: 0, rawBundles: 0, projectedToolTextBytes: 0, projectedBundles: 0 };
	}

	reset(): void {
		const currentEpoch = Math.max(this.epochCounter, this.frozen?.epoch ?? 0);
		const nextEpoch = this.frozen ? advanceHistoryProjectionEpoch(currentEpoch) : currentEpoch;
		this.clear(nextEpoch ?? currentEpoch);
	}

	restoreFromEntries(entries: readonly unknown[]): boolean {
		const strictEntries = strictProjectionEntries(entries);
		if (!strictEntries) {
			this.clear();
			return false;
		}
		try {
			for (let index = strictEntries.length - 1; index >= 0; index -= 1) {
				const candidate = projectionEntryData(strictEntries[index]);
				if (candidate.kind === "unrelated") continue;
				if (candidate.kind === "unsafe") {
					this.clear();
					return false;
				}
				if (candidate.version === 3) {
					const parsed = strictProjectionStateV3(candidate.data);
					if (!parsed) {
						this.clear();
						return false;
					}
					this.epochCounter = parsed.epoch;
					this.legacyMigrationPending = false;
					this.pressure = {
						rawToolTextBytes: parsed.rawToolTextBytes,
						rawBundles: parsed.rawBundles,
						projectedToolTextBytes: parsed.projectedToolTextBytes,
						projectedBundles: parsed.projectedBundles,
					};
					this.frozen = parsed.active === 1 ? frozenFromState(parsed) : undefined;
					this.failureBoundaryActive = parsed.active === 0 && parsed.epochHash === FAILURE_BOUNDARY_HASH;
					return true;
				}

				const legacy = candidate.version === 2
					? strictLegacyProjectionStateV2(candidate.data)
					: strictProjectionStateV1(candidate.data);
				if (!legacy) {
					this.clear();
					return false;
				}
				this.frozen = undefined;
				this.epochCounter = legacy.epoch;
				this.legacyMigrationPending = true;
				this.failureBoundaryActive = false;
				this.pressure = {
					rawToolTextBytes: legacy.rawToolTextBytes,
					rawBundles: legacy.rawBundles,
					projectedToolTextBytes: legacy.projectedToolTextBytes,
					projectedBundles: legacy.projectedBundles,
				};
				return true;
			}
		} catch {
			this.clear();
			return false;
		}
		this.clear();
		return false;
	}

	serialize(): HistoryProjectionStateEntryData {
		const frozen = this.frozen;
		const stateWithoutHash: Omit<HistoryProjectionStateEntryData, "stateHash"> = {
			schemaVersion: HISTORY_PROJECTION_STATE_SCHEMA_VERSION,
			active: frozen ? 1 : 0,
			epoch: frozen?.epoch ?? this.epochCounter,
			// Inactive v3 topology has no epoch digest to persist. Reuse the
			// fixed, non-secret failure boundary identity as a strict sentinel so
			// JSONL restore preserves failure deduplication and one-shot recovery.
			epochHash: frozen?.epochHash ?? (this.failureBoundaryActive ? FAILURE_BOUNDARY_HASH : EMPTY_HISTORY_HASH),
			segmentChainHash: frozen?.segmentChainHash ?? EMPTY_HISTORY_HASH,
			hardToolTextBytes: frozen?.hardToolTextBytes ?? 0,
			hardBundles: frozen?.hardBundles ?? 0,
			descriptorMaxBytes: frozen?.descriptorMaxBytes ?? 0,
			anchorToolTextBytes: frozen?.anchorToolTextBytes ?? 0,
			anchorBundles: frozen?.anchorBundles ?? 0,
			anchor: frozen ? { ...frozen.anchor } : zeroFrozenSlice(),
			segments: frozen?.segments.map((segment) => ({ ...segment })) ?? [],
			activeRawStartMessageCount: frozen?.activeRawStartMessageCount ?? 0,
			observedRawMessageCount: frozen?.observedRawMessageCount ?? 0,
			observedRawHash: frozen?.observedRawHash ?? EMPTY_HISTORY_HASH,
			transitionCollapsedResults: frozen?.transitionCollapsedResults ?? 0,
			transitionRemovedBundles: frozen?.transitionRemovedBundles ?? 0,
			rawToolTextBytes: this.pressure.rawToolTextBytes,
			rawBundles: this.pressure.rawBundles,
			projectedToolTextBytes: this.pressure.projectedToolTextBytes,
			projectedBundles: this.pressure.projectedBundles,
		};
		return { ...stateWithoutHash, stateHash: stateHashFor(stateWithoutHash) };
	}

	private replay(
		input: ProjectContextHistoryInput,
		hardToolTextBytes: number,
		hardBundles: number,
	): ReplayResult {
		const frozen = this.frozen!;
		if (frozen.hardToolTextBytes !== hardToolTextBytes
			|| frozen.hardBundles !== hardBundles
			|| frozen.descriptorMaxBytes !== effectiveDescriptorCap(input.descriptorMaxBytes)
			|| frozen.anchorToolTextBytes !== anchorByteCap(hardToolTextBytes, input.role)
			|| frozen.anchorBundles !== anchorBundleCap(hardBundles)) {
			return { status: "policy_changed" };
		}
		if (input.messages.length < frozen.observedRawMessageCount
			|| hashHistoryMessages(input.messages.slice(0, frozen.observedRawMessageCount)) !== frozen.observedRawHash) {
			return { status: "prefix_changed" };
		}

		const anchorRaw = input.messages.slice(frozen.anchor.rawStartMessageCount, frozen.anchor.rawEndMessageCount);
		if (hashHistoryMessages(anchorRaw) !== frozen.anchor.rawHash) return { status: "prefix_changed" };
		const anchorMarked = markedSliceProjection(
			input,
			anchorRaw,
			frozen.anchorToolTextBytes,
			frozen.anchorBundles,
			"anchor",
			0,
		);
		if (anchorMarked.boundaryId !== frozen.anchor.boundaryId || !projectionMatches(
			anchorMarked.projection,
			frozen.anchor.projectedHash,
			frozen.anchor.projectedMessageCount,
			frozen.anchor.projectedToolTextBytes,
			frozen.anchor.projectedBundles,
		)) return { status: "prefix_changed" };

		const segmentProjections: ProjectContextHistoryResult[] = [];
		for (let index = 0; index < frozen.segments.length; index += 1) {
			const segment = frozen.segments[index]!;
			const raw = input.messages.slice(segment.rawStartMessageCount, segment.rawEndMessageCount);
			if (hashHistoryMessages(raw) !== segment.rawHash) return { status: "prefix_changed" };
			const marked = markedSliceProjection(
				input,
				raw,
				HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES,
				HISTORY_PROJECTION_SEGMENT_MAX_BUNDLES,
				"segment",
				index + 1,
			);
			if (marked.boundaryId !== segment.boundaryId || !projectionMatches(
				marked.projection,
				segment.projectedHash,
				segment.projectedMessageCount,
				segment.projectedToolTextBytes,
				segment.projectedBundles,
			)) return { status: "prefix_changed" };
			segmentProjections.push(marked.projection);
		}

		const active = input.messages.slice(frozen.activeRawStartMessageCount);
		const messages = [
			...anchorMarked.projection.messages,
			...segmentProjections.flatMap((projection) => projection.messages),
			...active,
		];
		const projectedBundles = historyBundleCount(messages);
		if (projectedBundles === undefined || !validateContextToolPairing(messages)) return { status: "prefix_changed" };
		return {
			status: "ok",
			replay: {
				anchor: anchorMarked.projection,
				segments: segmentProjections,
				active,
				messages,
				projectedToolTextBytes: historyToolTextBytes(messages),
				projectedBundles,
			},
		};
	}

	private observeRaw(messages: readonly AgentMessage[]): void {
		if (!this.frozen) return;
		this.frozen.observedRawMessageCount = messages.length;
		this.frozen.observedRawHash = hashHistoryMessages(messages);
	}

	private checkpoint(
		input: ProjectContextHistoryInput,
		analysis: HistoryAnalysis,
		hardToolTextBytes: number,
		hardBundles: number,
		rawToolTextBytes: number,
		rawBundles: number,
		cause: Exclude<HistoryProjectionTransitionCause, "none" | "segment_sealed" | "failure">,
		previousCollapsedResults: number,
		previousRemovedBundles: number,
		decision: HistoryProjectionDecisionFacts,
	): HistoryProjectionControllerResult {
		const currentEpoch = Math.max(this.epochCounter, this.frozen?.epoch ?? 0);
		const epoch = advanceHistoryProjectionEpoch(currentEpoch);
		if (epoch === undefined) {
			this.epochCounter = currentEpoch;
			return this.failure(rawToolTextBytes, rawBundles, decision);
		}
		const activeBytes = Math.min(turnCapForRole(input.role), hardToolTextBytes);
		const activeBundles = Math.min(HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES, hardBundles);
		const split = latestRawSuffixStart(input.messages, analysis, activeBytes, activeBundles);
		const anchorRaw = input.messages.slice(0, split);
		const suffix = input.messages.slice(split);
		const anchorToolTextBytes = anchorByteCap(hardToolTextBytes, input.role);
		const anchorBundles = anchorBundleCap(hardBundles);
		const marked = markedSliceProjection(input, anchorRaw, anchorToolTextBytes, anchorBundles, "anchor", 0);
		const anchor = frozenSliceFromProjection({
			rawStartMessageCount: 0,
			rawEndMessageCount: split,
			raw: anchorRaw,
			marked,
		});
		const combined = [...marked.projection.messages, ...suffix];
		const combinedBundles = historyBundleCount(combined);
		const combinedBytes = historyToolTextBytes(combined);
		const suffixBundles = historyBundleCount(suffix);
		const suffixToolTextBytes = historyToolTextBytes(suffix);
		if (combinedBundles === undefined || suffixBundles === undefined
			|| combinedBytes > hardToolTextBytes || combinedBundles > hardBundles
			|| suffixToolTextBytes > activeBytes || suffixBundles > activeBundles
			|| !validateContextToolPairing(combined)) {
			return this.failure(rawToolTextBytes, rawBundles, decision);
		}

		this.epochCounter = epoch;
		this.legacyMigrationPending = false;
		const epochBase = {
			epoch,
			hardToolTextBytes,
			hardBundles,
			descriptorMaxBytes: effectiveDescriptorCap(input.descriptorMaxBytes),
			anchorToolTextBytes,
			anchorBundles,
			anchor,
		};
		const epochHash = epochHashFor(epochBase);
		this.frozen = {
			...epochBase,
			epochHash,
			segmentChainHash: segmentChainHashFor(epochHash, []),
			segments: [],
			activeRawStartMessageCount: split,
			observedRawMessageCount: input.messages.length,
			observedRawHash: hashHistoryMessages(input.messages),
			transitionCollapsedResults: anchor.collapsedResults,
			transitionRemovedBundles: anchor.removedBundles,
		};
		return this.finish({
			messages: combined,
			facts: {
				originalToolTextBytes: rawToolTextBytes,
				finalToolTextBytes: combinedBytes,
				collapsedResults: anchor.collapsedResults,
				removedBundles: anchor.removedBundles,
				protectedLatestBundles: suffixBundles,
			},
		}, rawToolTextBytes, rawBundles, true, false, cause,
			Math.max(0, anchor.collapsedResults - previousCollapsedResults),
			Math.max(0, anchor.removedBundles - previousRemovedBundles), undefined, {
				...decision,
				eventKind: cause === "initial_hard_limit" ? "initial_hard_projection" : "epoch_checkpoint",
				transitionCause: cause,
				agedRawToolTextBytes: historyToolTextBytes(anchorRaw),
				agedRawBundles: analysis.bundles.filter((bundle) => bundle.assistantIndex < split).length,
				agedProjectedToolTextBytes: anchor.projectedToolTextBytes,
				agedProjectedBundles: anchor.projectedBundles,
				suffixRawToolTextBytes: suffixToolTextBytes,
				suffixRawBundles: suffixBundles,
			});
	}

	private sealSegment(
		input: ProjectContextHistoryInput,
		analysis: HistoryAnalysis,
		replay: ReplayProjection,
		rawToolTextBytes: number,
		rawBundles: number,
		cause: "hard_bytes" | "hard_bundles",
	): HistoryProjectionControllerResult {
		const previous = this.frozen!;
		const stableBefore = stableProjectionPressure(previous);
		const activeBundlesBefore = historyBundleCount(replay.active);
		if (activeBundlesBefore === undefined) {
			return this.failure(rawToolTextBytes, rawBundles, {
				hardToolTextBytes: previous.hardToolTextBytes,
				hardBundles: previous.hardBundles,
				byteOverflow: false,
				bundleOverflow: false,
				segmentsBefore: previous.segments.length,
				stableToolTextBytesBefore: stableBefore.toolTextBytes,
				stableBundlesBefore: stableBefore.bundles,
				activeToolTextBytesBefore: 0,
				activeBundlesBefore: 0,
			});
		}
		const decision: HistoryProjectionDecisionFacts = {
			hardToolTextBytes: previous.hardToolTextBytes,
			hardBundles: previous.hardBundles,
			byteOverflow: replay.projectedToolTextBytes > previous.hardToolTextBytes,
			bundleOverflow: replay.projectedBundles > previous.hardBundles,
			segmentsBefore: previous.segments.length,
			stableToolTextBytesBefore: stableBefore.toolTextBytes,
			stableBundlesBefore: stableBefore.bundles,
			activeToolTextBytesBefore: historyToolTextBytes(replay.active),
			activeBundlesBefore,
		};
		if (previous.segments.length >= HISTORY_PROJECTION_MAX_SEGMENTS) {
			return this.checkpoint(
				input,
				analysis,
				previous.hardToolTextBytes,
				previous.hardBundles,
				rawToolTextBytes,
				rawBundles,
				cause,
				previous.transitionCollapsedResults,
				previous.transitionRemovedBundles,
				decision,
			);
		}
		const activeBytes = Math.min(turnCapForRole(input.role), previous.hardToolTextBytes);
		const activeBundles = Math.min(HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES, previous.hardBundles);
		const split = latestRawSuffixStart(input.messages, analysis, activeBytes, activeBundles);
		if (split <= previous.activeRawStartMessageCount) {
			return this.checkpoint(
				input,
				analysis,
				previous.hardToolTextBytes,
				previous.hardBundles,
				rawToolTextBytes,
				rawBundles,
				cause,
				previous.transitionCollapsedResults,
				previous.transitionRemovedBundles,
				decision,
			);
		}
		const agedRaw = input.messages.slice(previous.activeRawStartMessageCount, split);
		const suffix = input.messages.slice(split);
		const marked = markedSliceProjection(
			input,
			agedRaw,
			HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES,
			HISTORY_PROJECTION_SEGMENT_MAX_BUNDLES,
			"segment",
			previous.segments.length + 1,
		);
		const segment = frozenSliceFromProjection({
			rawStartMessageCount: previous.activeRawStartMessageCount,
			rawEndMessageCount: split,
			raw: agedRaw,
			marked,
		});
		const segments = [...previous.segments, segment];
		const combined = [
			...replay.anchor.messages,
			...replay.segments.flatMap((projection) => projection.messages),
			...marked.projection.messages,
			...suffix,
		];
		const combinedBundles = historyBundleCount(combined);
		const suffixBundles = historyBundleCount(suffix);
		const combinedBytes = historyToolTextBytes(combined);
		const suffixToolTextBytes = historyToolTextBytes(suffix);
		if (combinedBundles === undefined || suffixBundles === undefined
			|| combinedBytes > previous.hardToolTextBytes || combinedBundles > previous.hardBundles
			|| suffixToolTextBytes > activeBytes || suffixBundles > activeBundles
			|| !validateContextToolPairing(combined)) {
			return this.failure(rawToolTextBytes, rawBundles, decision);
		}

		this.frozen = {
			...previous,
			anchor: { ...previous.anchor },
			segments,
			segmentChainHash: segmentChainHashFor(previous.epochHash, segments),
			activeRawStartMessageCount: split,
			observedRawMessageCount: input.messages.length,
			observedRawHash: hashHistoryMessages(input.messages),
			transitionCollapsedResults: previous.transitionCollapsedResults + segment.collapsedResults,
			transitionRemovedBundles: previous.transitionRemovedBundles + segment.removedBundles,
		};
		return this.finish({
			messages: combined,
			facts: {
				originalToolTextBytes: rawToolTextBytes,
				finalToolTextBytes: combinedBytes,
				collapsedResults: this.frozen.transitionCollapsedResults,
				removedBundles: this.frozen.transitionRemovedBundles,
				protectedLatestBundles: suffixBundles,
			},
		}, rawToolTextBytes, rawBundles, false, true, "segment_sealed", segment.collapsedResults, segment.removedBundles,
			undefined, {
				...decision,
				eventKind: "segment_seal",
				transitionCause: "segment_sealed",
				agedRawToolTextBytes: historyToolTextBytes(agedRaw),
				agedRawBundles: historyBundleCount(agedRaw) ?? 0,
				agedProjectedToolTextBytes: segment.projectedToolTextBytes,
				agedProjectedBundles: segment.projectedBundles,
				suffixRawToolTextBytes: suffixToolTextBytes,
				suffixRawBundles: suffixBundles,
			});
	}

	private failure(
		rawToolTextBytes: number,
		rawBundles: number,
		decision: HistoryProjectionDecisionFacts,
	): HistoryProjectionControllerResult {
		this.frozen = undefined;
		this.legacyMigrationPending = false;
		return this.finish({
			messages: safeHistoryProjectionFailureMessages(),
			facts: {
				originalToolTextBytes: rawToolTextBytes,
				finalToolTextBytes: 0,
				collapsedResults: 0,
				removedBundles: 0,
				protectedLatestBundles: 0,
			},
		}, rawToolTextBytes, rawBundles, true, false, "failure", 0, 0, undefined, {
			...decision,
			eventKind: "fixed_failure",
			transitionCause: "failure",
			agedRawToolTextBytes: 0,
			agedRawBundles: 0,
			agedProjectedToolTextBytes: 0,
			agedProjectedBundles: 0,
			suffixRawToolTextBytes: 0,
			suffixRawBundles: 0,
		});
	}

	project(input: ProjectContextHistoryInput): HistoryProjectionControllerResult {
		let rawToolTextBytes = 0;
		let rawBundles = 0;
		const entryFrozen = this.frozen;
		const entryStable = stableProjectionPressure(entryFrozen);
		let failureDecision: HistoryProjectionDecisionFacts = {
			hardToolTextBytes: 0,
			hardBundles: 0,
			byteOverflow: false,
			bundleOverflow: false,
			segmentsBefore: entryFrozen?.segments.length ?? 0,
			stableToolTextBytesBefore: entryStable.toolTextBytes,
			stableBundlesBefore: entryStable.bundles,
			activeToolTextBytesBefore: 0,
			activeBundlesBefore: 0,
		};
		try {
			// Canonical hashing is the bounded, trap-free structural preflight.
			// Only after it succeeds may interrupted-batch recovery inspect values.
			const rawHash = hashHistoryMessages(input.messages);
			const hardToolTextBytes = effectiveByteCap(input);
			const hardBundles = effectiveBundleCap(input.maxBundles);
			failureDecision = { ...failureDecision, hardToolTextBytes, hardBundles };
			rawToolTextBytes = historyToolTextBytes(input.messages);
			let analysis = analyzeContextHistory(input.messages);
			if (!analysis.valid) {
				const repaired = repairInterruptedToolHistory(input.messages);
				if (repaired) {
					input = { ...input, messages: repaired };
					rawToolTextBytes = historyToolTextBytes(input.messages);
					analysis = analyzeContextHistory(input.messages);
				}
			}
			if (!analysis.valid) return this.failure(rawToolTextBytes, 0, failureDecision);
			rawBundles = analysis.bundles.length;
			const rawDecision: HistoryProjectionDecisionFacts = {
				hardToolTextBytes,
				hardBundles,
				byteOverflow: rawToolTextBytes > hardToolTextBytes,
				bundleOverflow: rawBundles > hardBundles,
				segmentsBefore: 0,
				stableToolTextBytesBefore: 0,
				stableBundlesBefore: 0,
				activeToolTextBytesBefore: rawToolTextBytes,
				activeBundlesBefore: rawBundles,
			};
			failureDecision = rawDecision;
			let invalidationCause: "prefix_changed" | "policy_changed" | undefined;
			let invalidatedEpochHash: string | undefined;
			let previousCollapsedResults = 0;
			let previousRemovedBundles = 0;
			let decision = rawDecision;

			if (this.frozen) {
				const previous = this.frozen;
				const stableBefore = stableProjectionPressure(previous);
				const invalidationDecision: HistoryProjectionDecisionFacts = {
					...rawDecision,
					segmentsBefore: previous.segments.length,
					stableToolTextBytesBefore: stableBefore.toolTextBytes,
					stableBundlesBefore: stableBefore.bundles,
					activeToolTextBytesBefore: 0,
					activeBundlesBefore: 0,
				};
				failureDecision = invalidationDecision;
				previousCollapsedResults = previous.transitionCollapsedResults;
				previousRemovedBundles = previous.transitionRemovedBundles;
				const replayed = this.replay(input, hardToolTextBytes, hardBundles);
				if (replayed.status === "ok") {
					const activeBundles = historyBundleCount(replayed.replay.active);
					if (activeBundles === undefined) return this.failure(rawToolTextBytes, rawBundles, invalidationDecision);
					// Turn reserves choose the protected suffix during sealing; only complete projected
					// history crossing a hard cap is allowed to rewrite the existing provider tail.
					const byteOverflow = replayed.replay.projectedToolTextBytes > hardToolTextBytes;
					const bundleOverflow = replayed.replay.projectedBundles > hardBundles;
					const activeToolTextBytes = historyToolTextBytes(replayed.replay.active);
					decision = {
						hardToolTextBytes,
						hardBundles,
						byteOverflow,
						bundleOverflow,
						segmentsBefore: previous.segments.length,
						stableToolTextBytesBefore: stableBefore.toolTextBytes,
						stableBundlesBefore: stableBefore.bundles,
						activeToolTextBytesBefore: activeToolTextBytes,
						activeBundlesBefore: activeBundles,
					};
					failureDecision = decision;
					if (!byteOverflow && !bundleOverflow) {
						this.observeRaw(input.messages);
						return this.finish({
							messages: replayed.replay.messages,
							facts: {
								originalToolTextBytes: rawToolTextBytes,
								finalToolTextBytes: replayed.replay.projectedToolTextBytes,
								collapsedResults: previous.transitionCollapsedResults,
								removedBundles: previous.transitionRemovedBundles,
								protectedLatestBundles: activeBundles,
							},
						}, rawToolTextBytes, rawBundles, false, false, "none", 0, 0, undefined, {
							...decision,
							eventKind: "none",
							transitionCause: "none",
							agedRawToolTextBytes: 0,
							agedRawBundles: 0,
							agedProjectedToolTextBytes: 0,
							agedProjectedBundles: 0,
							suffixRawToolTextBytes: activeToolTextBytes,
							suffixRawBundles: activeBundles,
						});
					}
					return this.sealSegment(
						input,
						analysis,
						replayed.replay,
						rawToolTextBytes,
						rawBundles,
						byteOverflow ? "hard_bytes" : "hard_bundles",
					);
				}
				invalidationCause = replayed.status;
				decision = invalidationDecision;
				invalidatedEpochHash = previous.epochHash;
				this.epochCounter = Math.max(this.epochCounter, previous.epoch);
				this.frozen = undefined;
			}

			if (rawToolTextBytes <= hardToolTextBytes && rawBundles <= hardBundles) {
				let boundaryHash: string | undefined;
				const underCapCause = invalidationCause ?? (this.legacyMigrationPending ? "legacy_migration" : undefined);
				if (underCapCause !== undefined) {
					const previousEpochHash = underCapCause === "legacy_migration"
						? EMPTY_HISTORY_HASH
						: invalidatedEpochHash;
					if (previousEpochHash === undefined) return this.failure(rawToolTextBytes, rawBundles, decision);
					const epoch = advanceHistoryProjectionEpoch(this.epochCounter);
					if (epoch === undefined) return this.failure(rawToolTextBytes, rawBundles, decision);
					this.epochCounter = epoch;
					this.legacyMigrationPending = false;
					boundaryHash = inactiveHistoryProjectionBoundaryHash({
						epoch,
						previousEpochHash,
						cause: underCapCause,
						rawHash,
						hardToolTextBytes,
						hardBundles,
						descriptorMaxBytes: effectiveDescriptorCap(input.descriptorMaxBytes),
						role: input.role,
					});
				}
				return this.finish({
					messages: Array.from(input.messages),
					facts: {
						originalToolTextBytes: rawToolTextBytes,
						finalToolTextBytes: rawToolTextBytes,
						collapsedResults: 0,
						removedBundles: 0,
						protectedLatestBundles: rawBundles,
					},
					}, rawToolTextBytes, rawBundles, boundaryHash !== undefined, false,
						underCapCause ?? "none", 0, 0, boundaryHash, {
							...decision,
							eventKind: underCapCause === undefined ? "none" : "inactive_boundary",
							transitionCause: underCapCause ?? "none",
							agedRawToolTextBytes: 0,
							agedRawBundles: 0,
							agedProjectedToolTextBytes: 0,
							agedProjectedBundles: 0,
							suffixRawToolTextBytes: rawToolTextBytes,
							suffixRawBundles: rawBundles,
						});
			}

			const cause = this.legacyMigrationPending
				? "legacy_migration"
				: invalidationCause ?? "initial_hard_limit";
			return this.checkpoint(
				input,
				analysis,
				hardToolTextBytes,
				hardBundles,
				rawToolTextBytes,
				rawBundles,
				cause,
				previousCollapsedResults,
				previousRemovedBundles,
				decision,
			);
		} catch {
			return this.failure(rawToolTextBytes, rawBundles, failureDecision);
		}
	}

	private finish(
		projection: ProjectContextHistoryResult,
		rawToolTextBytes: number,
		rawBundles: number,
		epochTransitioned: boolean,
		segmentSealed: boolean,
		transitionCause: HistoryProjectionTransitionCause,
		newlyCollapsedResults: number,
		newlyRemovedBundles: number,
		reportedBoundaryHash: string | undefined,
		observation: HistoryProjectionObservationSeed,
	): HistoryProjectionControllerResult {
		const projectedBundles = historyBundleCount(projection.messages) ?? 0;
		let reportedEpochHash = reportedBoundaryHash ?? this.frozen?.epochHash ?? null;
		let observationEventKind: HistoryProjectionEventKind = observation.eventKind;
		let observationTransitionCause: HistoryProjectionObservationCause = observation.transitionCause;
		if (transitionCause === "failure") {
			epochTransitioned = !this.failureBoundaryActive;
			this.failureBoundaryActive = true;
			reportedEpochHash = FAILURE_BOUNDARY_HASH;
		} else if (this.failureBoundaryActive) {
			this.failureBoundaryActive = false;
			epochTransitioned = true;
			reportedEpochHash ??= RECOVERY_BOUNDARY_HASH;
			observationEventKind = "recovery_boundary";
			observationTransitionCause = "recovery";
		}
		this.pressure = {
			rawToolTextBytes: Math.max(0, rawToolTextBytes),
			rawBundles: Math.max(0, rawBundles),
			projectedToolTextBytes: Math.max(0, projection.facts.finalToolTextBytes),
			projectedBundles,
		};
		return {
			...projection,
			epoch: this.frozen?.epoch ?? this.epochCounter,
			epochHash: reportedEpochHash,
			epochTransitioned,
			segmentSealed,
			segmentChainHash: this.frozen?.segmentChainHash ?? null,
			boundaryMarkers: boundaryMarkersFor(this.frozen),
			transitionCause,
			newlyCollapsedResults: Math.max(0, newlyCollapsedResults),
			newlyRemovedBundles: Math.max(0, newlyRemovedBundles),
			rawBundleCount: Math.max(0, rawBundles),
			projectedBundleCount: projectedBundles,
			observability: {
				eventKind: observationEventKind,
				transitionCause: observationTransitionCause,
				epoch: this.frozen?.epoch ?? this.epochCounter,
				epochTransitioned: epochTransitioned ? 1 : 0,
				segmentSealed: segmentSealed ? 1 : 0,
				byteOverflow: observation.byteOverflow ? 1 : 0,
				bundleOverflow: observation.bundleOverflow ? 1 : 0,
				segmentsBefore: observation.segmentsBefore,
				segmentsAfter: this.frozen?.segments.length ?? 0,
				hardToolTextBytes: observation.hardToolTextBytes,
				hardBundles: observation.hardBundles,
				rawToolTextBytes: Math.max(0, rawToolTextBytes),
				rawBundles: Math.max(0, rawBundles),
				projectedToolTextBytes: Math.max(0, projection.facts.finalToolTextBytes),
				projectedBundles,
				stableToolTextBytesBefore: observation.stableToolTextBytesBefore,
				stableBundlesBefore: observation.stableBundlesBefore,
				activeToolTextBytesBefore: observation.activeToolTextBytesBefore,
				activeBundlesBefore: observation.activeBundlesBefore,
				agedRawToolTextBytes: observation.agedRawToolTextBytes,
				agedRawBundles: observation.agedRawBundles,
				agedProjectedToolTextBytes: observation.agedProjectedToolTextBytes,
				agedProjectedBundles: observation.agedProjectedBundles,
				suffixRawToolTextBytes: observation.suffixRawToolTextBytes,
				suffixRawBundles: observation.suffixRawBundles,
			},
		};
	}
}
