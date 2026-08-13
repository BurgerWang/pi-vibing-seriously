/**
 * P6-A context fingerprints — hash-only digests of the things that determine
 * DeepSeek prompt-cache hits: the system prompt, the active tool set/order/
 * schemas, and the provider payload structure.
 *
 * Privacy contract (enforced here and audited by /q-cache-doctor):
 *   - only SHA-256 digests, lengths, names, roles and counts are produced
 *   - text CONTENT is never retained: each text segment contributes its
 *     byte length and its SHA-256 only
 *   - tool schemas contribute a canonical hash only — never the schema body
 *   - an unrecognized payload records `apiShape: "unknown"` and never throws
 *
 * Pure logic, no Pi imports.
 */

import { canonicalHash, sha256Hex } from "./canonical-hash.ts";

/** Minimal structural view of a registered tool (mirrors Pi ToolInfo). */
export interface ToolInfoLike {
	name: string;
	description?: string;
	promptSnippet?: string;
	parameters?: unknown;
	promptGuidelines?: string[] | undefined;
}

/** Hash of the system prompt string (the prompt itself is never stored). */
export function systemPromptHash(prompt: string): string {
	return sha256Hex(prompt);
}

export interface ToolFingerprint {
	/** Hash of active tool names as a SET (sorted) — detects set changes. */
	namesHash: string;
	/** Hash of active tool names in ACTIVE ORDER — detects order changes. */
	orderHash: string;
	/**
	 * Canonical hash of {name, description, promptSnippet, parameters,
	 * promptGuidelines} of the active tools in active order. `null` when
	 * hashing degraded (e.g. a schema contained a non-JSON value) —
	 * telemetry must never break.
	 */
	schemaHash: string | null;
	schemaHashDegraded: boolean;
}

/** Fingerprint the active tool set from the tool registry. */
export function fingerprintTools(activeNames: readonly string[], allTools: readonly ToolInfoLike[]): ToolFingerprint {
	const byName = new Map(allTools.map((t) => [t.name, t]));
	const ordered: ToolInfoLike[] = [];
	for (const name of activeNames) {
		const tool = byName.get(name);
		if (tool) ordered.push(tool);
	}
	const names = ordered.map((t) => t.name);
	const namesHash = canonicalHash([...names].sort());
	const orderHash = canonicalHash(names);
	try {
		const schema = ordered.map((t) => ({
			name: t.name,
			description: t.description ?? "",
			promptSnippet: t.promptSnippet ?? "",
			parameters: t.parameters ?? {},
			promptGuidelines: t.promptGuidelines ?? [],
		}));
		return { namesHash, orderHash, schemaHash: canonicalHash(schema), schemaHashDegraded: false };
	} catch {
		// Non-JSON tool metadata: degrade to the order hash, never throw.
		return { namesHash, orderHash, schemaHash: orderHash, schemaHashDegraded: true };
	}
}

export type PayloadShape = "chat-completions" | "responses" | "other" | "unknown";
export type PayloadRelationship = "UNCHANGED" | "APPEND_ONLY" | "PREFIX_REWRITTEN" | "UNKNOWN";

/**
 * Structural summary of a provider payload — the ONLY thing the workbench
 * keeps from before_provider_request. No text content survives: each text
 * segment is reduced to its length + SHA-256.
 */
export interface PayloadSummary {
	apiShape: PayloadShape;
	/** Sorted top-level field names. */
	topLevelFields: string[];
	/** role/type sequence of messages/input items. */
	itemRoles: string[];
	/** Canonical hash of each complete provider-visible item, in order. */
	itemHashes: string[];
	toolCount: number;
	/** Tool names in payload order. */
	toolNames: string[];
	/** Canonical hash of complete payload tool definitions. */
	toolSchemaHash: string | null;
	/** True when any cap, accessor, proxy or non-JSON value prevented a full digest. */
	degraded: boolean;
}

/** Hard caps so pathological payloads cannot stall the request path. */
const MAX_ITEMS = 20_000;
const MAX_TOOLS = 1_000;
const MAX_TOP_LEVEL_FIELDS = 256;
const MAX_DIGEST_DEPTH = 64;
const MAX_DIGEST_NODES = 250_000;
const MAX_DIGEST_ARRAY_ITEMS = 50_000;
const MAX_DIGEST_OBJECT_KEYS = 10_000;
const MAX_DIGEST_STRING_BYTES = 32 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract a structural summary from a provider payload. Never mutates the
 * payload, never throws, never retains text content. Unknown shapes degrade
 * to `apiShape: "unknown"`.
 */
