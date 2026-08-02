/**
 * P6-B Stable Prefix Contract — pure logic, no Pi imports.
 *
 * DeepSeek's prompt cache is a FULL-PREFIX cache: a request only bills cache
 * reads when the entire prefix (system prompt + tool definitions + the
 * message history) is byte-identical to a previously cached prefix. The
 * workbench therefore splits every model-request input into two zones:
 *
 * STABLE ZONE (must hash identically within a mode and unchanged resources):
 *   - Pi's fixed system prompt
 *   - workbench static rules (AGENTS.md, project rules)
 *   - extension registration order (package.json `pi` arrays)
 *   - the current mode's fixed tool list (core/mode-policy.ts MODE_TOOLS)
 *   - tool name / label / description / schema / promptSnippet /
 *     promptGuidelines (core/tool-catalog.ts)
 *   - skill name/description metadata (Pi-discovered, static per install)
 *   - prompt template metadata (static per install)
 *
 * DYNAMIC ZONE (must NEVER enter the system prompt, tool descriptions,
 * promptSnippet or promptGuidelines — they re-hash the prefix and defeat
 * caching):
 *   - current time / date
 *   - git state (branch, commit, dirty files)
 *   - the mode's current value
 *   - task id / run id / gate id / gate status
 *   - cache usage / token counts / costs
 *   - run progress, latest artifact, warnings
 *
 * Dynamic information may only flow through the allowed dynamic channels:
 * TUI status/widget, custom session entries, tool RESULTS, telemetry
 * hash metadata (hashes of dynamic facts, never their text) and normal
 * chat messages. See docs/cache/stable-prefix-contract.md.
 *
 * Everything in this module is deterministic: stable sorts, canonical
 * hashing (cache/canonical-hash.ts) and fixed registration-order constants.
 */

import { canonicalHash, sha256Hex } from "./canonical-hash.ts";
import { fingerprintTools, type ToolInfoLike } from "./prompt-fingerprint.ts";
import type { WorkbenchMode } from "../core/mode-policy.ts";

/** Names of the stable-zone input groups (documentation constant). */
export const STABLE_ZONE_FIELDS: readonly string[] = [
	"systemPrompt",
	"staticRules",
	"extensionRegistrationOrder",
	"modeToolList",
	"toolMetadata",
	"skillMetadata",
	"promptTemplateMetadata",
] as const;

/** Names of the dynamic-zone inputs (documentation constant). */
export const DYNAMIC_ZONE_FIELDS: readonly string[] = [
	"time",
	"gitState",
	"modeValue",
	"taskId",
	"runId",
	"gateId",
	"gateStatus",
	"cacheUsage",
	"tokenCost",
	"progress",
	"latestArtifact",
	"warnings",
] as const;

/** Allowed channels for dynamic information (documentation constant). */
export const DYNAMIC_CHANNELS: readonly string[] = [
	"tuiStatusWidget",
	"customSessionEntry",
	"toolResult",
	"telemetryHashMetadata",
	"normalChatMessage",
] as const;

/**
 * Deterministic string sort — byte order via < on UTF-16 code units, with
 * an explicit tiebreak on the original index so the result is a total order
 * even for equal strings. Never locale-dependent, never readdir-order
 * dependent.
 */
export function stableSortStrings(items: readonly string[]): string[] {
	return [...items]
		.map((value, index) => ({ value, index }))
		.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : a.index - b.index))
		.map((entry) => entry.value);
}

/** Deterministic sort of objects by a string key (stable for equal keys). */
export function sortedByKey<T>(items: readonly T[], key: (item: T) => string): T[] {
	return [...items]
		.map((item, index) => ({ item, index }))
		.sort((a, b) => {
			const ka = key(a.item);
			const kb = key(b.item);
			return ka < kb ? -1 : ka > kb ? 1 : a.index - b.index;
		})
		.map((entry) => entry.item);
}

/** Sort by `name` (recipes, profiles, skills, prompt templates). */
export function sortedByName<T extends { name: string }>(items: readonly T[]): T[] {
	return sortedByKey(items, (item) => item.name);
}

