import { types as utilTypes } from "node:util";

import { DETAILS_MAX_BYTES } from "./output-policy.ts";
import type { OutputEnvelopeFacts, OutputEnvelopeReason } from "./output-envelope.ts";
import type { ToolResultIngressProjectionMetadata } from "./tool-result-ingress-projection.ts";

/** A session-safe projection of one tool result's details payload. */
export interface DetailsProjectionResult {
	details: unknown;
	serializedBytes: number;
	truncated: boolean;
}

/** The receipt fields the runtime is allowed to persist beside a result. */
export interface BoundedReceiptFacts {
	available: boolean;
	code?: string;
	result_id?: string;
	tool?: string;
	status?: string;
	path?: string;
}

export interface ProjectToolResultDetailsInput {
	toolName: string;
	details: unknown;
	envelope: OutputEnvelopeFacts;
	receipt?: BoundedReceiptFacts;
	ingressProjection?: ToolResultIngressProjectionMetadata;
}

const MAX_DEPTH = 4;
const MAX_OBJECT_KEYS = 32;
const MAX_ARRAY_ITEMS = 32;
const MAX_STRING_BYTES = 512;
const MAX_KEY_BYTES = 128;
const OBJECT_OMITTED_KEY = "details_projection_omitted_keys";

const SECURITY_KEYS = new Set(["output_envelope", "receipt", "ingress_projection"]);
const FORBIDDEN_KEYS = new Set([
	"record",
	"gates_full",
	"report",
	"review",
	"diff",
	"patch",
	"stdout",
	"stderr",
	"deltas",
]);

const POLICY_IDS = new Set([
	"native-read-page", "native-search", "run-summary", "run-log-page", "gate-summary", "gate-read",
	"diff-review", "compare", "worker-handoff", "recovery", "default",
]);
const ENVELOPE_REASONS = new Set<OutputEnvelopeReason | string>([
	"none", "per-tool-cap", "turn-reservation", "runtime-failure",
]);
const INGRESS_SOURCE_KINDS = new Set([
	"finalized_recipe_run", "executed_gate_run", "immutable_comparison",
	"completed_worker_report", "finalized_run_page", "run_id_gate_page",
]);
const INGRESS_METADATA_FIELDS = [
	"schema", "sourceKind", "sourcePath", "sourceIdentityKind", "sourceIdentityHash",
	"authorityHash", "projectionHash", "originalBytes", "projectedBytes", "bodyShownBytes",
	"omittedBytes", "budgetBytes", "requiredFactCount",
] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const TRUSTED_BUILTIN_TOOL_NAMES = new Set(["bash", "edit", "write"]);
/** Bash's nested native DTO excludes `content`: model-visible content is already bounded separately. */
const BASH_TRUNCATION_FIELDS = [
	"truncated", "truncatedBy", "totalLines", "totalBytes", "outputLines", "outputBytes",
	"lastLinePartial", "firstLineExceedsLimit", "maxLines", "maxBytes",
] as const;

