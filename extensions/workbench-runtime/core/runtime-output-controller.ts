/** Runtime-wide output streaming boundary and fail-closed presentation helpers. */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { projectToolResultDetails } from "./details-projection.ts";
import {
	enforceOutputEnvelope,
	enforceStreamingUpdate,
	type ImageContent as OutputImageContent,
	type OutputEnvelopeFacts,
	type OutputEnvelopeResult,
	type TextContent as OutputTextContent,
} from "./output-envelope.ts";
import { ERROR_RESULT_MAX_BYTES, resolveToolOutputPolicy } from "./output-policy.ts";

type RuntimeOutputContent = Array<OutputTextContent | OutputImageContent>;

const MAX_GUARD_REASON_BYTES = 511;
const MAX_GUARD_REASON_LINES = 4;
const GUARD_REASON_FALLBACK = "[workbench blocked]";

/** Fixed-safe guard presentation: no path, argument or exception can exceed Pi's immediate-result boundary. */
export function boundedGuardReason(value: unknown): string {
	try {
		const source = typeof value === "string" ? value : GUARD_REASON_FALLBACK;
		let result = "";
		let usedBytes = 0;
		let usedLines = 0;
		for (let index = 0; index < source.length; index += 1) {
			const unit = source.charCodeAt(index);
			let scalar: string;
			if (unit >= 0xd800 && unit <= 0xdbff) {
				const next = source.charCodeAt(index + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					scalar = source.slice(index, index + 2);
					index += 1;
				} else scalar = "\ufffd";
			} else scalar = unit >= 0xdc00 && unit <= 0xdfff ? "\ufffd" : source[index]!;
			const scalarBytes = Buffer.byteLength(scalar, "utf8");
			const nextLines = result.length === 0 ? (scalar === "\n" ? 2 : 1) : usedLines + (scalar === "\n" ? 1 : 0);
			if (usedBytes + scalarBytes > MAX_GUARD_REASON_BYTES || nextLines > MAX_GUARD_REASON_LINES) break;
			result += scalar;
			usedBytes += scalarBytes;
			usedLines = nextLines;
		}
		return result.length > 0 ? result : GUARD_REASON_FALLBACK;
	} catch {
		return GUARD_REASON_FALLBACK;
	}
}

/** Read an own DATA property without invoking a getter or proxy trap value. */
export function ownDataValue(value: unknown, key: PropertyKey): unknown {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value") ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

/** Collect assistant tool calls in source order without invoking accessors. */
export function assistantToolCalls(message: unknown): unknown[] | undefined {
	if (ownDataValue(message, "role") !== "assistant") return undefined;
	const content = ownDataValue(message, "content");
	if (!Array.isArray(content)) return [];
	const calls: unknown[] = [];
	const lengthValue = ownDataValue(content, "length");
	const length = typeof lengthValue === "number" && Number.isSafeInteger(lengthValue) && lengthValue >= 0
		? Math.min(lengthValue, 2_049)
		: 0;
	for (let index = 0; index < length; index += 1) {
		const block = ownDataValue(content, String(index));
		if (ownDataValue(block, "type") !== "toolCall") continue;
		calls.push({
			toolCallId: ownDataValue(block, "id"),
			toolName: ownDataValue(block, "name"),
			args: ownDataValue(block, "arguments"),
		});
	}
	return calls;
}

export function exactCallKey(toolCallId: unknown, toolName: unknown): string | undefined {
	if (
		typeof toolCallId !== "string" || toolCallId.length === 0 || toolCallId.length > 512
		|| typeof toolName !== "string" || toolName.length === 0 || toolName.length > 512
	) return undefined;
	return JSON.stringify([toolCallId, toolName]);
}

function streamingDetailsFailure(envelope: OutputEnvelopeFacts): Record<string, unknown> {
	return {
		details_projection: { available: false, code: "projection_error" },
		output_envelope: envelope,
	};
}

function boundedStreamingUpdate<TDetails>(
	toolName: string,
	partialResult: AgentToolResult<TDetails>,
): AgentToolResult<TDetails> {
	const content = ownDataValue(partialResult, "content");
	const details = ownDataValue(partialResult, "details");
	const envelope = enforceStreamingUpdate({ toolName, content });
	const projection = projectToolResultDetails({
		toolName,
		details,
		envelope: envelope.facts,
	});
	return {
		content: envelope.content,
		details: (projection.truncated
			? streamingDetailsFailure(envelope.facts)
			: projection.details) as TDetails,
	};
}

function wrapStreamingToolDefinition<TParams extends TSchema, TDetails, TState>(
	tool: ToolDefinition<TParams, TDetails, TState>,
	locallyBoundedStreamingUpdates: WeakSet<object>,
): ToolDefinition<TParams, TDetails, TState> {
	const execute = tool.execute;
	const toolName = tool.name;
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const boundedOnUpdate: AgentToolUpdateCallback<TDetails> | undefined = onUpdate
				? (partialResult) => {
					const bounded = boundedStreamingUpdate(toolName, partialResult);
					locallyBoundedStreamingUpdates.add(bounded);
					onUpdate(bounded);
				}
				: undefined;
			return execute.call(tool, toolCallId, params, signal, boundedOnUpdate, ctx);
		},
	};
}