/** Sort by `id` (gates). */
export function sortedById<T extends { id: string }>(items: readonly T[]): T[] {
	return sortedByKey(items, (item) => item.id);
}

/** Sort by a normalized path (skills/prompt-template discovery). */
export function sortedByPath<T extends { path: string }>(items: readonly T[]): T[] {
	return sortedByKey(items, (item) => item.path);
}

// ---------------------------------------------------------------------------
// Mode prefix fingerprint
// ---------------------------------------------------------------------------

export interface ModePrefixFingerprint {
	mode: WorkbenchMode;
	/** SHA-256 of the system prompt string (the prompt text itself is never retained). */
	systemPromptHash: string;
	/** Hash of the active tool names as a SET (sorted) — detects set changes. */
	toolNamesHash: string;
	/** Hash of the active tool names in ACTIVE ORDER — detects order changes. */
	toolOrderHash: string;
	/** Canonical hash of {name, description, parameters, promptGuidelines} in active order. */
	toolSchemaHash: string | null;
	/** Canonical hash of the whole mode prefix (mode + system prompt hash + tool fingerprint). */
	modeHash: string;
}

/**
 * Fingerprint the full STABLE PREFIX of a mode: system prompt + the mode's
 * active tool set in the mode's declared order. Deterministic: same mode,
 * same system prompt, same tool metadata => identical hashes, no matter how
 * the inputs were collected (filesystem/YAML/glob order is irrelevant here
 * because the tool order comes from the explicit MODE_TOOLS constant arrays).
 */
export function modePrefixFingerprint(
	mode: WorkbenchMode,
	systemPrompt: string,
	tools: readonly ToolInfoLike[],
	modeToolNames: readonly string[],
): ModePrefixFingerprint {
	const fingerprint = fingerprintTools(modeToolNames, tools);
	// Same definition as the telemetry systemPromptHash (prompt-fingerprint.ts).
	const systemPromptHash = sha256Hex(systemPrompt);
	const modeHash = canonicalHash({
		mode,
		systemPromptHash,
		toolNamesHash: fingerprint.namesHash,
		toolOrderHash: fingerprint.orderHash,
		toolSchemaHash: fingerprint.schemaHash,
	});
	return {
		mode,
		systemPromptHash,
		toolNamesHash: fingerprint.namesHash,
		toolOrderHash: fingerprint.orderHash,
		toolSchemaHash: fingerprint.schemaHash,
		modeHash,
	};
}

// ---------------------------------------------------------------------------
// Stable resource discovery
// ---------------------------------------------------------------------------

export interface StableResources {
	/** Skill paths or names (Pi-discovered; normalized before hashing). */
	skills?: readonly string[];
	/** Prompt template paths or names (Pi-discovered; normalized). */
	promptTemplates?: readonly string[];
	/** Gate ids. */
	gates?: readonly string[];
	/** Recipe names. */
	recipes?: readonly string[];
	/** Profile names. */
	profiles?: readonly string[];
	/** Extension names in registration order (package.json `pi` arrays). */
	extensions?: readonly string[];
}

/**
 * Canonical hash of discovered resources. Every list is deterministically
 * sorted first (by normalized path/name/id), so filesystem readdir order,
 * YAML key order, glob order and profile-file order can never change the
 * hash. Only names/ids are hashed — never file contents.
 */
export function stableResourcesHash(resources: StableResources): string {
	return canonicalHash({
		skills: stableSortStrings((resources.skills ?? []).map(normalizeResourceName)),
		promptTemplates: stableSortStrings((resources.promptTemplates ?? []).map(normalizeResourceName)),
		gates: stableSortStrings([...resources.gates ?? []]),
		recipes: stableSortStrings([...resources.recipes ?? []]),
		profiles: stableSortStrings([...resources.profiles ?? []]),
		extensions: stableSortStrings([...resources.extensions ?? []]),
	});
}