/** Fixed root DTO fields for every registered workbench tool and trusted Pi builtin. */
const TOOL_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	bash: ["truncation", "fullOutputPath"],
	edit: ["firstChangedLine"],
	write: [],
	read: [
		"schema", "code", "complete", "start_line", "shown_lines", "shown_bytes", "start_byte",
		"end_exclusive", "line_segment", "source_id", "next_cursor", "truncation",
	],
	grep: ["match_count", "shown_count", "omitted_count", "path", "pattern"],
	find: ["match_count", "shown_count", "omitted_count", "path", "pattern"],
	ls: ["entry_count", "shown_count", "omitted_count", "path"],
	workbench_project_inspect: [
		"project_root", "effective_project_root", "git", "stacks", "profile", "recipes",
		"recipe_validation_components", "config_errors", "config_files_present",
	],
	workbench_run_recipe: [
		"ok", "run_id", "recipe", "status", "exit_code", "duration_ms", "artifact_paths", "stdout_log",
		"stderr_log", "expected_exit_codes", "cache", "validation_components", "cache_request_mode", "phase",
		"error", "blocked_reason",
	],
	workbench_read_run: [
		"run_id", "recipe", "kind", "status", "exit_code", "duration_ms", "profile", "mode", "started_at",
		"finished_at", "git_commit", "git_dirty", "artifact_paths", "stdout_log", "stderr_log", "validation",
		"include", "log_stream", "shown_lines", "shown_bytes", "remaining_lines", "remaining_bytes", "next_cursor",
	],
	workbench_run_gate: [
		"ok", "status", "run_id", "requested", "profile", "gates", "counts", "log_path", "phase", "error",
		"blocked_reason", "preflight", "selector", "manual_evidence_ready", "required_manual_checks",
		"provided_manual_evidence", "missing_manual_evidence", "gate_run_created", "recipes_executed",
		"gate_status_assigned",
	],
	workbench_read_gate: [
		"run_id", "gate_id", "latest_status", "latest_run", "gates", "include", "shown_count", "remaining_count",
		"next_cursor", "source_path", "error",
	],
	workbench_list_gates: ["gate_count", "shown_count", "omitted_count", "statuses", "source_path", "error"],
	workbench_compare_runs: [
		"ok", "comparison_id", "a_run_id", "b_run_id", "compatible", "artifact_added_count",
		"artifact_removed_count", "gate_changed_count", "quant_changed_count", "parameter_changed_count",
		"comparison_path", "error",
	],
	workbench_delegate_worker: [
		"delegation_id", "status", "report_path", "changed_paths", "provider", "model", "turns", "exit_code",
		"stop_reason", "usage", "cache_hit_ratio", "max_context_tokens", "max_context_ratio",
		"soft_budget_reached", "hard_budget_exceeded", "compaction_count", "compaction_reasons", "review_status",
		"failure_message", "spend", "phase", "totalTokens", "outputTokens", "spendBand",
	],
	workbench_review_worker_diff: [
		"ok", "delegation_id", "verdict", "review_status", "bound_diff_hash", "recorded_after_hash", "mismatch",
		"violation_count", "drift_count", "checked_count", "displayed_count", "remaining_count", "coverage_complete",
		"review_record", "next_include_paths", "patch_truncated", "error", "latest_delegation_id", "transaction_status",
		"next_action", "repair_of",
	],
	workbench_delegation_status: ["git_refresh", "actor", "write_policy", "lease_status", "review_status"],
	workbench_recover_tool_result: [
		"ok", "available", "code", "result_id", "tool", "status", "path", "summary_omitted_lines",
		"summary_omitted_bytes",
	],
});

interface ArrayProjectionFacts {
	originalItems: number;
	shownItems: number;
}

interface ObjectProjectionFacts {
	originalKeys: number;
	shownKeys: number;
}

interface SanitizeState {
	active: WeakSet<object>;
	truncated: boolean;
	arrayFacts: WeakMap<unknown[], ArrayProjectionFacts>;
	objectFacts: WeakMap<object, ObjectProjectionFacts>;
}

interface FitResult {
	available: boolean;
	value?: unknown;
}

function createSanitizeState(): SanitizeState {
	return {
		active: new WeakSet<object>(),
		truncated: false,
		arrayFacts: new WeakMap<unknown[], ArrayProjectionFacts>(),
		objectFacts: new WeakMap<object, ObjectProjectionFacts>(),
	};
}

function utf8Bytes(value: string): number { return Buffer.byteLength(value, "utf8"); }

function unicodeScalarText(value: string): string {
	let output = "";
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) { output += value.slice(index, index + 2); index += 1; }
			else output += "\ufffd";
		} else if (unit >= 0xdc00 && unit <= 0xdfff) output += "\ufffd";
		else output += value[index];
	}
	return output;
}

