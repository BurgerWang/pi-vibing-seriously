import { types as utilTypes } from "node:util";

export const EXPLICIT_PROMPT_CACHE_BREAKPOINT_MAX_MARKERS = 17;

const PROMPT_CACHE_KEY_MAX_CODE_POINTS = 64;
const PROMPT_CACHE_KEY_MAX_BYTES = 256;
const MARKER_MAX_BYTES = 4_096;
const RESPONSES_INPUT_MAX_ITEMS = 4_096;
const PLAIN_DATA_MAX_ARRAY_ITEMS = 16_384;
const PLAIN_DATA_MAX_OBJECT_KEYS = 1_024;
const PLAIN_DATA_MAX_DEPTH = 32;
const PLAIN_DATA_MAX_NODES = 131_072;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_PROTOTYPE = Array.prototype;
const SUPPORTED_INPUT_ROLES = new Set(["developer", "system", "user"]);

export type ExplicitPromptCacheBreakpointNoopReason =
	| "provider_not_supported"
	| "api_not_supported"
	| "codex_experimental_disabled"
	| "model_not_supported"
	| "invalid_markers"
	| "invalid_payload"
	| "payload_model_mismatch"
	| "invalid_prompt_cache_key"
	| "invalid_input"
	| "malformed_input_text"
	| "malformed_breakpoint"
	| "unexpected_breakpoint"
	| "marker_ambiguous"
	| "marker_missing"
	| "marker_duplicate"
	| "marker_order_mismatch"
	| "already_applied";

export interface ExplicitPromptCacheBreakpointInput {
	payload: unknown;
	provider: string;
	api: string;
	modelId: string;
	allowCodexExperimental: boolean;
	expectedMarkerTexts: readonly string[];
}

export type ExplicitPromptCacheBreakpointResult =
	| {
		status: "applied";
		reason: "breakpoints_applied";
		payload: unknown;
		markerCount: number;
	}
	| {
		status: "noop";
		reason: ExplicitPromptCacheBreakpointNoopReason;
		payload: unknown;
		markerCount: number;
	};

interface PlainDataBudget {
	nodes: number;
}

interface MarkerLocation {
	itemIndex: number;
	contentIndex: number;
	position: number;
	alreadyApplied: boolean;
}

const MISSING = Symbol("missing-own-data-property");

function noop(
	payload: unknown,
	reason: ExplicitPromptCacheBreakpointNoopReason,
	markerCount = 0,
): ExplicitPromptCacheBreakpointResult {
	return { status: "noop", reason, payload, markerCount };
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function ownDataValue(value: object, key: string): unknown | typeof MISSING {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
		? descriptor.value
		: MISSING;
}

type OrdinaryDataDescriptor = PropertyDescriptor & { value: unknown };

function isOrdinaryDataDescriptor(
	descriptor: PropertyDescriptor | undefined,
	enumerable: boolean,
): descriptor is OrdinaryDataDescriptor {
	return descriptor !== undefined
		&& descriptor.enumerable === enumerable
		&& Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function isPlainData(value: unknown, budget: PlainDataBudget, active: Set<object>, depth = 0): boolean {
	if (value === null || value === undefined) return true;
	switch (typeof value) {
		case "string":
		case "boolean":
			return true;
		case "number":
			return Number.isFinite(value);
		case "bigint":
		case "function":
		case "symbol":
			return false;
		case "object":
			break;
	}
	if (depth > PLAIN_DATA_MAX_DEPTH || budget.nodes >= PLAIN_DATA_MAX_NODES) return false;
	if (utilTypes.isProxy(value)) return false;
	if (active.has(value)) return false;
	budget.nodes += 1;
	active.add(value);
	try {
		const prototype = Object.getPrototypeOf(value);
		const keys = Reflect.ownKeys(value);
		if (Array.isArray(value)) {
			if (prototype !== ARRAY_PROTOTYPE) return false;
			const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
			if (!isOrdinaryDataDescriptor(lengthDescriptor, false)
				|| typeof lengthDescriptor.value !== "number"
				|| !Number.isSafeInteger(lengthDescriptor.value)
				|| lengthDescriptor.value < 0
				|| lengthDescriptor.value > PLAIN_DATA_MAX_ARRAY_ITEMS
				|| keys.length !== lengthDescriptor.value + 1) return false;
			for (const key of keys) {
				if (typeof key !== "string") return false;
				if (key === "length") continue;
				if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
				const index = Number(key);
				if (!Number.isSafeInteger(index) || index < 0 || index >= lengthDescriptor.value) return false;
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!isOrdinaryDataDescriptor(descriptor, true)
					|| !isPlainData(descriptor.value, budget, active, depth + 1)) return false;
			}
			return true;
		}

		if (prototype !== OBJECT_PROTOTYPE || keys.length > PLAIN_DATA_MAX_OBJECT_KEYS) return false;
		for (const key of keys) {
			if (typeof key !== "string" || key.length > 256) return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!isOrdinaryDataDescriptor(descriptor, true)
				|| !isPlainData(descriptor.value, budget, active, depth + 1)) return false;
		}
		return true;
	} finally {
		active.delete(value);
	}
}