export function summarizePayload(payload: unknown): PayloadSummary {
	const summary: PayloadSummary = {
		apiShape: "other",
		topLevelFields: [],
		itemRoles: [],
		itemHashes: [],
		toolCount: 0,
		toolNames: [],
		toolSchemaHash: canonicalHash([]),
		degraded: false,
	};
	try {
		if (!isRecord(payload)) {
			summary.apiShape = "unknown";
			summary.degraded = true;
			return summary;
		}
		const topLevelFields = Object.keys(payload).sort();
		if (topLevelFields.length > MAX_TOP_LEVEL_FIELDS) {
			summary.degraded = true;
			summary.topLevelFields = topLevelFields.slice(0, MAX_TOP_LEVEL_FIELDS);
		} else {
			summary.topLevelFields = topLevelFields;
		}

		const messages = ownDataValue(payload, "messages");
		const input = ownDataValue(payload, "input");
		let items: readonly unknown[] | undefined;
		if (Array.isArray(messages)) {
			summary.apiShape = "chat-completions";
			items = messages;
		} else if (Array.isArray(input)) {
			summary.apiShape = "responses";
			items = input;
		} else if (messages !== undefined || input !== undefined) {
			summary.apiShape = "unknown";
			summary.degraded = true;
		}

		const digestBudget: DigestBudget = { nodes: 0, seen: new WeakSet<object>() };
		if (items !== undefined) {
			if (items.length > MAX_ITEMS) summary.degraded = true;
			const itemLimit = Math.min(items.length, MAX_ITEMS);
			for (let index = 0; index < itemLimit; index += 1) {
				const item = ownArrayDataValue(items, index);
				if (!item.ok) {
					summary.degraded = true;
					break;
				}
				const digest = digestProviderValue(item.value, digestBudget, 0);
				if (!digest.ok) {
					summary.degraded = true;
					break;
				}
				summary.itemHashes.push(canonicalHash(digest.value));
				summary.itemRoles.push(itemKind(item.value));
			}
		}

		const toolsValue = ownDataValue(payload, "tools");
		if (toolsValue !== undefined) {
			if (!Array.isArray(toolsValue)) {
				summary.degraded = true;
				summary.toolSchemaHash = null;
				return summary;
			}
			summary.toolCount = toolsValue.length;
			if (toolsValue.length > MAX_TOOLS) summary.degraded = true;
			const toolLimit = Math.min(toolsValue.length, MAX_TOOLS);
			const toolDigests: unknown[] = [];
			for (let index = 0; index < toolLimit; index += 1) {
				const tool = ownArrayDataValue(toolsValue, index);
				if (!tool.ok) {
					summary.degraded = true;
					summary.toolSchemaHash = null;
					break;
				}
				const digest = digestProviderValue(tool.value, digestBudget, 0);
				if (!digest.ok) {
					summary.degraded = true;
					summary.toolSchemaHash = null;
					break;
				}
				toolDigests.push(digest.value);
				const name = toolName(tool.value);
				if (name !== undefined) summary.toolNames.push(name);
			}
			if (summary.toolSchemaHash !== null) summary.toolSchemaHash = canonicalHash(toolDigests);
		}
		return summary;
	} catch {
		return { ...summary, apiShape: "unknown", toolSchemaHash: null, degraded: true };
	}
}

interface DigestBudget {
	nodes: number;
	seen: WeakSet<object>;
}

type DigestResult = { ok: true; value: unknown } | { ok: false };