function utf8Prefix(value: string, maxBytes: number): string {
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

function boundedString(value: string, state: SanitizeState, maxBytes = MAX_STRING_BYTES): string {
	const normalized = unicodeScalarText(value);
	const bounded = utf8Prefix(normalized, maxBytes);
	if (bounded !== value) state.truncated = true;
	return bounded;
}

function defineData(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function descriptorsOf(value: object): PropertyDescriptorMap {
	// `util.types.isProxy` is a Node-internal brand check. Unlike reflective
	// inspection, it does not invoke ownKeys/getOwnPropertyDescriptor/get/getPrototypeOf
	// traps. A Proxy anywhere in a selected details value fails the projection.
	if (utilTypes.isProxy(value)) throw new Error("proxy details are not inspectable");
	return Object.getOwnPropertyDescriptors(value);
}

function dataDescriptorValue(descriptors: PropertyDescriptorMap, key: string): { found: boolean; value?: unknown; accessor?: boolean } {
	const descriptor = descriptors[key];
	if (!descriptor || descriptor.enumerable !== true) return { found: false };
	if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) return { found: true, accessor: true };
	return { found: true, value: descriptor.value };
}

function forbiddenKey(key: string): boolean {
	return key === OBJECT_OMITTED_KEY || SECURITY_KEYS.has(key) || FORBIDDEN_KEYS.has(key.toLowerCase());
}

function arrayOmissionMarker(originalItems: number, shownItems: number): Record<string, number> {
	return {
		original_items: originalItems,
		shown_items: shownItems,
		omitted_items: originalItems - shownItems,
	};
}

function buildArrayProjection(
	items: readonly unknown[],
	originalItems: number,
	shownItems: number,
	state: SanitizeState,
): unknown[] {
	const output = items.slice(0, shownItems);
	if (shownItems < originalItems) output.push(arrayOmissionMarker(originalItems, shownItems));
	state.arrayFacts.set(output, { originalItems, shownItems });
	return output;
}

function buildObjectProjection(
	entries: readonly (readonly [string, unknown])[],
	originalKeys: number,
	shownKeys: number,
	state: SanitizeState,
): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	for (const [key, value] of entries.slice(0, shownKeys)) defineData(output, key, value);
	if (shownKeys < originalKeys) defineData(output, OBJECT_OMITTED_KEY, originalKeys - shownKeys);
	state.objectFacts.set(output, { originalKeys, shownKeys });
	return output;
}

function sanitizeValue(value: unknown, depth: number, state: SanitizeState): unknown {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") return boundedString(value, state);
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		state.truncated = true;
		return value === Infinity ? "Infinity" : value === -Infinity ? "-Infinity" : "NaN";
	}
	if (typeof value === "bigint") {
		state.truncated = true;
		return boundedString(`${value.toString()}n`, state);
	}
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
		if (typeof value === "function" && utilTypes.isProxy(value)) throw new Error("proxy details are not inspectable");
		state.truncated = true;
		return "[unsupported]";
	}
	if (utilTypes.isProxy(value)) throw new Error("proxy details are not inspectable");
	if (depth >= MAX_DEPTH) { state.truncated = true; return "[depth_limit]"; }

	const object = value as object;
	try {
		if (state.active.has(object)) { state.truncated = true; return "[circular]"; }
		state.active.add(object);
	} catch {
		state.truncated = true;
		return "[unavailable]";
	}
	try {
		const descriptors = descriptorsOf(object);
		if (Array.isArray(value)) {
			const lengthDescriptor = descriptors.length;
			const rawLength = lengthDescriptor && Object.prototype.hasOwnProperty.call(lengthDescriptor, "value")
				? lengthDescriptor.value
				: 0;
			const length = typeof rawLength === "number" && Number.isSafeInteger(rawLength) && rawLength >= 0 ? rawLength : 0;
			const shown = length > MAX_ARRAY_ITEMS ? MAX_ARRAY_ITEMS - 1 : Math.min(length, MAX_ARRAY_ITEMS);
			const items: unknown[] = [];
			for (let index = 0; index < shown; index += 1) {
				const item = dataDescriptorValue(descriptors, String(index));
				items.push(item.accessor ? "[unavailable_accessor]" : sanitizeValue(item.found ? item.value : undefined, depth + 1, state));
				if (item.accessor) state.truncated = true;
			}
			if (length > shown) state.truncated = true;
			return buildArrayProjection(items, length, shown, state);
		}

		const rawKeys = Object.keys(descriptors)
			.filter((key) => key !== "length" && descriptors[key]?.enumerable === true && !forbiddenKey(key))
			.sort();
		const omittedForbidden = Object.keys(descriptors).some((key) => descriptors[key]?.enumerable === true && forbiddenKey(key));
		if (omittedForbidden) state.truncated = true;
		const inspectCount = rawKeys.length > MAX_OBJECT_KEYS ? MAX_OBJECT_KEYS - 1 : rawKeys.length;
		const entries: Array<readonly [string, unknown]> = [];
		for (const key of rawKeys.slice(0, inspectCount)) {
			const boundedKey = utf8Prefix(key, MAX_KEY_BYTES);
			if (boundedKey !== key || entries.some(([acceptedKey]) => acceptedKey === boundedKey)) { state.truncated = true; continue; }
			const item = dataDescriptorValue(descriptors, key);
			if (item.accessor) { entries.push([boundedKey, "[unavailable_accessor]"]); state.truncated = true; }
			else entries.push([boundedKey, sanitizeValue(item.value, depth + 1, state)]);
		}
		if (rawKeys.length > entries.length) state.truncated = true;
		return buildObjectProjection(entries, rawKeys.length, entries.length, state);
	} finally {
		try { state.active.delete(object); } catch { /* already fail-closed */ }
	}
}