function readExpectedMarkers(value: readonly string[]): string[] | undefined {
	if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== ARRAY_PROTOTYPE) return undefined;
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
	if (!isOrdinaryDataDescriptor(lengthDescriptor, false)
		|| typeof lengthDescriptor.value !== "number"
		|| !Number.isSafeInteger(lengthDescriptor.value)
		|| lengthDescriptor.value < 1
		|| lengthDescriptor.value > EXPLICIT_PROMPT_CACHE_BREAKPOINT_MAX_MARKERS) return undefined;
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key !== "string") || keys.length !== lengthDescriptor.value + 1) return undefined;
	const output: string[] = [];
	const unique = new Set<string>();
	for (let index = 0; index < lengthDescriptor.value; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!isOrdinaryDataDescriptor(descriptor, true)
			|| typeof descriptor.value !== "string"
			|| descriptor.value.length === 0
			|| utf8Bytes(descriptor.value) > MARKER_MAX_BYTES
			|| unique.has(descriptor.value)) return undefined;
		unique.add(descriptor.value);
		output.push(descriptor.value);
	}
	return output;
}

function providerGate(input: ExplicitPromptCacheBreakpointInput): ExplicitPromptCacheBreakpointNoopReason | undefined {
	if (input.provider === "openai") {
		if (input.api !== "openai-responses") return "api_not_supported";
	} else if (input.provider === "openai-codex") {
		if (input.api !== "openai-codex-responses") return "api_not_supported";
		// The ChatGPT/Codex backend has not been live-probed for this request
		// field. Callers must keep this false by default until an explicit live
		// compatibility probe succeeds; this helper deliberately exposes no user
		// setting that could silently opt the backend in.
		if (input.allowCodexExperimental !== true) return "codex_experimental_disabled";
	} else {
		return "provider_not_supported";
	}
	if (typeof input.modelId !== "string"
		|| input.modelId.length > 128
		|| (input.modelId !== "gpt-5.6" && !input.modelId.startsWith("gpt-5.6-"))) return "model_not_supported";
	return undefined;
}

function isExactExplicitBreakpoint(value: unknown): boolean {
	if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== OBJECT_PROTOTYPE) return false;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== 1 || keys[0] !== "mode") return false;
	return ownDataValue(value, "mode") === "explicit";
}

function isMessageItem(item: Record<string, unknown>): boolean {
	const role = ownDataValue(item, "role");
	const type = ownDataValue(item, "type");
	return typeof role === "string" && (type === MISSING || type === "message");
}

function isSupportedInputTextItem(item: Record<string, unknown>): boolean {
	const role = ownDataValue(item, "role");
	return isMessageItem(item) && typeof role === "string" && SUPPORTED_INPUT_ROLES.has(role);
}

function unexpectedBreakpointExists(value: unknown, allowed: ReadonlySet<object>, active: Set<object>): boolean {
	if (value === null || typeof value !== "object") return false;
	if (active.has(value)) return true;
	active.add(value);
	try {
		if (ownDataValue(value, "prompt_cache_breakpoint") !== MISSING && !allowed.has(value)) return true;
		if (Array.isArray(value)) {
			const length = (Object.getOwnPropertyDescriptor(value, "length")?.value as number | undefined) ?? 0;
			for (let index = 0; index < length; index += 1) {
				const item = ownDataValue(value, String(index));
				if (item !== MISSING && unexpectedBreakpointExists(item, allowed, active)) return true;
			}
			return false;
		}
		for (const key of Object.keys(value)) {
			if (key === "prompt_cache_breakpoint") continue;
			const item = ownDataValue(value, key);
			if (item !== MISSING && unexpectedBreakpointExists(item, allowed, active)) return true;
		}
		return false;
	} finally {
		active.delete(value);
	}
}

/**
 * Add OpenAI Responses explicit cache breakpoints to exact, caller-proven
 * immutable marker blocks. The helper is pure and provider-gated: it never
 * guesses a nearby text block, never marks an active tail, and never enables a
 * global explicit-only mode. A structurally uncertain payload is returned by
 * identity as a no-op.
 *
 * An `applied` result proves only the outgoing request shape. OpenAI still owns
 * read-only cache eligibility and cache-hit accounting; this helper does not
 * claim that a provider cache hit occurred.
 */