function digestProviderValue(value: unknown, budget: DigestBudget, depth: number): DigestResult {
	budget.nodes += 1;
	if (budget.nodes > MAX_DIGEST_NODES || depth > MAX_DIGEST_DEPTH) return { ok: false };
	if (value === null || typeof value === "boolean") return { ok: true, value };
	if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : { ok: false };
	if (typeof value === "string") {
		const bytes = Buffer.byteLength(value, "utf8");
		if (bytes > MAX_DIGEST_STRING_BYTES) return { ok: false };
		return { ok: true, value: { scalar: "string", bytes, sha256: sha256Hex(value) } };
	}
	if (typeof value !== "object" || value === undefined) return { ok: false };
	if (budget.seen.has(value)) return { ok: false };
	budget.seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > MAX_DIGEST_ARRAY_ITEMS) return { ok: false };
			const digested: unknown[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const item = ownArrayDataValue(value, index);
				if (!item.ok) return item;
				const nested = digestProviderValue(item.value, budget, depth + 1);
				if (!nested.ok) return nested;
				digested.push(nested.value);
			}
			return { ok: true, value: digested };
		}
		if (!isRecord(value)) return { ok: false };
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return { ok: false };
		if (Object.getOwnPropertySymbols(value).length > 0) return { ok: false };
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Object.keys(descriptors).sort();
		if (keys.length > MAX_DIGEST_OBJECT_KEYS) return { ok: false };
		const digested: Record<string, unknown> = {};
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (!descriptor || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return { ok: false };
			const nested = digestProviderValue(descriptor.value, budget, depth + 1);
			if (!nested.ok) return nested;
			digested[key] = nested.value;
		}
		return { ok: true, value: digested };
	} finally {
		budget.seen.delete(value);
	}
}

function ownDataValue(record: Record<string, unknown>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor) return undefined;
	if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) throw new Error("accessor payload field");
	return descriptor.value;
}

function ownArrayDataValue(array: readonly unknown[], index: number): { ok: true; value: unknown } | { ok: false } {
	const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
	if (!descriptor || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return { ok: false };
	return { ok: true, value: descriptor.value };
}

function itemKind(value: unknown): string {
	if (!isRecord(value)) return "unknown";
	const type = ownDataValue(value, "type");
	if (typeof type === "string" && type.length <= 128) return type;
	const role = ownDataValue(value, "role");
	return typeof role === "string" && role.length <= 128 ? role : "unknown";
}

function toolName(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const fn = ownDataValue(value, "function");
	const owner = isRecord(fn) ? fn : value;
	const name = ownDataValue(owner, "name");
	return typeof name === "string" && name.length <= 256 ? name : undefined;
}

/**
 * Hash of a payload summary — the `contextShapeHash` stored per request.
 * Only structure (roles, lengths, per-segment hashes, tool names) is hashed;
 * the summary itself is in-memory only and never persisted.
 */
export function payloadShapeHash(summary: PayloadSummary): string {
	return canonicalHash(summary);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stringPrefix(prefix: readonly string[], value: readonly string[]): boolean {
	return prefix.length <= value.length && prefix.every((entry, index) => entry === value[index]);
}

/**
 * Compare two in-memory, hash-only payload summaries. APPEND_ONLY is strict:
 * the provider API shape, top-level fields and tool surface must be stable,
 * every prior role/text digest must remain an exact prefix, and at least one
 * whole payload item must have been appended. Unknown or capped summaries
 * fail closed to UNKNOWN instead of inventing a prefix verdict.
 */
export function classifyPayloadRelationship(
	previous: PayloadSummary | undefined,
	current: PayloadSummary | undefined,
): PayloadRelationship {
	if (!previous || !current) return "UNKNOWN";
	if (
		previous.apiShape === "unknown" ||
		previous.apiShape === "other" ||
		current.apiShape === "unknown" ||
		current.apiShape === "other" ||
		previous.apiShape !== current.apiShape
	) {
		return "UNKNOWN";
	}
	if (previous.degraded || current.degraded || previous.toolSchemaHash === null || current.toolSchemaHash === null) return "UNKNOWN";

	const stableEnvelope =
		sameStrings(previous.topLevelFields, current.topLevelFields) &&
		previous.toolCount === current.toolCount &&
		sameStrings(previous.toolNames, current.toolNames) &&
		previous.toolSchemaHash === current.toolSchemaHash;
	const sameItems = sameStrings(previous.itemRoles, current.itemRoles) && sameStrings(previous.itemHashes, current.itemHashes);
	if (stableEnvelope && sameItems) return "UNCHANGED";

	const appendedWholeItem = current.itemHashes.length > previous.itemHashes.length;
	if (
		stableEnvelope &&
		appendedWholeItem &&
		stringPrefix(previous.itemRoles, current.itemRoles) &&
		stringPrefix(previous.itemHashes, current.itemHashes)
	) {
		return "APPEND_ONLY";
	}
	return "PREFIX_REWRITTEN";
}