/** Project a selected nested DTO without allowing arbitrary child keys through the generic sanitizer. */
function sanitizeWhitelistedObject(
	value: unknown,
	fields: readonly string[],
	depth: number,
	state: SanitizeState,
): Record<string, unknown> {
	if ((typeof value !== "object" && typeof value !== "function") || value === null || Array.isArray(value)) {
		state.truncated = true;
		return {};
	}
	if (utilTypes.isProxy(value)) throw new Error("proxy details are not inspectable");
	if (depth >= MAX_DEPTH) { state.truncated = true; return {}; }
	const object = value as object;
	if (state.active.has(object)) { state.truncated = true; return {}; }
	state.active.add(object);
	try {
		const descriptors = descriptorsOf(object);
		const output: Record<string, unknown> = {};
		for (const field of fields) {
			const item = dataDescriptorValue(descriptors, field);
			if (!item.found) continue;
			if (item.accessor) { defineData(output, field, "[unavailable_accessor]"); state.truncated = true; }
			else defineData(output, field, sanitizeValue(item.value, depth + 1, state));
		}
		for (const key of Object.keys(descriptors)) {
			if (descriptors[key]?.enumerable === true && !fields.includes(key)) state.truncated = true;
		}
		const projectedKeys = Object.keys(output).length;
		state.objectFacts.set(output, { originalKeys: projectedKeys, shownKeys: projectedKeys });
		return output;
	} finally {
		state.active.delete(object);
	}
}

function rootProjection(toolName: string, details: unknown, state: SanitizeState): Record<string, unknown> {
	const fields = Object.prototype.hasOwnProperty.call(TOOL_FIELDS, toolName) ? TOOL_FIELDS[toolName] : undefined;
	if (!fields) {
		const generic = sanitizeValue(details, 0, state);
		if (generic && typeof generic === "object" && !Array.isArray(generic)) return generic as Record<string, unknown>;
		return buildObjectProjection([["details_value", generic]], 1, 1, state);
	}
	if (details === undefined && TRUSTED_BUILTIN_TOOL_NAMES.has(toolName)) {
		const output: Record<string, unknown> = {};
		state.objectFacts.set(output, { originalKeys: 0, shownKeys: 0 });
		return output;
	}
	if ((typeof details !== "object" && typeof details !== "function") || details === null || Array.isArray(details)) {
		state.truncated = true;
		return {};
	}
	const descriptors = descriptorsOf(details as object);
	const output: Record<string, unknown> = {};
	for (const field of fields) {
		const item = dataDescriptorValue(descriptors, field);
		if (!item.found) continue;
		if (item.accessor) { defineData(output, field, "[unavailable_accessor]"); state.truncated = true; }
		else {
			const projected = toolName === "bash" && field === "truncation"
				? sanitizeWhitelistedObject(item.value, BASH_TRUNCATION_FIELDS, 1, state)
				: sanitizeValue(item.value, 1, state);
			defineData(output, field, projected);
		}
	}
	for (const key of Object.keys(descriptors)) {
		if (descriptors[key]?.enumerable === true && !fields.includes(key)) state.truncated = true;
	}
	if (toolName === "workbench_review_worker_diff") addReviewCounts(output, descriptors, state);
	const projectedKeys = Object.keys(output).length;
	state.objectFacts.set(output, { originalKeys: projectedKeys, shownKeys: projectedKeys });
	return output;
}