export function applyExplicitPromptCacheBreakpoints(
	input: ExplicitPromptCacheBreakpointInput,
): ExplicitPromptCacheBreakpointResult {
	const payload = input?.payload;
	try {
		const gate = providerGate(input);
		if (gate) return noop(payload, gate);
		const markers = readExpectedMarkers(input.expectedMarkerTexts);
		if (!markers) return noop(payload, "invalid_markers");
		if (payload === null || typeof payload !== "object" || utilTypes.isProxy(payload)
			|| Object.getPrototypeOf(payload) !== OBJECT_PROTOTYPE
			|| !isPlainData(payload, { nodes: 0 }, new Set())) return noop(payload, "invalid_payload");

		const payloadRecord = payload as Record<string, unknown>;
		if (ownDataValue(payloadRecord, "model") !== input.modelId) return noop(payload, "payload_model_mismatch");
		const promptCacheKey = ownDataValue(payloadRecord, "prompt_cache_key");
		if (typeof promptCacheKey !== "string"
			|| Array.from(promptCacheKey).length < 1
			|| Array.from(promptCacheKey).length > PROMPT_CACHE_KEY_MAX_CODE_POINTS
			|| utf8Bytes(promptCacheKey) > PROMPT_CACHE_KEY_MAX_BYTES) return noop(payload, "invalid_prompt_cache_key");
		const inputValue = ownDataValue(payloadRecord, "input");
		if (!Array.isArray(inputValue) || inputValue.length > RESPONSES_INPUT_MAX_ITEMS) return noop(payload, "invalid_input");

		const markerIndex = new Map(markers.map((marker, index) => [marker, index] as const));
		const locations: MarkerLocation[][] = markers.map(() => []);
		const allowedExistingBreakpoints = new Set<object>();
		let position = 0;
		for (let itemIndex = 0; itemIndex < inputValue.length; itemIndex += 1) {
			const itemValue = inputValue[itemIndex];
			if (itemValue === null || typeof itemValue !== "object" || Array.isArray(itemValue)) return noop(payload, "invalid_input");
			const item = itemValue as Record<string, unknown>;
			const contentValue = ownDataValue(item, "content");
			if (contentValue === MISSING || typeof contentValue === "string") continue;
			if (!Array.isArray(contentValue)) {
				if (isMessageItem(item)) return noop(payload, "invalid_input");
				continue;
			}
			const supportedItem = isSupportedInputTextItem(item);
			for (let contentIndex = 0; contentIndex < contentValue.length; contentIndex += 1) {
				const blockValue = contentValue[contentIndex];
				if (blockValue === null || typeof blockValue !== "object" || Array.isArray(blockValue)) return noop(payload, "invalid_input");
				const block = blockValue as Record<string, unknown>;
				const type = ownDataValue(block, "type");
				const text = ownDataValue(block, "text");
				const expectedIndex = typeof text === "string" ? markerIndex.get(text) : undefined;
				if (type !== "input_text") {
					if (expectedIndex !== undefined) return noop(payload, "marker_ambiguous");
					position += 1;
					continue;
				}
				if (typeof text !== "string") return noop(payload, "malformed_input_text");
				const breakpoint = ownDataValue(block, "prompt_cache_breakpoint");
				if (expectedIndex === undefined) {
					if (breakpoint !== MISSING) return noop(payload, "unexpected_breakpoint");
					position += 1;
					continue;
				}
				if (!supportedItem) return noop(payload, "marker_ambiguous");
				if (breakpoint !== MISSING && !isExactExplicitBreakpoint(breakpoint)) return noop(payload, "malformed_breakpoint");
				if (breakpoint !== MISSING) allowedExistingBreakpoints.add(block);
				locations[expectedIndex]!.push({
					itemIndex,
					contentIndex,
					position,
					alreadyApplied: breakpoint !== MISSING,
				});
				position += 1;
			}
		}

		if (unexpectedBreakpointExists(payload, allowedExistingBreakpoints, new Set())) {
			return noop(payload, "unexpected_breakpoint");
		}
		if (locations.some((items) => items.length === 0)) return noop(payload, "marker_missing");
		if (locations.some((items) => items.length > 1)) return noop(payload, "marker_duplicate");
		for (let index = 1; index < locations.length; index += 1) {
			if (locations[index - 1]![0]!.position >= locations[index]![0]!.position) {
				return noop(payload, "marker_order_mismatch");
			}
		}
		const flatLocations = locations.map((items) => items[0]!);
		if (flatLocations.every((location) => location.alreadyApplied)) {
			return noop(payload, "already_applied", markers.length);
		}

		const clonedInput = inputValue.slice();
		const clonedItems = new Map<number, Record<string, unknown>>();
		const clonedContents = new Map<number, unknown[]>();
		for (const location of flatLocations) {
			if (location.alreadyApplied) continue;
			const sourceItem = inputValue[location.itemIndex] as Record<string, unknown>;
			let clonedItem = clonedItems.get(location.itemIndex);
			let clonedContent = clonedContents.get(location.itemIndex);
			if (!clonedItem || !clonedContent) {
				clonedItem = { ...sourceItem };
				clonedContent = (ownDataValue(sourceItem, "content") as unknown[]).slice();
				clonedItem.content = clonedContent;
				clonedInput[location.itemIndex] = clonedItem;
				clonedItems.set(location.itemIndex, clonedItem);
				clonedContents.set(location.itemIndex, clonedContent);
			}
			const sourceBlock = clonedContent[location.contentIndex] as Record<string, unknown>;
			clonedContent[location.contentIndex] = {
				...sourceBlock,
				prompt_cache_breakpoint: { mode: "explicit" },
			};
		}
		return {
			status: "applied",
			reason: "breakpoints_applied",
			payload: { ...payloadRecord, input: clonedInput },
			markerCount: markers.length,
		};
	} catch {
		return noop(payload, "invalid_payload");
	}
}