function boundGlobalStreamingUpdate(event: unknown, locallyBoundedStreamingUpdates: WeakSet<object>): void {
	const partialResult = ownDataValue(event, "partialResult");
	const toolNameValue = ownDataValue(event, "toolName");
	if ((typeof partialResult !== "object" && typeof partialResult !== "function") || partialResult === null) return;
	if (locallyBoundedStreamingUpdates.delete(partialResult)) return;
	let contentDescriptor: PropertyDescriptor | undefined;
	let detailsDescriptor: PropertyDescriptor | undefined;
	try {
		contentDescriptor = Object.getOwnPropertyDescriptor(partialResult, "content");
		detailsDescriptor = Object.getOwnPropertyDescriptor(partialResult, "details");
	} catch {
		return;
	}
	if (
		!contentDescriptor || !Object.prototype.hasOwnProperty.call(contentDescriptor, "value")
		|| !detailsDescriptor || !Object.prototype.hasOwnProperty.call(detailsDescriptor, "value")
		|| (!contentDescriptor.writable && !contentDescriptor.configurable)
		|| (!detailsDescriptor.writable && !detailsDescriptor.configurable)
	) return;
	const bounded = boundedStreamingUpdate(
		typeof toolNameValue === "string" ? toolNameValue : "",
		partialResult as AgentToolResult<unknown>,
	);
	try {
		Object.defineProperties(partialResult, {
			content: { ...contentDescriptor, value: bounded.content },
			details: { ...detailsDescriptor, value: bounded.details },
		});
	} catch {
		// Pi's observation-only event API cannot safely rewrite a non-conforming object.
	}
}

const STREAMING_BOUNDARY_UNAVAILABLE = "Tool streaming output boundary is unavailable";
const MAX_STREAMING_REGISTRY_TOOLS = 4_096;
const WORKBENCH_RUNTIME_SOURCE_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
const WORKBENCH_RUNTIME_SOURCE_DIR = dirname(WORKBENCH_RUNTIME_SOURCE_PATH);
const WORKBENCH_PACKAGE_ROOT = dirname(dirname(WORKBENCH_RUNTIME_SOURCE_DIR));
const TRUSTED_PI_BUILTIN_NAMES = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);
const SOURCE_INFO_KEYS = ["baseDir", "origin", "path", "scope", "source"] as const;
const MAX_PACKAGE_SOURCE_BYTES = 4_096;

type StreamingToolTrust = "trusted" | "absent" | "unproven";

function hasExactSourceInfoKeys(value: unknown): boolean {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
	try {
		const keys = Reflect.ownKeys(value);
		if (keys.some((key) => typeof key !== "string")) return false;
		const sorted = (keys as string[]).slice().sort();
		return sorted.length === SOURCE_INFO_KEYS.length
			&& SOURCE_INFO_KEYS.every((key, index) => sorted[index] === key);
	} catch {
		return false;
	}
}

function hasAsciiControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function isExactWorkbenchSourceInfo(value: unknown): boolean {
	if (!hasExactSourceInfoKeys(value) || ownDataValue(value, "path") !== WORKBENCH_RUNTIME_SOURCE_PATH) return false;
	const source = ownDataValue(value, "source");
	const scope = ownDataValue(value, "scope");
	const origin = ownDataValue(value, "origin");
	const baseDir = ownDataValue(value, "baseDir");
	const exactTemporarySource = source === "local"
		&& scope === "temporary"
		&& origin === "top-level"
		&& baseDir === WORKBENCH_RUNTIME_SOURCE_DIR;
	const boundedPackageSource = typeof source === "string"
		&& source.length > 0
		&& source.length <= MAX_PACKAGE_SOURCE_BYTES
		&& Buffer.byteLength(source, "utf8") <= MAX_PACKAGE_SOURCE_BYTES
		&& !hasAsciiControlCharacter(source);
	const exactRepositoryPackageSource = boundedPackageSource
		&& (scope === "project" || scope === "user")
		&& origin === "package"
		&& baseDir === WORKBENCH_PACKAGE_ROOT;
	return exactTemporarySource || exactRepositoryPackageSource;
}

function isExactTrustedBuiltinSourceInfo(toolName: string, value: unknown): boolean {
	return TRUSTED_PI_BUILTIN_NAMES.has(toolName)
		&& hasExactSourceInfoKeys(value)
		&& ownDataValue(value, "path") === `<builtin:${toolName}>`
		&& ownDataValue(value, "source") === "builtin"
		&& ownDataValue(value, "scope") === "temporary"
		&& ownDataValue(value, "origin") === "top-level"
		&& ownDataValue(value, "baseDir") === undefined;
}

export interface StreamingControlPlane {
	readonly api: ExtensionAPI;
	readonly toolCallBlockReason: (toolName: unknown) => string | undefined;
}

/** Install the global streaming boundary and wrap tools registered by this runtime. */
export function streamingControlledApi(runtimePi: ExtensionAPI): StreamingControlPlane {
	const wrappedTools = new Map<string, object>();
	const locallyBoundedStreamingUpdates = new WeakSet<object>();
	runtimePi.on("tool_execution_update", (event) => {
		boundGlobalStreamingUpdate(event, locallyBoundedStreamingUpdates);
	});
	function registerBoundedTool<TParams extends TSchema, TDetails, TState>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void {
		const wrapped = wrapStreamingToolDefinition(tool, locallyBoundedStreamingUpdates);
		wrappedTools.set(tool.name, wrapped);
		runtimePi.registerTool(wrapped);
	}
	const api = new Proxy(runtimePi, {
		get(target, property) {
			if (property === "registerTool") return registerBoundedTool;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	function effectiveToolTrust(toolName: unknown): StreamingToolTrust {
		if (typeof toolName !== "string" || toolName.length === 0 || toolName.length > 512) return "unproven";
		let tools: unknown;
		try {
			tools = runtimePi.getAllTools();
		} catch {
			return "unproven";
		}
		if (!Array.isArray(tools)) return "unproven";
		const length = ownDataValue(tools, "length");
		if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > MAX_STREAMING_REGISTRY_TOOLS) {
			return "unproven";
		}
		let match: unknown;
		for (let index = 0; index < length; index += 1) {
			const candidate = ownDataValue(tools, String(index));
			const candidateName = ownDataValue(candidate, "name");
			if (typeof candidateName !== "string" || candidateName.length === 0 || candidateName.length > 512) return "unproven";
			if (candidateName !== toolName) continue;
			if (match !== undefined) return "unproven";
			match = candidate;
		}
		if (match === undefined) return "absent";
		if (wrappedTools.get(toolName) === match) return "trusted";
		const sourceInfo = ownDataValue(match, "sourceInfo");
		if (wrappedTools.has(toolName) && isExactWorkbenchSourceInfo(sourceInfo)) return "trusted";
		if (isExactTrustedBuiltinSourceInfo(toolName, sourceInfo)) return "trusted";
		return "unproven";
	}

	return {
		api,
		toolCallBlockReason(toolName) {
			return effectiveToolTrust(toolName) === "unproven" ? STREAMING_BOUNDARY_UNAVAILABLE : undefined;
		},
	};
}

export function runtimeFailureEnvelope(): OutputEnvelopeResult {
	const policy = resolveToolOutputPolicy({ toolName: "", args: undefined, role: "commander" });
	return enforceOutputEnvelope({
		toolName: "",
		content: null as unknown as RuntimeOutputContent,
		isError: true,
		policy,
		allocatedBytes: ERROR_RESULT_MAX_BYTES,
	});
}