function arrayLengthFromDescriptor(descriptors: PropertyDescriptorMap, key: string): number | undefined {
	const item = dataDescriptorValue(descriptors, key);
	if (!item.found || item.accessor || !Array.isArray(item.value)) return undefined;
	const arrayDescriptors = descriptorsOf(item.value);
	const length = arrayDescriptors.length?.value;
	return typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

function addReviewCounts(output: Record<string, unknown>, descriptors: PropertyDescriptorMap, state: SanitizeState): void {
	const mappings = [
		["violations", "violation_count"], ["drift_paths", "drift_count"], ["checked_paths", "checked_count"],
		["displayed_paths", "displayed_count"], ["remaining_paths", "remaining_count"],
	] as const;
	for (const [source, target] of mappings) {
		if (Object.prototype.hasOwnProperty.call(output, target)) continue;
		const length = arrayLengthFromDescriptor(descriptors, source);
		if (length !== undefined) defineData(output, target, length);
	}
	if (!Object.prototype.hasOwnProperty.call(output, "next_include_paths")) {
		const remaining = dataDescriptorValue(descriptors, "remaining_paths");
		if (remaining.found && !remaining.accessor && Array.isArray(remaining.value)) {
			defineData(output, "next_include_paths", sanitizeValue(remaining.value, 1, state));
		}
	}
}

function safeNonNegativeInteger(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function ownData(value: unknown, key: string): unknown {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
	const descriptors = descriptorsOf(value as object);
	const item = dataDescriptorValue(descriptors, key);
	return item.found && !item.accessor ? item.value : undefined;
}

function normalizeEnvelope(value: OutputEnvelopeFacts, state: SanitizeState): Record<string, unknown> {
	const policyValue = ownData(value, "policy");
	const reasonValue = ownData(value, "reason");
	const output: Record<string, unknown> = {
		schema: "workbench-output-v1",
		policy: typeof policyValue === "string" && POLICY_IDS.has(policyValue) ? policyValue : "default",
		truncated: ownData(value, "truncated") === true,
		originalTextBytes: safeNonNegativeInteger(ownData(value, "originalTextBytes")),
		originalTextLines: safeNonNegativeInteger(ownData(value, "originalTextLines")),
		shownTextBytes: safeNonNegativeInteger(ownData(value, "shownTextBytes")),
		shownTextLines: safeNonNegativeInteger(ownData(value, "shownTextLines")),
		omittedTextBytes: safeNonNegativeInteger(ownData(value, "omittedTextBytes")),
		omittedTextLines: safeNonNegativeInteger(ownData(value, "omittedTextLines")),
		originalImageCount: safeNonNegativeInteger(ownData(value, "originalImageCount")),
		shownImageCount: safeNonNegativeInteger(ownData(value, "shownImageCount")),
		omittedImageCount: safeNonNegativeInteger(ownData(value, "omittedImageCount")),
		reason: typeof reasonValue === "string" && ENVELOPE_REASONS.has(reasonValue) ? reasonValue : "runtime-failure",
	};
	const continuation = ownData(value, "continuation");
	if (continuation && typeof continuation === "object") {
		const kind = ownData(continuation, "kind");
		const cursor = ownData(continuation, "value");
		if (typeof kind === "string" && typeof cursor === "string") {
			output.continuation = { kind: boundedString(kind, state), value: boundedString(cursor, state) };
		}
	}
	return output;
}

function normalizeReceipt(value: BoundedReceiptFacts | undefined, state: SanitizeState): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	const output: Record<string, unknown> = { available: ownData(value, "available") === true };
	for (const field of ["code", "result_id", "tool", "status", "path"] as const) {
		const candidate = ownData(value, field);
		if (typeof candidate === "string") defineData(output, field, boundedString(candidate, state));
	}
	return output;
}

function normalizeIngressProjection(
	value: ToolResultIngressProjectionMetadata | undefined,
	state: SanitizeState,
): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	const descriptors = descriptorsOf(value);
	const keys = Object.keys(descriptors);
	if (keys.length !== INGRESS_METADATA_FIELDS.length
		|| keys.some((key) => !INGRESS_METADATA_FIELDS.includes(key as (typeof INGRESS_METADATA_FIELDS)[number]))) {
		state.truncated = true;
		return undefined;
	}
	for (const field of INGRESS_METADATA_FIELDS) {
		const descriptor = descriptors[field];
		if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
			state.truncated = true;
			return undefined;
		}
	}
	const schema = ownData(value, "schema");
	const sourceKind = ownData(value, "sourceKind");
	const sourcePath = ownData(value, "sourcePath");
	const sourceIdentityKind = ownData(value, "sourceIdentityKind");
	const sourceIdentityHash = ownData(value, "sourceIdentityHash");
	const authorityHash = ownData(value, "authorityHash");
	const projectionHash = ownData(value, "projectionHash");
	const originalBytes = ownData(value, "originalBytes");
	const projectedBytes = ownData(value, "projectedBytes");
	const bodyShownBytes = ownData(value, "bodyShownBytes");
	const omittedBytes = ownData(value, "omittedBytes");
	const budgetBytes = ownData(value, "budgetBytes");
	const requiredFactCount = ownData(value, "requiredFactCount");
	if (schema !== "workbench-tool-result-ingress-metadata-v1"
		|| typeof sourceKind !== "string" || !INGRESS_SOURCE_KINDS.has(sourceKind)
		|| typeof sourcePath !== "string" || utf8Bytes(sourcePath) > 512 || sourcePath.length === 0
		|| sourcePath.startsWith("/") || sourcePath.includes("\\") || !sourcePath.startsWith(".pi/workbench/")
		|| (sourceIdentityKind !== "digest" && sourceIdentityKind !== "snapshot")
		|| typeof sourceIdentityHash !== "string" || !SHA256_PATTERN.test(sourceIdentityHash)
		|| typeof authorityHash !== "string" || !SHA256_PATTERN.test(authorityHash)
		|| typeof projectionHash !== "string" || !SHA256_PATTERN.test(projectionHash)
		|| !Number.isSafeInteger(originalBytes) || (originalBytes as number) < 0
		|| !Number.isSafeInteger(projectedBytes) || (projectedBytes as number) < 0 || (projectedBytes as number) > 4_096
		|| !Number.isSafeInteger(bodyShownBytes) || (bodyShownBytes as number) < 0 || (bodyShownBytes as number) > (originalBytes as number)
		|| !Number.isSafeInteger(omittedBytes) || (omittedBytes as number) !== (originalBytes as number) - (bodyShownBytes as number)
		|| budgetBytes !== 4_096
		|| !Number.isSafeInteger(requiredFactCount) || (requiredFactCount as number) < 1 || (requiredFactCount as number) > 16) {
		state.truncated = true;
		return undefined;
	}
	return {
		schema,
		sourceKind,
		sourcePath,
		sourceIdentityKind,
		sourceIdentityHash,
		authorityHash,
		projectionHash,
		originalBytes,
		projectedBytes,
		bodyShownBytes,
		omittedBytes,
		budgetBytes,
		requiredFactCount,
	};
}

