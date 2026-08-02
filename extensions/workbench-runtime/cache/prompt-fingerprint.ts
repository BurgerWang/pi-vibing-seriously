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
	/** Length of each text segment (strings and text-typed content parts). */
	textSegmentLengths: number[];
	/** SHA-256 of each text segment (content is never retained). */
	textSegmentHashes: string[];
	toolCount: number;
	/** Tool names in payload order. */
	toolNames: string[];
	/** Canonical hash of payload tool schemas (name/description/parameters). */
	toolSchemaHash: string | null;
}

/** Hard caps so pathological payloads cannot stall the request path. */
const MAX_ITEMS = 20_000;
const MAX_TEXT_SEGMENTS = 10_000;
const MAX_TOOLS = 1_000;

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
		textSegmentLengths: [],
		textSegmentHashes: [],
		toolCount: 0,
		toolNames: [],
		toolSchemaHash: null,
	};
	if (!isRecord(payload)) {
		summary.apiShape = "unknown";
		return summary;
	}
	summary.topLevelFields = Object.keys(payload).sort();

	const addTextSegment = (segment: unknown): void => {
		if (summary.textSegmentLengths.length >= MAX_TEXT_SEGMENTS) return;
		if (typeof segment === "string") {
			summary.textSegmentLengths.push(segment.length);
			summary.textSegmentHashes.push(sha256Hex(segment));
			return;
		}
		if (Array.isArray(segment)) {
			for (const part of segment) {
				if (summary.textSegmentLengths.length >= MAX_TEXT_SEGMENTS) return;
				if (typeof part === "string") {
					summary.textSegmentLengths.push(part.length);
					summary.textSegmentHashes.push(sha256Hex(part));
				} else if (isRecord(part) && typeof part.text === "string") {
					// text / input_text / output_text / thinking parts all carry .text
					summary.textSegmentLengths.push(part.text.length);
					summary.textSegmentHashes.push(sha256Hex(part.text));
				}
			}
		}
	};

	if (Array.isArray(payload.messages)) {
		summary.apiShape = "chat-completions";
		for (const item of payload.messages.slice(0, MAX_ITEMS)) {
			summary.itemRoles.push(isRecord(item) && typeof item.role === "string" ? item.role : "unknown");
			if (isRecord(item)) addTextSegment(item.content);
		}
	} else if (Array.isArray(payload.input)) {
		summary.apiShape = "responses";
		for (const item of payload.input.slice(0, MAX_ITEMS)) {
			if (isRecord(item)) {
				const kind = typeof item.type === "string" ? item.type : typeof item.role === "string" ? item.role : "unknown";
				summary.itemRoles.push(kind);
				addTextSegment(item.content);
				if (typeof item.input_text === "string") addTextSegment(item.input_text);
			} else {
				summary.itemRoles.push("unknown");
			}
		}
	}

	if (Array.isArray(payload.tools)) {
		const tools = payload.tools.slice(0, MAX_TOOLS);
		summary.toolCount = tools.length;
		for (const tool of tools) {
			if (isRecord(tool)) {
				const fn = isRecord(tool.function) ? tool.function : tool;
				if (typeof fn.name === "string") summary.toolNames.push(fn.name);
			}
		}
		try {
			const schemas = tools.map((tool) => {
				if (isRecord(tool) && isRecord(tool.function)) {
					return {
						name: tool.function.name,
						description: tool.function.description,
						parameters: tool.function.parameters,
					};
				}
				return tool;
			});
			summary.toolSchemaHash = canonicalHash(schemas);
		} catch {
			summary.toolSchemaHash = null;
		}
	}
	return summary;
}

/**
 * Hash of a payload summary — the `contextShapeHash` stored per request.
 * Only structure (roles, lengths, per-segment hashes, tool names) is hashed;
 * the summary itself is in-memory only and never persisted.
 */
export function payloadShapeHash(summary: PayloadSummary): string {
	return canonicalHash(summary);
}