/** Normalize a resource reference (path or name) for stable comparison. */
export function normalizeResourceName(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
}

// ---------------------------------------------------------------------------
// Dynamic markers
// ---------------------------------------------------------------------------

/**
 * Dynamic-VALUE markers: patterns that can only be concrete dynamic values
 * (dates, times, timestamps, hashes, absolute paths). Used to audit tool
 * descriptions / promptSnippet / promptGuidelines — words like "run id" are
 * static labels and must NOT be flagged, only actual values.
 */
export const DYNAMIC_VALUE_MARKERS: ReadonlyArray<{ id: string; re: RegExp }> = [
	{ id: "iso-date", re: /\b\d{4}-\d{2}-\d{2}\b/ },
	{ id: "clock-time", re: /\b\d{1,2}:\d{2}(:\d{2})?\b/ },
	{ id: "unix-timestamp", re: /\b1[4-9]\d{8,9}\b/ },
	{ id: "git-commit", re: /\b[0-9a-f]{40}\b/ },
	{ id: "long-hash", re: /\b[0-9a-f]{32}\b/ },
	{ id: "absolute-path", re: /(?:^|[\s("'])(?:\/[A-Za-z0-9._-]+){2,}|[A-Za-z]:[\\/][A-Za-z0-9._-]+/ },
];

/**
 * Dynamic-LABEL markers: words that indicate dynamic state is being injected
 * ("current time", "run id", "session id", "gate status", cache/token
 * counts). Used for the system-prompt dynamics audit, where any of these
 * labels is a sign of a re-hashing prefix. Marker ids only, never content.
 */
export const DYNAMIC_LABEL_MARKERS: ReadonlyArray<{ id: string; re: RegExp }> = [
	{ id: "run-id", re: /\brun[-_ ]?id\b/i },
	{ id: "current-status", re: /\bcurrent (status|time|date|state|mode)\b/i },
	{ id: "session-id", re: /\bsession[-_ ]?id\b/i },
	{ id: "cache-tokens", re: /\bcache (read|write|hit|miss)\b/i },
	{ id: "token-count", re: /\btoken[s]? (count|usage|cost)\b/i },
	{ id: "gate-status", re: /\bgate[s]? (id|status|run)\b/i },
	{ id: "mode-value", re: /\b(?:current|active) (workbench )?mode\b/i },
];

/** All markers combined (doctor's system-prompt audit). */
export const DYNAMIC_MARKERS: ReadonlyArray<{ id: string; re: RegExp }> = [
	...DYNAMIC_VALUE_MARKERS,
	...DYNAMIC_LABEL_MARKERS,
];

/** Ids of the dynamic markers matched in a text (marker ids only, never content). */
export function matchedDynamicMarkerIds(text: string, markers: ReadonlyArray<{ id: string; re: RegExp }> = DYNAMIC_MARKERS): string[] {
	return markers.filter((marker) => marker.re.test(text)).map((marker) => marker.id);
}

/**
 * Audit stable-zone text for dynamic VALUES (tool metadata check). Returns
 * the matched marker ids (empty = static).
 */
export function findDynamicValueMarkers(text: string): string[] {
	return matchedDynamicMarkerIds(text, DYNAMIC_VALUE_MARKERS);
}

/** Validate the stable-zone metadata of a tool (description/snippet/guidelines). */
export function staticToolMetadataIssues(tool: ToolInfoLike): string[] {
	const fields: Array<[string, string]> = [
		["description", tool.description ?? ""],
		["promptSnippet", tool.promptSnippet ?? ""],
		["promptGuidelines", (tool.promptGuidelines ?? []).join("\n")],
	];
	const issues: string[] = [];
	for (const [field, text] of fields) {
		for (const markerId of findDynamicValueMarkers(text)) {
			issues.push(`${tool.name}.${field}: dynamic marker "${markerId}"`);
		}
	}
	return issues;
}

/** Convenience: fingerprint object helper kept for tests/doctor symmetry. */
export type { ToolFingerprint } from "./prompt-fingerprint.ts";