function arrayFacts(value: unknown[], state: SanitizeState): ArrayProjectionFacts {
	const recorded = state.arrayFacts.get(value);
	if (recorded) return recorded;
	return { originalItems: value.length, shownItems: value.length };
}

function objectFacts(value: Record<string, unknown>, state: SanitizeState): ObjectProjectionFacts {
	const recorded = state.objectFacts.get(value);
	if (recorded) return recorded;
	const entries = Object.entries(value).filter(([key]) => key !== OBJECT_OMITTED_KEY);
	const omitted = safeNonNegativeInteger(value[OBJECT_OMITTED_KEY]);
	return { originalKeys: entries.length + omitted, shownKeys: entries.length };
}

function minimumProjection(value: unknown, state: SanitizeState): unknown {
	if (Array.isArray(value)) {
		const facts = arrayFacts(value, state);
		return buildArrayProjection([], facts.originalItems, 0, state);
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const facts = objectFacts(record, state);
		return buildObjectProjection([], facts.originalKeys, 0, state);
	}
	return value;
}

function fitValue(value: unknown, state: SanitizeState, fits: (candidate: unknown) => boolean): FitResult {
	if (fits(value)) return { available: true, value };
	state.truncated = true;
	if (Array.isArray(value)) return fitArray(value, state, fits);
	if (value !== null && typeof value === "object") {
		return fitObject(value as Record<string, unknown>, state, fits);
	}
	return { available: false };
}

function fitArray(value: unknown[], state: SanitizeState, fits: (candidate: unknown) => boolean): FitResult {
	const facts = arrayFacts(value, state);
	const dataItems = value.slice(0, Math.min(facts.shownItems, value.length));
	let keepItems = dataItems.length;
	let fittedItems: unknown[] | undefined;

	for (; keepItems >= 0; keepItems -= 1) {
		const minima = dataItems.slice(0, keepItems).map((item) => minimumProjection(item, state));
		const skeleton = buildArrayProjection(minima, facts.originalItems, keepItems, state);
		if (fits(skeleton)) {
			fittedItems = minima;
			break;
		}
	}
	if (!fittedItems) {
		if (facts.originalItems > 0) state.truncated = true;
		return { available: false };
	}
	if (keepItems < facts.originalItems) state.truncated = true;
	const acceptedItems = fittedItems;

	for (let index = 0; index < keepItems; index += 1) {
		const fitted = fitValue(dataItems[index], state, (candidate) => {
			const next = acceptedItems.slice();
			next[index] = candidate;
			return fits(buildArrayProjection(next, facts.originalItems, keepItems, state));
		});
		if (fitted.available) acceptedItems[index] = fitted.value;
	}
	return {
		available: true,
		value: buildArrayProjection(acceptedItems, facts.originalItems, keepItems, state),
	};
}

function fitObject(
	value: Record<string, unknown>,
	state: SanitizeState,
	fits: (candidate: unknown) => boolean,
): FitResult {
	const facts = objectFacts(value, state);
	const dataEntries = Object.entries(value)
		.filter(([key]) => key !== OBJECT_OMITTED_KEY)
		.slice(0, facts.shownKeys);
	let keepKeys = dataEntries.length;
	let fittedValues: unknown[] | undefined;

	for (; keepKeys >= 0; keepKeys -= 1) {
		const minima = dataEntries.slice(0, keepKeys).map(([, item]) => minimumProjection(item, state));
		const entries = dataEntries.slice(0, keepKeys).map(([key], index) => [key, minima[index]] as const);
		const skeleton = buildObjectProjection(entries, facts.originalKeys, keepKeys, state);
		if (fits(skeleton)) {
			fittedValues = minima;
			break;
		}
	}
	if (!fittedValues) {
		if (facts.originalKeys > 0) state.truncated = true;
		return { available: false };
	}
	if (keepKeys < facts.originalKeys) state.truncated = true;
	const acceptedValues: unknown[] = fittedValues;

	for (let index = 0; index < keepKeys; index += 1) {
		const entry = dataEntries[index];
		if (!entry) continue;
		const fitted = fitValue(entry[1], state, (candidate) => {
			const next = acceptedValues.slice();
			next[index] = candidate;
			const entries = dataEntries.slice(0, keepKeys).map(([key], entryIndex) => [key, next[entryIndex]] as const);
			return fits(buildObjectProjection(entries, facts.originalKeys, keepKeys, state));
		});
		if (fitted.available) acceptedValues[index] = fitted.value;
	}
	const entries = dataEntries.slice(0, keepKeys).map(([key], index) => [key, acceptedValues[index]] as const);
	return {
		available: true,
		value: buildObjectProjection(entries, facts.originalKeys, keepKeys, state),
	};
}

function mergeBounded(
	ordinary: Record<string, unknown>,
	envelope: Record<string, unknown>,
	receipt: Record<string, unknown> | undefined,
	ingressProjection: Record<string, unknown> | undefined,
	state: SanitizeState,
): DetailsProjectionResult {
	const security: Record<string, unknown> = {};
	defineData(security, "output_envelope", envelope);
	if (receipt) defineData(security, "receipt", receipt);
	if (ingressProjection) defineData(security, "ingress_projection", ingressProjection);
	const attachSecurity = (candidate: Record<string, unknown>): Record<string, unknown> => {
		const combined: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(candidate)) {
			if (SECURITY_KEYS.has(key)) { state.truncated = true; continue; }
			defineData(combined, key, value);
		}
		for (const [key, value] of Object.entries(security)) defineData(combined, key, value);
		return combined;
	};
	const fitted = fitObject(ordinary, state, (candidate) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
		return utf8Bytes(JSON.stringify(attachSecurity(candidate as Record<string, unknown>))) <= DETAILS_MAX_BYTES;
	});
	const acceptedOrdinary = fitted.available
		? fitted.value as Record<string, unknown>
		: buildObjectProjection([], objectFacts(ordinary, state).originalKeys, 0, state);
	const accepted = attachSecurity(acceptedOrdinary);
	const serializedBytes = utf8Bytes(JSON.stringify(accepted));
	if (serializedBytes > DETAILS_MAX_BYTES) throw new Error("trusted metadata exceeds details bound");
	return { details: accepted, serializedBytes, truncated: state.truncated };
}

function failureProjection(
	envelope: Record<string, unknown>,
	receipt: Record<string, unknown> | undefined,
	ingressProjection: Record<string, unknown> | undefined,
): DetailsProjectionResult {
	const details: Record<string, unknown> = {
		details_projection: { available: false, code: "projection_error" },
		output_envelope: envelope,
		...(receipt ? { receipt } : {}),
		...(ingressProjection ? { ingress_projection: ingressProjection } : {}),
	};
	return { details, serializedBytes: utf8Bytes(JSON.stringify(details)), truncated: true };
}

/**
 * Project one live tool-result details object into the bounded session DTO.
 * Ordinary details can never provide output_envelope, receipt, or
 * ingress_projection facts: those fields are rebuilt solely from the
 * separately supplied trusted arguments.
 */
export function projectToolResultDetails(input: ProjectToolResultDetailsInput): DetailsProjectionResult {
	const state = createSanitizeState();
	let envelope: Record<string, unknown> = normalizeEnvelope({} as OutputEnvelopeFacts, state);
	let receipt: Record<string, unknown> | undefined;
	let ingressProjection: Record<string, unknown> | undefined;
	try {
		envelope = normalizeEnvelope(input.envelope, state);
		receipt = normalizeReceipt(input.receipt, state);
		ingressProjection = normalizeIngressProjection(input.ingressProjection, state);
		const toolName = typeof input.toolName === "string" ? utf8Prefix(input.toolName, MAX_STRING_BYTES) : "";
		const ordinary = rootProjection(toolName, input.details, state);
		return mergeBounded(ordinary, envelope, receipt, ingressProjection, state);
	} catch {
		return failureProjection(envelope, receipt, ingressProjection);
	}
}

/**
 * Generic bounded projection for the offline legacy-session sanitizer.
 * It deliberately does not mint output_envelope or receipt security facts.
 */
export function projectLegacyDetails(details: unknown): DetailsProjectionResult {
	const state = createSanitizeState();
	try {
		const value = sanitizeValue(details, 0, state);
		const ordinary = value && typeof value === "object" && !Array.isArray(value)
			? value as Record<string, unknown>
			: buildObjectProjection([["details_value", value]], 1, 1, state);
		const fitted = fitObject(ordinary, state, (candidate) => utf8Bytes(JSON.stringify(candidate)) <= DETAILS_MAX_BYTES);
		const accepted = fitted.available
			? fitted.value as Record<string, unknown>
			: buildObjectProjection([], objectFacts(ordinary, state).originalKeys, 0, state);
		return { details: accepted, serializedBytes: utf8Bytes(JSON.stringify(accepted)), truncated: state.truncated };
	} catch {
		const fallback = { details_projection: { available: false, code: "projection_error" } };
		return { details: fallback, serializedBytes: utf8Bytes(JSON.stringify(fallback)), truncated: true };
	}
}
