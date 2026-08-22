import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
	COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
	HISTORY_DESCRIPTOR_MAX_BYTES,
	HISTORY_MAX_BUNDLES,
	HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES,
	HISTORY_PROJECTION_ENTRY_TYPE,
	HISTORY_PROJECTION_EVENT_KINDS,
	HISTORY_PROJECTION_MAX_EPOCH,
	HISTORY_PROJECTION_MAX_SEGMENTS,
	HISTORY_PROJECTION_OBSERVATION_CAUSES,
	HISTORY_PROJECTION_SEGMENT_MAX_BUNDLES,
	HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES,
	HistoryProjectionController,
	OTHER_HISTORY_TOOL_TEXT_MAX_BYTES,
	WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
	collapseHistoricalToolResult,
	historyProjectionFailureMessages,
	historyToolTextBytes,
	projectContextHistory,
	safeHistoryProjectionFailureMessages,
	validateContextToolPairing,
	type AgentMessage,
} from "../extensions/workbench-runtime/core/context-history-budget.ts";
import {
	COMMANDER_TURN_MAX_BYTES,
	WORKER_TURN_MAX_BYTES,
} from "../extensions/workbench-runtime/core/output-policy.ts";
import { convertToLlm } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";

interface CallInput {
	id: string;
	name?: string;
}

let nextTimestamp = 1;

function asMessage(value: unknown): AgentMessage {
	return value as AgentMessage;
}

function assistant(calls: readonly CallInput[], extraContent: unknown[] = []): AgentMessage {
	return asMessage({
		role: "assistant",
		content: [
			...extraContent,
			...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name ?? `tool_${call.id}`, arguments: {} })),
		],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: nextTimestamp++,
	});
}

function result(
	id: string,
	text: string,
	options: { name?: string; isError?: boolean; images?: number; details?: unknown } = {},
): AgentMessage {
	return asMessage({
		role: "toolResult",
		toolCallId: id,
		toolName: options.name ?? `tool_${id}`,
		content: [
			{ type: "text", text },
			...Array.from({ length: options.images ?? 0 }, (_, index) => ({ type: "image", data: `image-${index}`, mimeType: "image/png" })),
		],
		details: options.details,
		isError: options.isError === true,
		timestamp: nextTimestamp++,
	});
}

function user(text: string): AgentMessage {
	return asMessage({ role: "user", content: text, timestamp: nextTimestamp++ });
}

function bundle(id: string, text: string, extraContent: unknown[] = []): AgentMessage[] {
	return [assistant([{ id }], extraContent), result(id, text)];
}

function batchBundle(prefix: string, sizes: readonly number[]): AgentMessage[] {
	const calls = sizes.map((_, index) => ({ id: `${prefix}-${index}`, name: `tool_${prefix}_${index}` }));
	return [
		assistant(calls),
		...sizes.map((size, index) => result(calls[index]!.id, String(index).repeat(size), { name: calls[index]!.name })),
	];
}

function trustedDetails(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		...extra,
		output_envelope: {
			schema: "workbench-output-v1",
			policy: "default",
			truncated: false,
			originalTextBytes: 1,
			originalTextLines: 1,
			shownTextBytes: 1,
			shownTextLines: 1,
			omittedTextBytes: 0,
			omittedTextLines: 0,
			originalImageCount: 0,
			shownImageCount: 0,
			omittedImageCount: 0,
			reason: "none",
		},
	};
}

const ingressCases = [
	{
		sourceKind: "finalized_recipe_run",
		toolName: "workbench_run_recipe",
		sourcePath: ".pi/workbench/runs/20260814-180000-recp/summary.json",
		requiredFactCount: 5,
	},
	{
		sourceKind: "executed_gate_run",
		toolName: "workbench_run_gate",
		sourcePath: ".pi/workbench/runs/20260814-180001-gate/gates.json",
		requiredFactCount: 3,
	},
	{
		sourceKind: "immutable_comparison",
		toolName: "workbench_compare_runs",
		sourcePath: `.pi/workbench/comparisons/cmp1-${"a".repeat(64)}/comparison.json`,
		requiredFactCount: 4,
	},
	{
		sourceKind: "completed_worker_report",
		toolName: "workbench_delegate_worker",
		sourcePath: ".pi/workbench/delegations/20260814-180002-work/worker-report.md",
		requiredFactCount: 4,
	},
	{
		sourceKind: "finalized_run_page",
		toolName: "workbench_read_run",
		sourcePath: ".pi/workbench/runs/20260814-180003-page/stdout.log",
		requiredFactCount: 4,
	},
	{
		sourceKind: "run_id_gate_page",
		toolName: "workbench_read_gate",
		sourcePath: ".pi/workbench/runs/20260814-180004-gate/gates.json",
		requiredFactCount: 3,
	},
] as const;

function ingressMetadata(
	input: (typeof ingressCases)[number],
	originalBytes: number,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schema: "workbench-tool-result-ingress-metadata-v1",
		sourceKind: input.sourceKind,
		sourcePath: input.sourcePath,
		sourceIdentityKind: "snapshot",
		sourceIdentityHash: "1".repeat(64),
		authorityHash: "2".repeat(64),
		projectionHash: "3".repeat(64),
		originalBytes,
		projectedBytes: originalBytes,
		bodyShownBytes: originalBytes,
		omittedBytes: 0,
		budgetBytes: 4_096,
		requiredFactCount: input.requiredFactCount,
		...overrides,
	};
}

function project(
	messages: readonly AgentMessage[],
	overrides: Partial<Parameters<typeof projectContextHistory>[0]> = {},
) {
	return projectContextHistory({
		messages,
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker",
		...overrides,
	});
}

function textOf(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	return content
		.filter((block): block is { type: "text"; text: string } => (
			block !== null && typeof block === "object"
			&& (block as { type?: unknown }).type === "text"
			&& typeof (block as { text?: unknown }).text === "string"
		))
		.map((block) => block.text)
		.join("\n");
}

function resultById(messages: readonly AgentMessage[], id: string): AgentMessage | undefined {
	return messages.find((message) => (
		(message as { role?: unknown }).role === "toolResult"
		&& (message as { toolCallId?: unknown }).toolCallId === id
	));
}

function callBundleCount(messages: readonly AgentMessage[]): number {
	return messages.filter((message) => {
		if ((message as { role?: unknown }).role !== "assistant") return false;
		const content = (message as { content?: unknown }).content;
		return Array.isArray(content) && content.some((block) => (
			block !== null && typeof block === "object" && (block as { type?: unknown }).type === "toolCall"
		));
	}).length;
}

function hasLoneSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return true;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
	}
	return false;
}

function providerMessages(messages: readonly AgentMessage[]): unknown[] {
	return convertToLlm(Array.from(messages)) as unknown[];
}

function jsonNormalizedProviderMessages(messages: readonly AgentMessage[]): unknown[] {
	return JSON.parse(JSON.stringify(providerMessages(messages))) as unknown[];
}

function commonProviderPrefixLength(left: readonly unknown[], right: readonly unknown[]): number {
	const count = Math.min(left.length, right.length);
	let index = 0;
	while (index < count && JSON.stringify(left[index]) === JSON.stringify(right[index])) index += 1;
	return index;
}

function v2EpochHash(state: Record<string, unknown>): string {
	return createHash("sha256").update([
		"workbench-history-epoch-v2",
		"epoch", "hardToolTextBytes", "hardBundles", "descriptorMaxBytes", "anchorToolTextBytes", "anchorBundles",
		"anchorRawMessageCount", "anchorRawHash", "anchorProjectedMessageCount", "anchorProjectedHash",
		"anchorProjectedToolTextBytes", "anchorProjectedBundles", "sealedTailRawMessageCount", "sealedTailRawHash",
		"sealedTailToolTextBytes", "sealedTailBundles", "sealedTailProjectedMessageCount", "sealedTailProjectedHash",
		"sealedTailProjectedToolTextBytes", "sealedTailProjectedBundles",
	].map((key) => key === "workbench-history-epoch-v2" ? key : String(state[key])).join("\n")).digest("hex");
}

type SerializedV3ProjectionState = ReturnType<HistoryProjectionController["serialize"]>;

function v3SliceHashLines(slice: SerializedV3ProjectionState["anchor"]): string[] {
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

function v3StateHash(state: SerializedV3ProjectionState): string {
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
		...v3SliceHashLines(state.anchor),
		String(state.segments.length),
		...state.segments.flatMap((segment) => v3SliceHashLines(segment)),
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

function resignV3ProjectionEpoch(
	state: SerializedV3ProjectionState,
	epoch: number,
): SerializedV3ProjectionState {
	const signed = structuredClone(state);
	signed.epoch = epoch;
	signed.epochHash = createHash("sha256").update([
		"workbench-history-epoch-v3",
		String(signed.epoch),
		String(signed.hardToolTextBytes),
		String(signed.hardBundles),
		String(signed.descriptorMaxBytes),
		String(signed.anchorToolTextBytes),
		String(signed.anchorBundles),
		...v3SliceHashLines(signed.anchor),
	].join("\n")).digest("hex");
	const chain = createHash("sha256");
	chain.update("workbench-history-segment-chain-v3\n");
	chain.update(signed.epochHash);
	for (const segment of signed.segments) {
		chain.update("\nsegment\n");
		chain.update(v3SliceHashLines(segment).join("\n"));
	}
	signed.segmentChainHash = chain.digest("hex");
	signed.stateHash = v3StateHash(signed);
	return signed;
}

test("under-cap history is returned unchanged without mutating the input", () => {
	const messages: AgentMessage[] = [
		user("keep-user"),
		assistant([{ id: "a", name: "read" }, { id: "b", name: "grep" }], [{ type: "text", text: "keep-assistant" }]),
		result("b", "grep-result", { name: "grep" }),
		result("a", "read-result", { name: "read" }),
		asMessage({ role: "custom", customType: "keep", content: "keep-custom", display: false, timestamp: nextTimestamp++ }),
	];
	const before = structuredClone(messages);
	const projected = project(messages);
	assert.deepEqual(messages, before);
	assert.deepEqual(projected.messages, messages);
	assert.notEqual(projected.messages, messages);
	assert.equal(projected.facts.originalToolTextBytes, Buffer.byteLength("grep-resultread-result"));
	assert.equal(projected.facts.finalToolTextBytes, projected.facts.originalToolTextBytes);
	assert.equal(projected.facts.collapsedResults, 0);
	assert.equal(projected.facts.removedBundles, 0);
	assert.equal(projected.facts.protectedLatestBundles, 1);
	assert.equal(validateContextToolPairing(projected.messages), true);
});

test("role and caller limits are downward-only from 192/128/64 KiB hard ceilings", () => {
	const oneHundredSixtyKiB = "x".repeat(160 * 1_024);
	const messages = bundle("large", oneHundredSixtyKiB);
	const commander = project(messages, { role: "commander", maxToolTextBytes: Number.MAX_SAFE_INTEGER });
	assert.equal(historyToolTextBytes(commander.messages), 160 * 1_024);
	assert.ok(historyToolTextBytes(commander.messages) <= COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES);

	for (const role of ["worker", "other", "future-role"] as const) {
		const bounded = project(messages, { role, maxToolTextBytes: Number.MAX_SAFE_INTEGER });
		const expectedCap = role === "worker"
			? WORKER_HISTORY_TOOL_TEXT_MAX_BYTES
			: OTHER_HISTORY_TOOL_TEXT_MAX_BYTES;
		assert.ok(historyToolTextBytes(bounded.messages) <= expectedCap, role);
		assert.doesNotMatch(textOf(resultById(bounded.messages, "large")!), /^x+$/);
	}

	const lowered = project(messages, { role: "commander", maxToolTextBytes: 128, descriptorMaxBytes: 10_000 });
	assert.ok(historyToolTextBytes(lowered.messages) <= 128);
	assert.ok(Buffer.byteLength(textOf(resultById(lowered.messages, "large")!), "utf8") <= HISTORY_DESCRIPTOR_MAX_BYTES);
	assert.equal(validateContextToolPairing(lowered.messages), true);
});

test("1000 old bundles collapse then delete whole bundles while keeping latest batches paired", () => {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 1_000; index += 1) {
		messages.push(...bundle(`bulk-${index}`, `${index}:`.padEnd(220, "x")));
	}
	const before = structuredClone(messages);
	const projected = project(messages, { maxToolTextBytes: 64 * 1_024, maxBundles: 99_999 });
	assert.deepEqual(messages, before);
	assert.equal(validateContextToolPairing(projected.messages), true);
	assert.ok(historyToolTextBytes(projected.messages) <= 64 * 1_024);
	assert.ok(callBundleCount(projected.messages) <= HISTORY_MAX_BUNDLES);
	assert.ok(projected.facts.removedBundles >= 872);
	assert.equal(projected.facts.protectedLatestBundles, 2);
	assert.match(textOf(resultById(projected.messages, "bulk-998")!), /^998:/);
	assert.match(textOf(resultById(projected.messages, "bulk-999")!), /^999:/);
	const omission = projected.messages.find((message) => (
		(message as { role?: unknown }).role === "custom"
		&& (message as { customType?: unknown }).customType === "workbench-history-projection"
	));
	assert.ok(omission);
	const details = (omission as { details?: Record<string, unknown> }).details!;
	assert.ok(Object.values(details).every((value) => typeof value === "number"));
});

test("multi-call batches pair by exact id rather than result position", () => {
	const messages = [
		assistant([
			{ id: "first", name: "read" },
			{ id: "second", name: "grep" },
			{ id: "third", name: "find" },
		]),
		result("third", "C", { name: "find" }),
		result("first", "A", { name: "read" }),
		result("second", "B", { name: "grep" }),
	];
	assert.equal(validateContextToolPairing(messages), true);
	assert.equal(validateContextToolPairing([messages[0]!, messages[2]!, messages[1]!, messages[3]!]), true);
	assert.equal(project(messages).facts.protectedLatestBundles, 1);
});

test("duplicate, orphan, cross-batch and tool-name mismatch histories fail closed", () => {
	const latest = bundle("latest-valid", "LATEST-SAFE");
	const cases: Array<[string, AgentMessage[]]> = [
		["duplicate-call", [
			...bundle("dup", "duplicate-secret-one"),
			...bundle("dup", "duplicate-secret-two"),
			...latest,
		]],
		["orphan", [
			result("orphan", "orphan-secret"),
			...latest,
		]],
		["cross-batch", [
			assistant([{ id: "cross-a" }]),
			assistant([{ id: "cross-b" }]),
			result("cross-a", "cross-secret-a"),
			result("cross-b", "cross-secret-b"),
			...latest,
		]],
		["tool-name-mismatch", [
			assistant([{ id: "mismatch", name: "read" }]),
			result("mismatch", "mismatch-secret", { name: "grep" }),
			...latest,
		]],
		["duplicate-result", [
			assistant([{ id: "repeat" }]),
			result("repeat", "repeat-secret-one"),
			result("repeat", "repeat-secret-two"),
			...latest,
		]],
	];
	for (const [name, messages] of cases) {
		assert.equal(validateContextToolPairing(messages), false, name);
		const projected = project(messages, { maxToolTextBytes: 1_024 });
		assert.equal(validateContextToolPairing(projected.messages), true, name);
		assert.ok(historyToolTextBytes(projected.messages) <= 1_024, name);
		assert.equal(textOf(resultById(projected.messages, "latest-valid")!), "LATEST-SAFE", name);
		assert.doesNotMatch(projected.messages.map(textOf).join("\n"), /secret/, name);
		assert.equal(projected.messages.some((message) => (
			(message as { customType?: unknown }).customType === "workbench-history-projection-failure"
		)), true, name);
	}
});

test("the newest two raw bundles are protected only when their combined text fits", () => {
	const twoFit = [
		...bundle("old", "o".repeat(6_000)),
		...bundle("recent-a", "A".repeat(900)),
		...bundle("recent-b", "B".repeat(900)),
	];
	const protectedTwo = project(twoFit, { maxToolTextBytes: 2_000, descriptorMaxBytes: 100 });
	assert.equal(protectedTwo.facts.protectedLatestBundles, 2);
	assert.equal(textOf(resultById(protectedTwo.messages, "recent-a")!), "A".repeat(900));
	assert.equal(textOf(resultById(protectedTwo.messages, "recent-b")!), "B".repeat(900));
	assert.ok(historyToolTextBytes(protectedTwo.messages) <= 2_000);

	const onlyLatestFits = [
		...bundle("older", "o".repeat(3_000)),
		...bundle("middle", "M".repeat(1_500)),
		...bundle("newest", "N".repeat(1_200)),
	];
	const protectedOne = project(onlyLatestFits, { maxToolTextBytes: 2_000, descriptorMaxBytes: 100 });
	assert.equal(protectedOne.facts.protectedLatestBundles, 1);
	assert.equal(textOf(resultById(protectedOne.messages, "newest")!), "N".repeat(1_200));
	assert.notEqual(textOf(resultById(protectedOne.messages, "middle")!), "M".repeat(1_500));
	assert.ok(historyToolTextBytes(protectedOne.messages) <= 2_000);
});

test("an oversized latest multi-call bundle keeps its exact structure but collapses within tiny caps", () => {
	const messages = [
		user("ordinary-message"),
		assistant([{ id: "huge-a", name: "read" }, { id: "huge-b", name: "grep" }]),
		result("huge-a", "RAW-A-SECRET".repeat(20_000), { name: "read" }),
		result("huge-b", "RAW-B-SECRET".repeat(20_000), { name: "grep" }),
	];
	for (const cap of [512, 17, 1, 0]) {
		const projected = project(messages, { maxToolTextBytes: cap, descriptorMaxBytes: 10_000 });
		assert.equal(validateContextToolPairing(projected.messages), true, `cap=${cap}`);
		assert.ok(historyToolTextBytes(projected.messages) <= cap, `cap=${cap}`);
		assert.ok(resultById(projected.messages, "huge-a"), `cap=${cap}`);
		assert.ok(resultById(projected.messages, "huge-b"), `cap=${cap}`);
		assert.doesNotMatch(projected.messages.map(textOf).join("\n"), /RAW-[AB]-SECRET/, `cap=${cap}`);
		assert.equal(projected.messages.some((message) => textOf(message) === "ordinary-message"), true);
		assert.equal(projected.messages.some((message) => (
			(message as { customType?: unknown }).customType === "workbench-history-projection"
		)), true, `cap=${cap}`);
	}
});

test("descriptors sanitize UTF-8 and controls, omit images/raw text, and never exceed 384 bytes", () => {
	const message = result("descriptor", "RAW-DESCRIPTOR-SECRET🙂\ud800", {
		name: "evil\nname\u0000🙂".repeat(20),
		isError: true,
		images: 2,
		details: { source_path: ".pi/run\nforged=marker/🙂".repeat(20) },
	});
	const collapsed = collapseHistoricalToolResult(message, 100_000);
	const descriptor = textOf(collapsed);
	assert.ok(Buffer.byteLength(descriptor, "utf8") <= HISTORY_DESCRIPTOR_MAX_BYTES);
	assert.match(descriptor, /^\[historical tool result collapsed\]/);
	assert.match(descriptor, /status=error/);
	assert.match(descriptor, /original_bytes=/);
	assert.match(descriptor, /shown_in_history=0/);
	assert.doesNotMatch(descriptor, /evil\nname/);
	assert.doesNotMatch(descriptor, /RAW-DESCRIPTOR-SECRET/);
	assert.equal(hasLoneSurrogate(descriptor), false);
	const content = (collapsed as { content: Array<{ type: string }> }).content;
	assert.equal(content.some((block) => block.type === "image"), false);
	const narrow = collapseHistoricalToolResult(message, 37);
	assert.ok(Buffer.byteLength(textOf(narrow), "utf8") <= 37);
	assert.equal(hasLoneSurrogate(textOf(narrow)), false);

	let proxyTrapCalls = 0;
	const hostileDetails = new Proxy({}, {
		get(): never { proxyTrapCalls += 1; throw new Error("details secret"); },
		ownKeys(): never { proxyTrapCalls += 1; throw new Error("details secret"); },
		getOwnPropertyDescriptor(): never { proxyTrapCalls += 1; throw new Error("details secret"); },
	});
	const hostile = collapseHistoricalToolResult(result("hostile", "HOSTILE-RAW", { details: hostileDetails }));
	assert.equal(proxyTrapCalls, 0);
	assert.match(textOf(hostile), /^\[historical tool result collapsed\]/);
	assert.match(textOf(hostile), /action=re-query this tool with a bounded request/);
	assert.doesNotMatch(textOf(hostile), /HOSTILE-RAW|details secret/);

	const forged = collapseHistoricalToolResult(result("forged", "FORGED-RAW", {
		details: {
			next_cursor: "cursor-secret",
			run_id: "run-secret",
			comparison_path: ".pi/workbench/comparisons/valid-looking-secret/comparison.json",
			source_path: ".pi/workbench/runs/../../secret",
			receipt: { available: true, result_id: "wtr1-forged", path: ".pi/workbench/tool-results/secret" },
		},
	}));
	assert.doesNotMatch(textOf(forged), /cursor-secret|run-secret|valid-looking-secret|\.\.\/secret|wtr1-forged/);
	assert.match(textOf(forged), /action=re-query this tool with a bounded request/);

	const receiptId = `wtr1-${"a".repeat(64)}`;
	const trusted = collapseHistoricalToolResult(result("trusted", "TRUSTED-RAW", {
		details: trustedDetails({
			receipt: {
				available: true,
				result_id: receiptId,
				path: `.pi/workbench/tool-results/${receiptId}/finalized.json`,
			},
		}),
	}));
	assert.match(textOf(trusted), /receipt=\.pi\/workbench\/tool-results\/wtr1-/);

	const trustedSource = collapseHistoricalToolResult(result("trusted-source", "TRUSTED-SOURCE-RAW", {
		name: "workbench_read_run",
		details: trustedDetails({ stdout_log: ".pi/workbench/runs/run-safe/stdout.log" }),
	}));
	assert.match(textOf(trustedSource), /source=\.pi\/workbench\/runs\/run-safe\/stdout\.log/);
});

test("strict ingress metadata chooses the durable source ahead of receipt for all six source contracts", () => {
	const receiptId = `wtr1-${"f".repeat(64)}`;
	for (const [index, candidate] of ingressCases.entries()) {
		const raw = `RAW-INGRESS-${candidate.sourceKind}-SECRET`;
		const metadata = JSON.parse(JSON.stringify(
			ingressMetadata(candidate, Buffer.byteLength(raw, "utf8")),
		)) as Record<string, unknown>;
		const collapsed = collapseHistoricalToolResult(result(`ingress-${index}`, raw, {
			name: candidate.toolName,
			details: trustedDetails({
				ingress_projection: metadata,
				receipt: {
					available: true,
					result_id: receiptId,
					path: `.pi/workbench/tool-results/${receiptId}/finalized.json`,
				},
			}),
		}));
		const descriptor = textOf(collapsed);
		const lines = descriptor.split("\n");
		assert.equal(lines.length, 4, candidate.sourceKind);
		assert.equal(lines[3], `source=${candidate.sourcePath}`, candidate.sourceKind);
		assert.doesNotMatch(descriptor, /receipt=|RAW-INGRESS|source_kind=|authority_hash=|projection_hash=/);
		assert.doesNotMatch(descriptor, /1111111111111111|2222222222222222|3333333333333333/);
	}
});

test("malformed ingress metadata fails closed while bounded plain-data failures preserve receipt and legacy fallbacks", () => {
	const candidate = ingressCases[4];
	const raw = "RAW-MALFORMED-INGRESS-SECRET";
	const valid = ingressMetadata(candidate, Buffer.byteLength(raw, "utf8"));
	const malformed: unknown[] = [
		{ ...valid, schema: "foreign-v1" },
		{ ...valid, sourceKind: "unknown_source" },
		{ ...valid, sourceIdentityKind: "foreign" },
		{ ...valid, sourceIdentityHash: "short" },
		{ ...valid, authorityHash: "A".repeat(64) },
		{ ...valid, projectionHash: "short" },
		{ ...valid, sourcePath: "/home/operator/raw.log" },
		{ ...valid, sourcePath: ".pi/workbench/runs/../secret.log" },
		{ ...valid, sourcePath: ingressCases[2].sourcePath },
		{ ...valid, projectedBytes: 4_097 },
		{ ...valid, bodyShownBytes: (valid.originalBytes as number) + 1 },
		{ ...valid, omittedBytes: 1 },
		{ ...valid, budgetBytes: 4_095 },
		{ ...valid, requiredFactCount: 3 },
		{ ...valid, unexpected: true },
		new Date(0),
	];
	const hiddenExtra = { ...valid };
	Object.defineProperty(hiddenExtra, "hidden", { value: true, enumerable: false });
	malformed.push(hiddenExtra);
	for (const [index, metadata] of malformed.entries()) {
		const collapsed = collapseHistoricalToolResult(result(`malformed-${index}`, raw, {
			name: candidate.toolName,
			details: trustedDetails({ ingress_projection: metadata }),
		}));
		const descriptor = textOf(collapsed);
		assert.match(descriptor, /action=re-query this tool with a bounded request/, `case=${index}`);
		assert.doesNotMatch(descriptor, /source=|receipt=|RAW-MALFORMED|1111111111111111|2222222222222222|3333333333333333/);
	}

	const wrongTool = collapseHistoricalToolResult(result("wrong-tool", raw, {
		name: "workbench_run_recipe",
		details: trustedDetails({ ingress_projection: valid }),
	}));
	assert.match(textOf(wrongTool), /action=re-query this tool with a bounded request/);
	assert.doesNotMatch(textOf(wrongTool), /source=/);

	const receiptId = `wtr1-${"d".repeat(64)}`;
	const receiptFallback = collapseHistoricalToolResult(result("receipt-fallback", raw, {
		name: candidate.toolName,
		details: trustedDetails({
			ingress_projection: { ...valid, unexpected: true },
			receipt: {
				available: true,
				result_id: receiptId,
				path: `.pi/workbench/tool-results/${receiptId}/finalized.json`,
			},
		}),
	}));
	assert.match(textOf(receiptFallback), /receipt=\.pi\/workbench\/tool-results\/wtr1-/);
	assert.doesNotMatch(textOf(receiptFallback), /source=/);

	const legacyPath = ".pi/workbench/runs/20260814-180099-legacy/stdout.log";
	const legacyFallback = collapseHistoricalToolResult(result("legacy-fallback", raw, {
		name: candidate.toolName,
		details: trustedDetails({
			ingress_projection: { ...valid, schema: "foreign-v1" },
			stdout_log: legacyPath,
		}),
	}));
	assert.match(textOf(legacyFallback), new RegExp(`source=${legacyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.doesNotMatch(textOf(legacyFallback), /RAW-MALFORMED|1111111111111111|2222222222222222|3333333333333333/);
});

test("hostile ingress metadata executes no proxy or accessor traps and emits no recovery pointer", () => {
	const candidate = ingressCases[4];
	const raw = "RAW-HOSTILE-INGRESS-SECRET";
	const valid = ingressMetadata(candidate, Buffer.byteLength(raw, "utf8"));

	let wholeDetailsProxyTrapCalls = 0;
	const wholeDetailsProxy = new Proxy(trustedDetails({ ingress_projection: valid }), {
		get(): never { wholeDetailsProxyTrapCalls += 1; throw new Error("whole details proxy get"); },
		ownKeys(): never { wholeDetailsProxyTrapCalls += 1; throw new Error("whole details proxy ownKeys"); },
		getOwnPropertyDescriptor(): never {
			wholeDetailsProxyTrapCalls += 1;
			throw new Error("whole details proxy descriptor");
		},
	});
	const wholeDetailsProxied = collapseHistoricalToolResult(result("hostile-whole-details-proxy", raw, {
		name: candidate.toolName,
		details: wholeDetailsProxy,
	}));
	assert.equal(wholeDetailsProxyTrapCalls, 0);
	assert.match(textOf(wholeDetailsProxied), /action=re-query this tool with a bounded request/);
	assert.doesNotMatch(textOf(wholeDetailsProxied), /source=|receipt=|RAW-HOSTILE|whole details proxy/);

	let wholeDetailsAccessorCalls = 0;
	const wholeDetailsAccessor = trustedDetails();
	Object.defineProperty(wholeDetailsAccessor, "ingress_projection", {
		enumerable: true,
		configurable: true,
		get(): never {
			wholeDetailsAccessorCalls += 1;
			throw new Error("whole details ingress accessor");
		},
	});
	const wholeDetailsAccessed = collapseHistoricalToolResult(result("hostile-whole-details-accessor", raw, {
		name: candidate.toolName,
		details: wholeDetailsAccessor,
	}));
	assert.equal(wholeDetailsAccessorCalls, 0);
	assert.match(textOf(wholeDetailsAccessed), /action=re-query this tool with a bounded request/);
	assert.doesNotMatch(textOf(wholeDetailsAccessed), /source=|receipt=|RAW-HOSTILE|whole details ingress/);

	const oversizedDetails = trustedDetails({ ingress_projection: valid });
	for (let index = 0; index < 18; index += 1) {
		oversizedDetails[`padding_${index}`] = "x".repeat(500);
	}
	const oversized = collapseHistoricalToolResult(result("oversized-whole-details", raw, {
		name: candidate.toolName,
		details: oversizedDetails,
	}));
	assert.match(textOf(oversized), /action=re-query this tool with a bounded request/);
	assert.doesNotMatch(textOf(oversized), /source=|receipt=|RAW-HOSTILE|1111111111111111|2222222222222222|3333333333333333/);

	let proxyTrapCalls = 0;
	const proxy = new Proxy(valid, {
		get(): never { proxyTrapCalls += 1; throw new Error("ingress proxy get"); },
		ownKeys(): never { proxyTrapCalls += 1; throw new Error("ingress proxy ownKeys"); },
		getOwnPropertyDescriptor(): never { proxyTrapCalls += 1; throw new Error("ingress proxy descriptor"); },
	});
	const proxied = collapseHistoricalToolResult(result("hostile-proxy", raw, {
		name: candidate.toolName,
		details: trustedDetails({ ingress_projection: proxy }),
	}));
	assert.equal(proxyTrapCalls, 0);
	assert.match(textOf(proxied), /action=re-query this tool with a bounded request/);
	assert.doesNotMatch(textOf(proxied), /source=|receipt=|RAW-HOSTILE/);

	let accessorCalls = 0;
	const accessor = { ...valid };
	Object.defineProperty(accessor, "sourcePath", {
		enumerable: true,
		configurable: true,
		get(): never { accessorCalls += 1; throw new Error("ingress sourcePath accessor"); },
	});
	const accessed = collapseHistoricalToolResult(result("hostile-accessor", raw, {
		name: candidate.toolName,
		details: trustedDetails({ ingress_projection: accessor }),
	}));
	assert.equal(accessorCalls, 0);
	assert.match(textOf(accessed), /action=re-query this tool with a bounded request/);
	assert.doesNotMatch(textOf(accessed), /source=|receipt=|RAW-HOSTILE/);

	const symbol = { ...valid } as Record<PropertyKey, unknown>;
	Object.defineProperty(symbol, Symbol("hidden"), { value: "secret", enumerable: true });
	const symbolized = collapseHistoricalToolResult(result("hostile-symbol", raw, {
		name: candidate.toolName,
		details: trustedDetails({ ingress_projection: symbol }),
	}));
	assert.match(textOf(symbolized), /action=re-query this tool with a bounded request/);
	assert.doesNotMatch(textOf(symbolized), /source=|receipt=|RAW-HOSTILE|secret/);
});

test("Commander, worker, and unknown roles collapse ingress-backed history identically", () => {
	const candidate = ingressCases[0];
	const raw = "ROLE-RAW-SECRET".repeat(100);
	const messages = [
		assistant([{ id: "role-old", name: candidate.toolName }]),
		result("role-old", raw, {
			name: candidate.toolName,
			details: trustedDetails({
				ingress_projection: ingressMetadata(candidate, Buffer.byteLength(raw, "utf8")),
			}),
		}),
		...bundle("role-latest", "latest"),
	];
	const descriptors = (["commander", "worker", "other"] as const).map((role) => {
		const projected = project(messages, {
			role,
			maxToolTextBytes: 300,
			maxBundles: 2,
		});
		assert.equal(validateContextToolPairing(projected.messages), true, role);
		const descriptor = textOf(resultById(projected.messages, "role-old")!);
		assert.match(descriptor, new RegExp(`source=${candidate.sourcePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), role);
		assert.doesNotMatch(descriptor, /ROLE-RAW-SECRET|authority_hash=|projection_hash=/, role);
		return descriptor;
	});
	assert.deepEqual(descriptors, [descriptors[0], descriptors[0], descriptors[0]]);
});

test("old image results collapse without copying image data or raw text", () => {
	const messages = [
		assistant([{ id: "old-image" }]),
		result("old-image", "OLD-IMAGE-SECRET".repeat(400), { images: 3 }),
		...bundle("latest-small", "latest"),
	];
	const projected = project(messages, { maxToolTextBytes: 500, descriptorMaxBytes: 100 });
	const old = resultById(projected.messages, "old-image")!;
	assert.ok(old);
	assert.doesNotMatch(textOf(old), /OLD-IMAGE-SECRET/);
	assert.equal((old as { content: Array<{ type: string }> }).content.some((block) => block.type === "image"), false);
	assert.equal(textOf(resultById(projected.messages, "latest-small")!), "latest");
	assert.equal(validateContextToolPairing(projected.messages), true);
});

test("bundle deletion preserves text, thinking, compaction, branch, custom and ordinary messages", () => {
	const compaction = asMessage({ role: "compactionSummary", summary: "keep-compaction", tokensBefore: 999, timestamp: nextTimestamp++ });
	const branch = asMessage({ role: "branchSummary", summary: "keep-branch", fromId: "entry", timestamp: nextTimestamp++ });
	const custom = asMessage({ role: "custom", customType: "keep", content: "keep-custom", display: false, details: { safe: true }, timestamp: nextTimestamp++ });
	const messages = [
		user("keep-user"),
		compaction,
		branch,
		custom,
		...bundle("remove-me", "remove-result", [
			{ type: "text", text: "keep-assistant-text" },
			{ type: "thinking", thinking: "keep-thinking" },
		]),
		...bundle("keep-latest", "keep-latest-result"),
	];
	const projected = project(messages, { maxToolTextBytes: 10_000, maxBundles: 1 });
	assert.equal(validateContextToolPairing(projected.messages), true);
	assert.equal(resultById(projected.messages, "remove-me"), undefined);
	assert.equal(textOf(resultById(projected.messages, "keep-latest")!), "keep-latest-result");
	assert.ok(projected.messages.includes(compaction));
	assert.ok(projected.messages.includes(branch));
	assert.ok(projected.messages.includes(custom));
	const keptAssistant = projected.messages.find((message) => textOf(message).includes("keep-assistant-text"))!;
	const keptContent = (keptAssistant as { content: Array<{ type: string }> }).content;
	assert.deepEqual(keptContent.map((block) => block.type), ["text", "thinking"]);
	const omission = projected.messages.find((message) => (
		(message as { customType?: unknown }).customType === "workbench-history-projection"
	))!;
	assert.equal((omission as { display?: unknown }).display, false);
	assert.doesNotMatch(textOf(omission), /remove-result/);
	const facts = (omission as { details: Record<string, unknown> }).details;
	assert.ok(Object.values(facts).every((value) => typeof value === "number"));
});

test("public failure projection preserves the latest locally complete batch and removes corrupt raw output", () => {
	const corrupt = [
		result("orphan", "ORPHAN-RAW"),
		user("keep-user"),
		...bundle("safe", "SAFE-LATEST"),
	];
	const projected = historyProjectionFailureMessages(corrupt, 64, 384);
	assert.equal(validateContextToolPairing(projected), true);
	assert.ok(historyToolTextBytes(projected) <= 64);
	assert.equal(textOf(resultById(projected, "safe")!), "SAFE-LATEST");
	assert.doesNotMatch(projected.map(textOf).join("\n"), /ORPHAN-RAW/);
	assert.equal(projected.some((message) => textOf(message) === "keep-user"), true);
	assert.equal(projected.some((message) => (
		(message as { customType?: unknown }).customType === "workbench-history-projection-failure"
	)), true);
});

test("controller repairs an abandoned interrupted tool batch and preserves the latest complete durable status", () => {
	const controller = new HistoryProjectionController();
	const raw: AgentMessage[] = [user("initial task")];
	for (let index = 0; index < 28; index += 1) {
		raw.push(...bundle(`old-${index}`, `old-result-${index}:` + "x".repeat(8 * 1_024)));
	}
	const config = {
		maxToolTextBytes: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "commander" as const,
	};
	const initial = controller.project({ messages: raw, ...config });
	assert.equal(initial.transitionCause, "initial_hard_limit");

	const interrupted = assistant([
		{ id: "lost-a", name: "workbench_run_recipe" },
		{ id: "lost-b", name: "read" },
	], [{ type: "text", text: "keep bounded planning" }]);
	raw.push(
		interrupted,
		result("lost-a", "PARTIAL-INTERRUPTED-RAW-SECRET", { name: "workbench_run_recipe" }),
		asMessage({ role: "custom", customType: "turn-ended", content: "", display: false, timestamp: nextTimestamp++ }),
		user("刚才因为断电中断，请继续推进"),
		...bundle("fresh-status", [
			"latest: prior STALE",
			"successor: ALLOWED after live revalidation",
			"review: FINAL/PASS",
		].join("\n")),
	);

	const recovered = controller.project({ messages: raw, ...config });
	assert.equal(validateContextToolPairing(recovered.messages), true);
	assert.ok(historyToolTextBytes(recovered.messages) <= COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES);
	assert.doesNotMatch(JSON.stringify(recovered.messages), /PARTIAL-INTERRUPTED-RAW-SECRET|lost-a|lost-b/);
	assert.match(recovered.messages.map(textOf).join("\n"), /刚才因为断电中断，请继续推进/);
	assert.match(recovered.messages.map(textOf).join("\n"), /successor: ALLOWED after live revalidation/);
	assert.match(recovered.messages.map(textOf).join("\n"), /do not wait for another user confirmation/);
	assert.equal(recovered.facts.protectedLatestBundles >= 1, true);

	const stateBeforeReplay = controller.serialize();
	const replayed = controller.project({ messages: raw, ...config });
	assert.deepEqual(replayed.messages, recovered.messages, "the same abandoned batch repairs deterministically on every provider request");
	assert.deepEqual(controller.serialize(), stateBeforeReplay, "serialized recovery state remains canonical");
});

test("controller does not repair an incomplete live tail or unsafe orphan and mismatch histories", () => {
	const config = {
		maxToolTextBytes: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "commander" as const,
	};
	for (const messages of [
		[user("live"), assistant([{ id: "still-running", name: "read" }])],
		[user("orphan"), result("orphan", "ORPHAN-SECRET", { name: "read" }), user("continue")],
		[user("mismatch"), assistant([{ id: "wrong", name: "read" }]), result("wrong", "MISMATCH-SECRET", { name: "write" }), user("continue")],
	]) {
		const projected = new HistoryProjectionController().project({ messages, ...config });
		assert.deepEqual(projected.messages, safeHistoryProjectionFailureMessages());
		assert.equal(projected.transitionCause, "failure");
		assert.doesNotMatch(JSON.stringify(projected.messages), /SECRET|still-running/);
	}
});

test("absolute projection failures yield one fixed hidden custom message instead of an empty or raw context", () => {
	let trapCalls = 0;
	const hostile = new Proxy({ role: "toolResult" }, {
		get(): never { trapCalls += 1; throw new Error("HOSTILE-SECRET"); },
		ownKeys(): never { trapCalls += 1; throw new Error("HOSTILE-SECRET"); },
		getOwnPropertyDescriptor(): never { trapCalls += 1; throw new Error("HOSTILE-SECRET"); },
	});
	const projected = project([hostile as AgentMessage], { maxToolTextBytes: 0 });
	assert.equal(trapCalls, 0);
	assert.equal(projected.messages.length, 1);
	const failure = projected.messages[0]! as unknown as { role: string; customType: string; display: boolean; content: string; details: Record<string, unknown> };
	assert.equal(failure.role, "custom");
	assert.equal(failure.customType, "workbench-history-projection-failure");
	assert.equal(failure.display, false);
	assert.match(failure.content, /^\[workbench history projection failure\]/);
	assert.doesNotMatch(failure.content, /HOSTILE-SECRET/);
	assert.ok(Object.values(failure.details).every((value) => typeof value === "number"));
	assert.equal(validateContextToolPairing(projected.messages), true);
	assert.equal(historyToolTextBytes(projected.messages), 0);

	const publicFailure = historyProjectionFailureMessages([hostile as AgentMessage], 0, 0);
	assert.equal((publicFailure[0] as { customType?: unknown }).customType, "workbench-history-projection-failure");
	const terminalFailure = safeHistoryProjectionFailureMessages();
	assert.equal((terminalFailure[0] as { customType?: unknown }).customType, "workbench-history-projection-failure");
});

test("seeded exact-pairing fuzz remains reproducible through projection and corruption", () => {
	const seed = 0x5eedc0de;
	let state = seed >>> 0;
	const random = (): number => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state;
	};
	console.log(`context-history pairing fuzz seed=${seed}`);

	for (let iteration = 0; iteration < 200; iteration += 1) {
		const messages: AgentMessage[] = [user(`iteration-${iteration}`)];
		const bundleTotal = 1 + (random() % 20);
		for (let bundleIndex = 0; bundleIndex < bundleTotal; bundleIndex += 1) {
			const callTotal = 1 + (random() % 4);
			const calls = Array.from({ length: callTotal }, (_, callIndex) => ({
				id: `f-${iteration}-${bundleIndex}-${callIndex}`,
				name: `tool-${callIndex}`,
			}));
			const results = calls.map((call) => result(call.id, "🙂".repeat(1 + (random() % 100)), { name: call.name }));
			for (let index = results.length - 1; index > 0; index -= 1) {
				const swap = random() % (index + 1);
				[results[index], results[swap]] = [results[swap]!, results[index]!];
			}
			messages.push(assistant(calls), ...results);
		}
		assert.equal(validateContextToolPairing(messages), true, `seed=${seed} iteration=${iteration}`);
		const cap = 256 + (random() % 1_793);
		const projected = project(messages, {
			maxToolTextBytes: cap,
			maxBundles: 1 + (random() % 20),
			descriptorMaxBytes: 1 + (random() % 384),
		});
		assert.equal(validateContextToolPairing(projected.messages), true, `seed=${seed} iteration=${iteration}`);
		assert.ok(historyToolTextBytes(projected.messages) <= cap, `seed=${seed} iteration=${iteration}`);

		const corrupt = structuredClone(messages);
		const victim = corrupt.find((message) => (message as { role?: unknown }).role === "toolResult") as unknown as { toolCallId: string };
		victim.toolCallId = `corrupt-${iteration}`;
		assert.equal(validateContextToolPairing(corrupt), false, `seed=${seed} iteration=${iteration}`);
		const failedClosed = project(corrupt, { maxToolTextBytes: cap });
		assert.equal(validateContextToolPairing(failedClosed.messages), true, `seed=${seed} iteration=${iteration}`);
		assert.ok(historyToolTextBytes(failedClosed.messages) <= cap, `seed=${seed} iteration=${iteration}`);
	}
});

test("history projection preserves the complete provider prefix while projected history stays under hard limits", () => {
	const controller = new HistoryProjectionController();
	const raw: AgentMessage[] = [user("epoch-start")];
	for (let index = 0; index < 8; index += 1) raw.push(...bundle(`epoch-seed-${index}`, "x".repeat(20 * 1_024)));
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: 128,
		descriptorMaxBytes: 32,
		role: "worker" as const,
	};

	let projected = controller.project({ messages: raw, ...config });
	assert.equal(projected.epochTransitioned, true);
	assert.equal(projected.epoch, 1);
	assert.ok(historyToolTextBytes(projected.messages) <= WORKER_HISTORY_TOOL_TEXT_MAX_BYTES);
	assert.equal(validateContextToolPairing(projected.messages), true);
	let providerVisible = providerMessages(projected.messages);
	let state = controller.serialize();
	let transitionCount = 1;
	let segmentSealCount = 0;
	let collapsedDelta = projected.newlyCollapsedResults;
	let removedDelta = projected.newlyRemovedBundles;

	for (let turn = 0; turn < 25; turn += 1) {
		raw.push(user(`suffix-user-${turn}`), ...bundle(`epoch-suffix-${turn}`, "s".repeat(12)));
		const next = controller.project({ messages: raw, ...config });
		if (next.epochTransitioned) transitionCount += 1;
		collapsedDelta += next.newlyCollapsedResults;
		removedDelta += next.newlyRemovedBundles;
		const nextProviderVisible = providerMessages(next.messages);
		const nextState = controller.serialize();
		if (next.segmentSealed) segmentSealCount += 1;
		assert.equal(next.segmentSealed, false, `turn=${turn}`);
		assert.equal(next.epochTransitioned, false, `turn=${turn}`);
		assert.equal(next.transitionCause, "none", `turn=${turn}`);
		assert.deepEqual(
			nextProviderVisible.slice(0, providerVisible.length),
			providerVisible,
			`turn ${turn} rewrote the append-only provider payload`,
		);
		assert.ok(historyToolTextBytes(next.messages) <= WORKER_HISTORY_TOOL_TEXT_MAX_BYTES, `turn=${turn}`);
		assert.ok(next.projectedBundleCount <= 128, `turn=${turn}`);
		assert.equal(validateContextToolPairing(next.messages), true, `turn=${turn}`);
		providerVisible = nextProviderVisible;
		state = nextState;
		projected = next;
	}

	assert.equal(segmentSealCount, 0, "an active-reserve crossing alone must not seal");
	assert.equal(state.segments.length, 0);
	assert.equal(transitionCount, 1, "segment seals do not change the projection epoch");
	assert.equal(collapsedDelta, projected.facts.collapsedResults, "same epoch never re-counts collapsed results");
	assert.equal(removedDelta, projected.facts.removedBundles, "same epoch never re-counts removed bundles");
});

test("rolling projection reserves one role turn and keeps a fixed provider anchor across 40/50/64 KiB Commander batches", () => {
	const controller = new HistoryProjectionController();
	const raw: AgentMessage[] = [user("rolling-anchor")];
	raw.push(...batchBundle("seed-a", [9 * 1_024]));
	raw.push(user("seed-b"), ...batchBundle("seed-b", [30 * 1_024, 30 * 1_024]));
	raw.push(user("seed-d"), ...batchBundle("seed-d", [30 * 1_024, 30 * 1_024]));
	raw.push(user("seed-c"), ...batchBundle("seed-c", [16 * 1_024, 16 * 1_024, 16 * 1_024, 16 * 1_024]));
	const config = {
		maxToolTextBytes: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "commander" as const,
	};

	const initial = controller.project({ messages: raw, ...config });
	assert.equal(initial.epochTransitioned, true);
	assert.equal(initial.transitionCause, "initial_hard_limit");
	const initialState = controller.serialize();
	assert.equal(initialState.schemaVersion, 3);
	assert.ok(
		initialState.hardToolTextBytes - initialState.anchorToolTextBytes
			>= COMMANDER_TURN_MAX_BYTES + HISTORY_PROJECTION_MAX_SEGMENTS * HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES,
		"Commander anchor leaves one complete turn plus all segment reserves",
	);
	const anchorMessageCount = initialState.anchor.projectedMessageCount;
	assert.ok(Number.isSafeInteger(anchorMessageCount) && anchorMessageCount > 0);
	const fixedAnchor = convertToLlm(initial.messages.slice(0, anchorMessageCount));
	assert.ok(fixedAnchor.length > 0);

	raw.push(user("same-epoch-small"), ...batchBundle("same-epoch-small", [4 * 1_024]));
	const sameEpoch = controller.project({ messages: raw, ...config });
	assert.equal(sameEpoch.epochTransitioned, false);
	assert.equal(sameEpoch.segmentSealed, false);
	assert.equal(sameEpoch.transitionCause, "none");
	assert.ok(historyToolTextBytes(raw.slice(controller.serialize().activeRawStartMessageCount)) > COMMANDER_TURN_MAX_BYTES);
	assert.ok(historyToolTextBytes(sameEpoch.messages) <= COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES);
	assert.deepEqual(
		convertToLlm(sameEpoch.messages).slice(0, convertToLlm(initial.messages).length),
		convertToLlm(initial.messages),
		"an under-hard active-reserve crossing must remain wholly append-only",
	);
	assert.deepEqual(convertToLlm(sameEpoch.messages).slice(0, fixedAnchor.length), fixedAnchor);

	for (const [label, sizes, expectedSeal, expectedActiveBytes] of [
		["batch-50k", [25 * 1_024, 25 * 1_024], true, 54 * 1_024],
		["batch-64k", [16 * 1_024, 16 * 1_024, 16 * 1_024, 16 * 1_024], true, 64 * 1_024],
	] as const) {
		raw.push(user(label), ...batchBundle(label, sizes));
		const transitioned = controller.project({ messages: raw, ...config });
		assert.equal(transitioned.epochTransitioned, false, label);
		assert.equal(transitioned.segmentSealed, expectedSeal, label);
		assert.equal(transitioned.transitionCause, expectedSeal ? "segment_sealed" : "none", label);
		assert.equal(
			historyToolTextBytes(raw.slice(controller.serialize().activeRawStartMessageCount)),
			expectedActiveBytes,
			`${label} active tail bytes`,
		);
		assert.deepEqual(
			convertToLlm(transitioned.messages).slice(0, fixedAnchor.length),
			fixedAnchor,
			`${label} changed the fixed provider-visible anchor`,
		);
		assert.ok(historyToolTextBytes(transitioned.messages) <= COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES, label);
		assert.equal(validateContextToolPairing(transitioned.messages), true, label);
		for (const id of sizes.map((_, index) => `${label}-${index}`)) {
			assert.match(textOf(resultById(transitioned.messages, id)!), /^\d+$/, `${label}/${id} latest batch must stay raw`);
		}
	}
});

test("role controllers append past the active byte reserve until projected history crosses the hard byte cap", () => {
	for (const scenario of [
		{
			role: "commander" as const,
			hard: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
			turn: COMMANDER_TURN_MAX_BYTES,
			seedBundles: 8,
			seedBytes: 30 * 1_024,
			underBytes: 6 * 1_024,
			crossingBytes: 20 * 1_024,
		},
		{
			role: "worker" as const,
			hard: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
			turn: WORKER_TURN_MAX_BYTES,
			seedBundles: 8,
			seedBytes: 20 * 1_024,
			underBytes: 10 * 1_024,
			crossingBytes: 20 * 1_024,
		},
		{
			role: "other" as const,
			hard: OTHER_HISTORY_TOOL_TEXT_MAX_BYTES,
			turn: WORKER_TURN_MAX_BYTES,
			seedBundles: 8,
			seedBytes: 10 * 1_024,
			underBytes: 10 * 1_024,
			crossingBytes: 20 * 1_024,
		},
	] as const) {
		const controller = new HistoryProjectionController();
		const raw: AgentMessage[] = [user(`${scenario.role}-byte-anchor`)];
		for (let index = 0; index < scenario.seedBundles; index += 1) {
			raw.push(...bundle(`${scenario.role}-byte-seed-${index}`, "s".repeat(scenario.seedBytes)));
		}
		const config = {
			maxToolTextBytes: scenario.hard,
			maxBundles: HISTORY_MAX_BUNDLES,
			descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
			role: scenario.role,
		};
		const initial = controller.project({ messages: raw, ...config });
		assert.equal(initial.epochTransitioned, true, scenario.role);
		assert.equal(initial.segmentSealed, false, scenario.role);
		assert.equal(initial.transitionCause, "initial_hard_limit", scenario.role);
		assert.equal(controller.serialize().segments.length, 0, scenario.role);

		const underId = `${scenario.role}-byte-under`;
		raw.push(user(`${underId}-turn`), ...bundle(underId, "u".repeat(scenario.underBytes)));
		const under = controller.project({ messages: raw, ...config });
		const underState = controller.serialize();
		assert.equal(under.segmentSealed, false, scenario.role);
		assert.equal(under.epochTransitioned, false, scenario.role);
		assert.equal(under.transitionCause, "none", scenario.role);
		assert.equal(underState.segments.length, 0, scenario.role);
		assert.ok(
			historyToolTextBytes(raw.slice(underState.activeRawStartMessageCount)) > scenario.turn,
			`${scenario.role} active bytes must exceed the turn reserve`,
		);
		assert.ok(historyToolTextBytes(under.messages) <= scenario.hard, `${scenario.role} projected bytes`);
		assert.deepEqual(
			providerMessages(under.messages).slice(0, providerMessages(initial.messages).length),
			providerMessages(initial.messages),
			`${scenario.role} rewrote the under-hard provider prefix`,
		);
		assert.equal(textOf(resultById(under.messages, underId)!), "u".repeat(scenario.underBytes), scenario.role);

		const persisted = JSON.parse(JSON.stringify(underState)) as SerializedV3ProjectionState;
		const reloaded = new HistoryProjectionController();
		assert.equal(reloaded.restoreFromEntries([
			{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: persisted },
		]), true, `${scenario.role} restores an under-hard active tail above the byte reserve`);
		const replayed = reloaded.project({
			messages: JSON.parse(JSON.stringify(raw)) as AgentMessage[],
			...config,
		});
		assert.equal(replayed.segmentSealed, false, scenario.role);
		assert.equal(replayed.transitionCause, "none", scenario.role);
		assert.deepEqual(jsonNormalizedProviderMessages(replayed.messages), jsonNormalizedProviderMessages(under.messages), scenario.role);

		const crossingId = `${scenario.role}-byte-crossing`;
		raw.push(user(`${crossingId}-turn`), ...bundle(crossingId, "h".repeat(scenario.crossingBytes)));
		const crossing = controller.project({ messages: raw, ...config });
		assert.equal(crossing.segmentSealed, true, scenario.role);
		assert.equal(crossing.epochTransitioned, false, scenario.role);
		assert.equal(crossing.transitionCause, "segment_sealed", scenario.role);
		assert.equal(controller.serialize().segments.length, 1, `${scenario.role} seals exactly once`);
		assert.ok(historyToolTextBytes(crossing.messages) <= scenario.hard, scenario.role);
		assert.equal(validateContextToolPairing(crossing.messages), true, scenario.role);
		assert.equal(
			textOf(resultById(crossing.messages, crossingId)!),
			"h".repeat(scenario.crossingBytes),
			`${scenario.role} latest hard-crossing bundle stays raw`,
		);

		const crossingProvider = providerMessages(crossing.messages);
		const stableId = `${scenario.role}-byte-stable`;
		raw.push(user(`${stableId}-turn`), ...bundle(stableId, "n"));
		const stable = controller.project({ messages: raw, ...config });
		assert.equal(stable.segmentSealed, false, scenario.role);
		assert.equal(stable.epochTransitioned, false, scenario.role);
		assert.equal(stable.transitionCause, "none", scenario.role);
		assert.equal(controller.serialize().segments.length, 1, `${scenario.role} ordinary append must not reseal`);
		assert.deepEqual(
			providerMessages(stable.messages).slice(0, crossingProvider.length),
			crossingProvider,
			`${scenario.role} rewrote the post-seal provider prefix`,
		);
	}
});

test("role controllers append past the active bundle reserve until projected history crosses the hard bundle cap", () => {
	for (const [role, hard] of [
		["commander", COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES],
		["worker", WORKER_HISTORY_TOOL_TEXT_MAX_BYTES],
		["other", OTHER_HISTORY_TOOL_TEXT_MAX_BYTES],
	] as const) {
		const controller = new HistoryProjectionController();
		const raw: AgentMessage[] = [user(`${role}-bundle-anchor`)];
		for (let index = 0; index < 140; index += 1) raw.push(...bundle(`${role}-bundle-seed-${index}`, "s"));
		const config = {
			maxToolTextBytes: hard,
			maxBundles: HISTORY_MAX_BUNDLES,
			descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
			role,
		};
		let previous = controller.project({ messages: raw, ...config });
		assert.equal(previous.epochTransitioned, true, role);
		assert.equal(previous.segmentSealed, false, role);
		assert.equal(previous.transitionCause, "initial_hard_limit", role);
		assert.equal(controller.serialize().segments.length, 0, role);
		const headroom = HISTORY_MAX_BUNDLES - previous.projectedBundleCount;
		assert.ok(headroom > 0, `${role} initial checkpoint must reserve active bundle headroom`);

		for (let index = 0; index < headroom; index += 1) {
			const previousProvider = providerMessages(previous.messages);
			raw.push(...bundle(`${role}-bundle-under-${index}`, "u"));
			const appended = controller.project({ messages: raw, ...config });
			assert.equal(appended.segmentSealed, false, `${role}/${index}`);
			assert.equal(appended.epochTransitioned, false, `${role}/${index}`);
			assert.equal(appended.transitionCause, "none", `${role}/${index}`);
			assert.equal(controller.serialize().segments.length, 0, `${role}/${index}`);
			assert.equal(appended.projectedBundleCount, previous.projectedBundleCount + 1, `${role}/${index}`);
			assert.deepEqual(
				providerMessages(appended.messages).slice(0, previousProvider.length),
				previousProvider,
				`${role}/${index} rewrote the under-hard provider prefix`,
			);
			previous = appended;
		}

		const underState = controller.serialize();
		assert.equal(previous.projectedBundleCount, HISTORY_MAX_BUNDLES, role);
		assert.ok(
			callBundleCount(raw.slice(underState.activeRawStartMessageCount)) > HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES,
			`${role} active bundles must exceed the turn reserve`,
		);
		const persisted = JSON.parse(JSON.stringify(underState)) as SerializedV3ProjectionState;
		const reloaded = new HistoryProjectionController();
		assert.equal(reloaded.restoreFromEntries([
			{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: persisted },
		]), true, `${role} restores an under-hard active tail above the bundle reserve`);
		const replayed = reloaded.project({
			messages: JSON.parse(JSON.stringify(raw)) as AgentMessage[],
			...config,
		});
		assert.equal(replayed.segmentSealed, false, role);
		assert.equal(replayed.transitionCause, "none", role);
		assert.deepEqual(jsonNormalizedProviderMessages(replayed.messages), jsonNormalizedProviderMessages(previous.messages), role);

		const overflowId = `${role}-bundle-overflow`;
		raw.push(...bundle(overflowId, "h"));
		const crossing = controller.project({ messages: raw, ...config });
		assert.equal(crossing.segmentSealed, true, role);
		assert.equal(crossing.epochTransitioned, false, role);
		assert.equal(crossing.transitionCause, "segment_sealed", role);
		assert.equal(controller.serialize().segments.length, 1, `${role} seals exactly once`);
		assert.ok(crossing.projectedBundleCount <= HISTORY_MAX_BUNDLES, role);
		assert.equal(validateContextToolPairing(crossing.messages), true, role);
		assert.equal(textOf(resultById(crossing.messages, overflowId)!), "h", `${role} latest overflow bundle stays raw`);

		const crossingProvider = providerMessages(crossing.messages);
		raw.push(...bundle(`${role}-bundle-stable`, "n"));
		const stable = controller.project({ messages: raw, ...config });
		assert.equal(stable.segmentSealed, false, role);
		assert.equal(stable.epochTransitioned, false, role);
		assert.equal(stable.transitionCause, "none", role);
		assert.equal(controller.serialize().segments.length, 1, `${role} ordinary append must not reseal`);
		assert.deepEqual(
			providerMessages(stable.messages).slice(0, crossingProvider.length),
			crossingProvider,
			`${role} rewrote the post-seal provider prefix`,
		);
	}
});

test("role anchor low watermarks derive from output-policy turn caps", () => {
	for (const [role, hard, turn] of [
		["commander", COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES, COMMANDER_TURN_MAX_BYTES],
		["worker", WORKER_HISTORY_TOOL_TEXT_MAX_BYTES, WORKER_TURN_MAX_BYTES],
		["other", OTHER_HISTORY_TOOL_TEXT_MAX_BYTES, WORKER_TURN_MAX_BYTES],
	] as const) {
		const raw: AgentMessage[] = [
			...batchBundle(`${role}-a`, [Math.ceil(hard / 2)]),
			...batchBundle(`${role}-b`, [Math.ceil(hard / 2)]),
			...batchBundle(`${role}-c`, [1]),
		];
		const controller = new HistoryProjectionController();
		const projected = controller.project({
			messages: raw,
			maxToolTextBytes: hard,
			maxBundles: HISTORY_MAX_BUNDLES,
			descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
			role,
		});
		assert.equal(projected.epochTransitioned, true, role);
		const state = controller.serialize();
		assert.equal(
			state.hardToolTextBytes - state.anchorToolTextBytes,
			turn + HISTORY_PROJECTION_MAX_SEGMENTS * HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES,
			role,
		);
		assert.equal(state.anchorBundles, HISTORY_MAX_BUNDLES - HISTORY_PROJECTION_MAX_SEGMENTS - HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES, role);
	}
});

test("P1 role caps freeze exact anchors and preserve immutable provider prefixes across a byte seal", () => {
	for (const scenario of [
		{
			role: "commander" as const,
			hard: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
			turn: COMMANDER_TURN_MAX_BYTES,
			initialSizes: [80 * 1_024, 64 * 1_024, 64 * 1_024],
			latestBytes: 64 * 1_024,
			expectedAnchorBytes: 122 * 1_024,
		},
		{
			role: "worker" as const,
			hard: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
			turn: WORKER_TURN_MAX_BYTES,
			initialSizes: [48 * 1_024, 48 * 1_024, 40 * 1_024],
			latestBytes: 48 * 1_024,
			expectedAnchorBytes: 74 * 1_024,
		},
		{
			role: "other" as const,
			hard: OTHER_HISTORY_TOOL_TEXT_MAX_BYTES,
			turn: WORKER_TURN_MAX_BYTES,
			initialSizes: [24 * 1_024, 24 * 1_024, 24 * 1_024],
			latestBytes: 48 * 1_024,
			expectedAnchorBytes: 10 * 1_024,
		},
	] as const) {
		const raw: AgentMessage[] = [user(`${scenario.role}-p1-anchor`)];
		for (const [index, size] of scenario.initialSizes.entries()) {
			raw.push(...bundle(`${scenario.role}-p1-initial-${index}`, String(index).repeat(size)));
		}
		const config = {
			maxToolTextBytes: scenario.hard,
			maxBundles: HISTORY_MAX_BUNDLES,
			descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
			role: scenario.role,
		};
		const controller = new HistoryProjectionController();
		const initial = controller.project({ messages: raw, ...config });
		const initialState = controller.serialize();
		assert.equal(initial.transitionCause, "initial_hard_limit", scenario.role);
		assert.equal(initialState.anchorToolTextBytes, scenario.expectedAnchorBytes, scenario.role);
		assert.equal(initialState.segments.length, 0, scenario.role);
		const immutableProviderPrefix = jsonNormalizedProviderMessages(
			initial.messages.slice(0, initialState.anchor.projectedMessageCount),
		);
		assert.ok(immutableProviderPrefix.length > 0, scenario.role);

		const latestId = `${scenario.role}-p1-latest`;
		raw.push(user(`${latestId}-turn`), ...bundle(latestId, "L".repeat(scenario.latestBytes)));
		const sealed = controller.project({ messages: raw, ...config });
		const sealedState = controller.serialize();
		const sealedProvider = jsonNormalizedProviderMessages(sealed.messages);
		assert.equal(sealed.segmentSealed, true, scenario.role);
		assert.equal(sealed.epochTransitioned, false, scenario.role);
		assert.equal(sealed.transitionCause, "segment_sealed", scenario.role);
		assert.equal(sealedState.segments.length, 1, scenario.role);
		assert.deepEqual(
			sealedProvider.slice(0, immutableProviderPrefix.length),
			immutableProviderPrefix,
			`${scenario.role} rewrote its provider-visible immutable prefix`,
		);
		assert.equal(textOf(resultById(sealed.messages, latestId)!), "L".repeat(scenario.latestBytes), scenario.role);
		assert.ok(historyToolTextBytes(raw.slice(sealedState.activeRawStartMessageCount)) <= scenario.turn, scenario.role);
		assert.ok(historyToolTextBytes(sealed.messages) <= scenario.hard, scenario.role);
		assert.ok(callBundleCount(sealed.messages) <= HISTORY_MAX_BUNDLES, scenario.role);
		assert.equal(validateContextToolPairing(sealed.messages), true, scenario.role);

		const persisted = JSON.parse(JSON.stringify(sealedState)) as SerializedV3ProjectionState;
		const restored = new HistoryProjectionController();
		assert.equal(restored.restoreFromEntries([
			{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: persisted },
		]), true, scenario.role);
		const replayed = restored.project({ messages: JSON.parse(JSON.stringify(raw)) as AgentMessage[], ...config });
		assert.deepEqual(jsonNormalizedProviderMessages(replayed.messages), sealedProvider, scenario.role);
		assert.deepEqual(restored.serialize(), persisted, scenario.role);
	}
});

test("failure projection boundaries are non-secret, stable, deduplicated, and signal recovery once", () => {
	const controller = new HistoryProjectionController();
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const ordinary = controller.project({ messages: [user("ordinary")], ...config });
	assert.equal(ordinary.epochTransitioned, false);

	const corrupt = (input: {
		ordinary: string;
		orphan: string;
		localId: string;
		localResult: string;
	}): AgentMessage[] => [
		user(input.ordinary),
		result(`orphan-${input.localId}`, input.orphan, { name: "read" }),
		...bundle(input.localId, input.localResult),
	];
	const secretA = "FAILURE-BOUNDARY-SECRET-A";
	const firstCorrupt = corrupt({
		ordinary: `ordinary-${secretA}`,
		orphan: secretA,
		localId: "local-a",
		localResult: `LOCAL-RAW-${secretA}`,
	});
	const firstFailure = controller.project({ messages: firstCorrupt, ...config });
	assert.equal(firstFailure.transitionCause, "failure");
	assert.equal(firstFailure.epochTransitioned, true);
	assert.match(firstFailure.epochHash ?? "", /^[0-9a-f]{64}$/);
	assert.equal(firstFailure.facts.finalToolTextBytes, 0);
	assert.equal(firstFailure.facts.collapsedResults, 0);
	assert.equal(firstFailure.facts.removedBundles, 0);
	assert.equal(firstFailure.facts.protectedLatestBundles, 0);
	assert.equal(firstFailure.newlyCollapsedResults, 0);
	assert.equal(firstFailure.newlyRemovedBundles, 0);
	assert.equal(firstFailure.projectedBundleCount, 0);
	assert.deepEqual(convertToLlm(firstFailure.messages), convertToLlm(safeHistoryProjectionFailureMessages()));
	assert.doesNotMatch(JSON.stringify(firstFailure.messages), /FAILURE-BOUNDARY-SECRET|LOCAL-RAW/);

	const secretB = "FAILURE-BOUNDARY-SECRET-B";
	const secondCorrupt = corrupt({
		ordinary: `different-ordinary-${secretB}`,
		orphan: secretB.repeat(37),
		localId: "different-local-b",
		localResult: `DIFFERENT-LOCAL-RAW-${secretB}`.repeat(11),
	});
	const repeatedFailure = controller.project({ messages: secondCorrupt, ...config });
	assert.equal(repeatedFailure.transitionCause, "failure");
	assert.equal(repeatedFailure.epochTransitioned, false, "same fixed failure payload is not a new epoch each request");
	assert.equal(repeatedFailure.epochHash, firstFailure.epochHash, "failure identity is input-independent");
	assert.deepEqual(
		convertToLlm(repeatedFailure.messages),
		convertToLlm(firstFailure.messages),
		"ordinary messages, orphan size, and latest locally complete raw bundle cannot vary the provider failure payload",
	);
	assert.deepEqual(repeatedFailure.facts, {
		originalToolTextBytes: historyToolTextBytes(secondCorrupt),
		finalToolTextBytes: 0,
		collapsedResults: 0,
		removedBundles: 0,
		protectedLatestBundles: 0,
	});
	assert.doesNotMatch(JSON.stringify(repeatedFailure.messages), /FAILURE-BOUNDARY-SECRET|DIFFERENT-LOCAL-RAW/);

	const recovery = controller.project({ messages: [user("healthy-again")], ...config });
	assert.equal(recovery.epochTransitioned, true);
	assert.equal(recovery.transitionCause, "none");
	assert.match(recovery.epochHash ?? "", /^[0-9a-f]{64}$/);
	assert.notEqual(recovery.epochHash, firstFailure.epochHash);
	const stableRecovery = controller.project({ messages: [user("healthy-again"), user("append")], ...config });
	assert.equal(stableRecovery.epochTransitioned, false);
	assert.equal(stableRecovery.epochHash, null);

	const nextFailure = controller.project({
		messages: corrupt({
			ordinary: "ordinary-c",
			orphan: "FAILURE-BOUNDARY-SECRET-C",
			localId: "local-c",
			localResult: "LOCAL-RAW-C",
		}),
		...config,
	});
	assert.equal(nextFailure.epochTransitioned, true);
	assert.equal(nextFailure.epochHash, firstFailure.epochHash, "boundary identity does not increment or randomize");
	const independent = new HistoryProjectionController().project({
		messages: corrupt({
			ordinary: "independent-ordinary",
			orphan: "INDEPENDENT-FAILURE-SECRET".repeat(3),
			localId: "independent-local",
			localResult: "INDEPENDENT-LOCAL-RAW",
		}),
		...config,
	});
	assert.equal(independent.epochHash, firstFailure.epochHash, "raw failure material never derives the identity");
	assert.deepEqual(convertToLlm(independent.messages), convertToLlm(firstFailure.messages));
});

test("fixed failure boundary survives strict v3 JSONL restore and signals recovery exactly once", () => {
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const failureBoundaryHash = createHash("sha256")
		.update("workbench-history-projection-boundary-v1\nfailure")
		.digest("hex");
	const recoveryBoundaryHash = createHash("sha256")
		.update("workbench-history-projection-boundary-v1\nrecovery")
		.digest("hex");
	const emptyHash = "0".repeat(64);
	const corrupt: AgentMessage[] = [
		user("persisted-failure"),
		result("persisted-orphan", "PERSISTED-FAILURE-RAW-SECRET", { name: "read" }),
		...bundle("persisted-local", "PERSISTED-LOCAL-RAW-SECRET"),
	];

	const source = new HistoryProjectionController();
	const firstFailure = source.project({ messages: corrupt, ...config });
	assert.equal(firstFailure.transitionCause, "failure");
	assert.equal(firstFailure.epochTransitioned, true);
	assert.equal(firstFailure.epochHash, failureBoundaryHash);
	const persisted = JSON.parse(JSON.stringify(source.serialize())) as SerializedV3ProjectionState;
	assert.equal(persisted.active, 0);
	assert.equal(persisted.epochHash, failureBoundaryHash, "inactive fixed-failure sentinel is durable");
	assert.equal(persisted.segmentChainHash, emptyHash);
	assert.equal(persisted.observedRawHash, emptyHash);
	assert.equal(persisted.stateHash, v3StateHash(persisted), "the sentinel is covered by the v3 state signature");
	assert.deepEqual(
		Object.keys(persisted).sort(),
		Object.keys(new HistoryProjectionController().serialize()).sort(),
		"failure durability adds no unbounded or schema-expanding state key",
	);
	assert.ok(Buffer.byteLength(JSON.stringify(persisted), "utf8") <= 32 * 1_024);
	assert.doesNotMatch(JSON.stringify(persisted), /PERSISTED-FAILURE-RAW-SECRET|PERSISTED-LOCAL-RAW-SECRET/);

	const restored = new HistoryProjectionController();
	assert.equal(restored.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: persisted },
	]), true);
	assert.deepEqual(restored.serialize(), persisted);
	const repeatedFailure = restored.project({ messages: structuredClone(corrupt), ...config });
	assert.equal(repeatedFailure.transitionCause, "failure");
	assert.equal(repeatedFailure.epochTransitioned, false, "restored fixed failure is not re-signalled");
	assert.equal(repeatedFailure.epochHash, failureBoundaryHash);
	assert.deepEqual(convertToLlm(repeatedFailure.messages), convertToLlm(firstFailure.messages));

	const recovery = restored.project({ messages: [user("persisted-healthy")], ...config });
	assert.equal(recovery.transitionCause, "none");
	assert.equal(recovery.epochTransitioned, true);
	assert.equal(recovery.epochHash, recoveryBoundaryHash, "the first healthy request emits the fixed recovery boundary");
	const recoveredState = restored.serialize();
	assert.equal(recoveredState.active, 0);
	assert.equal(recoveredState.epochHash, emptyHash, "recovery consumes the persisted failure sentinel");
	assert.equal(recoveredState.stateHash, v3StateHash(recoveredState));
	const stable = restored.project({ messages: [user("persisted-healthy"), user("persisted-append")], ...config });
	assert.equal(stable.transitionCause, "none");
	assert.equal(stable.epochTransitioned, false, "a second healthy request emits no lifecycle boundary");
	assert.equal(stable.epochHash, null);

	const restore = (data: unknown): boolean => new HistoryProjectionController().restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data },
	]);
	const staleHash = structuredClone(persisted);
	staleHash.epochHash = emptyHash;
	assert.equal(restore(staleHash), false, "changing the failure sentinel without resigning is rejected");
	assert.equal(restore({ ...persisted, failureBoundaryActive: 1 }), false, "an undeclared mode field is rejected");
	const unknownSentinel = structuredClone(persisted);
	unknownSentinel.epochHash = "f".repeat(64);
	unknownSentinel.stateHash = v3StateHash(unknownSentinel);
	assert.equal(restore(unknownSentinel), false, "only the fixed failure identity is a legal inactive sentinel");
	const misplacedSentinel = structuredClone(persisted);
	misplacedSentinel.epochHash = emptyHash;
	misplacedSentinel.segmentChainHash = failureBoundaryHash;
	misplacedSentinel.stateHash = v3StateHash(misplacedSentinel);
	assert.equal(restore(misplacedSentinel), false, "the sentinel cannot occupy another inactive hash slot");

	const activeRaw: AgentMessage[] = [];
	for (let index = 0; index < 8; index += 1) activeRaw.push(...bundle(`failure-mode-active-${index}`, "a".repeat(20 * 1_024)));
	const activeSource = new HistoryProjectionController();
	activeSource.project({ messages: activeRaw, ...config });
	const inconsistentActive = activeSource.serialize();
	assert.equal(inconsistentActive.active, 1);
	inconsistentActive.epochHash = failureBoundaryHash;
	inconsistentActive.stateHash = v3StateHash(inconsistentActive);
	assert.equal(restore(inconsistentActive), false, "failure mode cannot coexist with active frozen topology");

	const latestMalformed = new HistoryProjectionController();
	assert.equal(latestMalformed.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: persisted },
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: unknownSentinel },
	]), false, "the newest malformed mode remains fail-closed");
	const cleared = latestMalformed.serialize();
	assert.equal(cleared.active, 0);
	assert.equal(cleared.epochHash, emptyHash);
	assert.equal(cleared.stateHash, v3StateHash(cleared));
});

test("strict v3 restore accepts descriptor zero, multi-call bundles, and Commander explicitly lowered to 64 KiB", () => {
	const multiCallRaw: AgentMessage[] = [
		...batchBundle("multi-restore", [22 * 1_024, 22 * 1_024, 22 * 1_024, 22 * 1_024, 22 * 1_024, 22 * 1_024]),
		...batchBundle("multi-latest", [1]),
	];
	const multiCall = new HistoryProjectionController();
	const projected = multiCall.project({
		messages: multiCallRaw,
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: 0,
		role: "worker",
	});
	assert.equal(projected.epochTransitioned, true);
	const multiState = multiCall.serialize();
	assert.equal(multiState.descriptorMaxBytes, 0);
	assert.ok(multiState.transitionCollapsedResults > multiState.projectedBundles, "results and bundles are different units");
	assert.equal(new HistoryProjectionController().restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: multiState },
	]), true);

	const commanderRaw: AgentMessage[] = [
		...batchBundle("commander-lowered-old", [70 * 1_024]),
		...batchBundle("commander-lowered-latest", [1]),
	];
	const commander = new HistoryProjectionController();
	assert.equal(commander.project({
		messages: commanderRaw,
		maxToolTextBytes: 65_536,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "commander",
	}).epochTransitioned, true);
	const commanderState = commander.serialize();
	assert.equal(commanderState.hardToolTextBytes, 65_536);
	assert.equal(commanderState.anchorToolTextBytes, 0, "Commander keeps its full 64 KiB turn reserve");
	assert.equal(new HistoryProjectionController().restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: commanderState },
	]), true);
});

test("strict v3 restore rejects forged hard ceilings, role caps, chain hashes, and pressure", () => {
	const raw: AgentMessage[] = [];
	for (let index = 0; index < 8; index += 1) raw.push(...bundle(`strict-forge-${index}`, "f".repeat(28 * 1_024)));
	const source = new HistoryProjectionController();
	assert.equal(source.project({
		messages: raw,
		maxToolTextBytes: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "commander",
	}).epochTransitioned, true);
	const valid = source.serialize() as unknown as Record<string, unknown>;
	const restore = (data: Record<string, unknown>): boolean => new HistoryProjectionController().restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data },
	]);

	const oversized: Record<string, unknown> = {
		...valid,
		hardToolTextBytes: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES + 1,
		anchorToolTextBytes: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES + 1 - COMMANDER_TURN_MAX_BYTES,
	};
	assert.equal(restore(oversized), false, "self-consistent state cannot raise the Commander hard ceiling");

	const illegalAnchor: Record<string, unknown> = { ...valid, anchorToolTextBytes: 1 };
	assert.equal(restore(illegalAnchor), false, "anchor must be derived from a legal role turn reserve");

	const tooManyBundles: Record<string, unknown> = { ...valid, hardBundles: HISTORY_MAX_BUNDLES + 1 };
	assert.equal(restore(tooManyBundles), false);

	const badChain: Record<string, unknown> = { ...valid, segmentChainHash: "f".repeat(64) };
	assert.equal(restore(badChain), false);

	const inconsistentPressure: Record<string, unknown> = { ...valid, rawBundles: Number(valid.rawBundles) + 1 };
	assert.equal(inconsistentPressure.epochHash, valid.epochHash, "pressure is outside the epoch digest but inside stateHash");
	assert.equal(restore(inconsistentPressure), false, "strict restore still validates non-hashed pressure structure");
});

test("v3 canonical epoch and segment hashes survive JSONL round trips and ignore only top-level message metadata", () => {
	const raw: AgentMessage[] = [user("canonical-start")];
	for (let index = 0; index < 8; index += 1) raw.push(...bundle(`canonical-${index}`, "c".repeat(20 * 1_024)));
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const source = new HistoryProjectionController();
	const initial = source.project({ messages: raw, ...config });
	assert.equal(initial.epochTransitioned, true);
	const persisted = JSON.parse(JSON.stringify(source.serialize())) as unknown;
	const roundTrippedMessages = JSON.parse(JSON.stringify(raw)) as AgentMessage[];
	const restored = new HistoryProjectionController();
	assert.equal(restored.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: persisted },
	]), true);
	roundTrippedMessages.push(user("after-jsonl"), ...bundle("after-jsonl", "tail"));
	const continued = restored.project({ messages: roundTrippedMessages, ...config });
	assert.equal(continued.epochTransitioned, false, "undefined object keys omitted by JSON must not invalidate the epoch");
	assert.equal(continued.transitionCause, "none");

	const metadataChanged = structuredClone(roundTrippedMessages) as Array<AgentMessage & Record<string, unknown>>;
	for (const message of metadataChanged) {
		message.timestamp = Number(message.timestamp ?? 0) + 99_999;
		message.details = { changed: true };
		message.usage = { changed: true };
		message.diagnostics = [{ changed: true }];
	}
	const metadataOnly = restored.project({ messages: metadataChanged, ...config });
	assert.equal(metadataOnly.epochTransitioned, false);
	assert.equal(metadataOnly.transitionCause, "none");

	const nestedMetadataName = structuredClone(metadataChanged) as Array<AgentMessage & Record<string, unknown>>;
	const anchorCall = nestedMetadataName.find((message) => (message as { role?: unknown }).role === "assistant") as unknown as { content: Array<Record<string, unknown>> };
	(anchorCall.content.find((block) => block.type === "toolCall")!.arguments as Record<string, unknown>).details = "provider-visible-nested-change";
	const nestedChanged = restored.project({ messages: nestedMetadataName, ...config });
	assert.equal(nestedChanged.epochTransitioned, true, "nested keys named details remain provider-visible");
	assert.equal(nestedChanged.transitionCause, "prefix_changed");
});

test("v3 canonical hashing distinguishes lone surrogates from U+FFFD across frozen and observed prefixes", () => {
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const bundleCount = HISTORY_MAX_BUNDLES + 2;
	const protectedAnchorBundleIndex = bundleCount - HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES - 1;
	const makeRaw = (label: string): AgentMessage[] => {
		const messages: AgentMessage[] = [];
		for (let index = 0; index < bundleCount; index += 1) {
			messages.push(...bundle(`${label}-${index}`, label[0]!));
		}
		return messages;
	};
	const setArguments = (messages: AgentMessage[], bundleIndex: number, value: string): void => {
		const message = messages[bundleIndex * 2] as unknown as { content: Array<Record<string, unknown>> };
		const call = message.content.find((block) => block.type === "toolCall");
		assert.ok(call);
		call.arguments = { probe: value };
	};
	const lone = "ARG-SURROGATE-WIRE-SECRET-\ud800-END";
	const replacement = "ARG-SURROGATE-WIRE-SECRET-\ufffd-END";

	const collapsedRaw = makeRaw("anchor-surrogate");
	setArguments(collapsedRaw, 0, lone);
	const replacementCollapsedRaw = structuredClone(collapsedRaw);
	setArguments(replacementCollapsedRaw, 0, replacement);
	const loneArguments = ((collapsedRaw[0] as unknown as { content: Array<Record<string, unknown>> }).content[0]!.arguments);
	const replacementArguments = ((replacementCollapsedRaw[0] as unknown as { content: Array<Record<string, unknown>> }).content[0]!.arguments);
	assert.notEqual(JSON.stringify(loneArguments), JSON.stringify(replacementArguments), "provider argument JSON wires differ");

	const collapsedController = new HistoryProjectionController();
	const collapsedInitial = collapsedController.project({ messages: collapsedRaw, ...config });
	assert.equal(collapsedInitial.epochTransitioned, true);
	const collapsedBefore = collapsedController.serialize();
	assert.ok(collapsedBefore.anchor.removedBundles > 0, "the bundle-count projection removes old raw bundles");
	assert.equal(resultById(collapsedInitial.messages, "anchor-surrogate-0"), undefined, "the mutated old bundle is absent from provider history");
	const collapsedChanged = collapsedController.project({ messages: replacementCollapsedRaw, ...config });
	const collapsedAfter = collapsedController.serialize();
	assert.equal(collapsedChanged.epochTransitioned, true);
	assert.equal(collapsedChanged.transitionCause, "prefix_changed");
	assert.notEqual(collapsedChanged.epochHash, collapsedInitial.epochHash, "raw prefix mutation creates a new epoch boundary");
	assert.notEqual(collapsedAfter.observedRawHash, collapsedBefore.observedRawHash, "full canonical raw hashes differ");
	assert.notEqual(collapsedAfter.anchor.rawHash, collapsedBefore.anchor.rawHash, "frozen raw hashes differ");
	assert.equal(collapsedAfter.anchor.projectedHash, collapsedBefore.anchor.projectedHash, "removed old raw content leaves provider projection unchanged");
	assert.equal(collapsedAfter.anchor.boundaryId, collapsedBefore.anchor.boundaryId, "provider boundary identity does not claim a false visible change");
	assert.deepEqual(collapsedChanged.boundaryMarkers, collapsedInitial.boundaryMarkers, "safe marker remains tied to provider-visible projection");
	assert.deepEqual(
		jsonNormalizedProviderMessages(collapsedChanged.messages),
		jsonNormalizedProviderMessages(collapsedInitial.messages),
		"collapsed-away raw arguments do not change actual provider messages",
	);

	const visibleRaw = makeRaw("visible-surrogate");
	setArguments(visibleRaw, protectedAnchorBundleIndex, lone);
	const replacementVisibleRaw = structuredClone(visibleRaw);
	setArguments(replacementVisibleRaw, protectedAnchorBundleIndex, replacement);
	const visibleController = new HistoryProjectionController();
	const visibleInitial = visibleController.project({ messages: visibleRaw, ...config });
	const visibleBefore = visibleController.serialize();
	assert.ok(
		visibleBefore.anchor.rawEndMessageCount > protectedAnchorBundleIndex * 2 + 1,
		"the target is the provider-visible bundle protected at the end of the anchor",
	);
	assert.equal(
		textOf(resultById(visibleInitial.messages, `visible-surrogate-${protectedAnchorBundleIndex}`)!),
		"v",
		"the protected anchor bundle survives projection",
	);
	const visibleChanged = visibleController.project({ messages: replacementVisibleRaw, ...config });
	const visibleAfter = visibleController.serialize();
	assert.equal(visibleChanged.epochTransitioned, true);
	assert.equal(visibleChanged.transitionCause, "prefix_changed");
	assert.notEqual(visibleAfter.anchor.projectedHash, visibleBefore.anchor.projectedHash, "surviving provider-visible arguments change projected hash");
	assert.notEqual(visibleAfter.anchor.boundaryId, visibleBefore.anchor.boundaryId, "surviving provider-visible arguments change boundary ID");
	assert.notDeepEqual(visibleChanged.boundaryMarkers, visibleInitial.boundaryMarkers, "surviving provider-visible arguments change marker");
	assert.notDeepEqual(
		jsonNormalizedProviderMessages(visibleChanged.messages),
		jsonNormalizedProviderMessages(visibleInitial.messages),
		"lone surrogate and U+FFFD remain distinct in actual provider messages",
	);
	for (const persisted of [
		collapsedBefore,
		collapsedAfter,
		collapsedInitial.boundaryMarkers,
		collapsedChanged.boundaryMarkers,
		visibleBefore,
		visibleAfter,
		visibleInitial.boundaryMarkers,
		visibleChanged.boundaryMarkers,
	]) {
		assert.doesNotMatch(JSON.stringify(persisted), /ARG-SURROGATE-WIRE-SECRET/, "raw strings never enter state or markers");
	}

	const activeRaw = makeRaw("active-surrogate");
	setArguments(activeRaw, bundleCount - 1, lone);
	const activeController = new HistoryProjectionController();
	const activeInitial = activeController.project({ messages: activeRaw, ...config });
	const activeBefore = activeController.serialize();
	assert.ok(
		activeBefore.activeRawStartMessageCount <= (bundleCount - 1) * 2,
		"last bundle is in the previously observed active prefix",
	);
	const replacementActiveRaw = structuredClone(activeRaw);
	setArguments(replacementActiveRaw, bundleCount - 1, replacement);
	const activeChanged = activeController.project({ messages: replacementActiveRaw, ...config });
	const activeAfter = activeController.serialize();
	assert.equal(activeChanged.epochTransitioned, true);
	assert.equal(activeChanged.transitionCause, "prefix_changed");
	assert.notEqual(activeChanged.epochHash, activeInitial.epochHash, "observed active mutation creates a new safe epoch boundary");
	assert.notEqual(activeAfter.observedRawHash, activeBefore.observedRawHash);

	const textRaw = [user(`ordinary-${lone}`), ...makeRaw("text-surrogate")];
	const replacementTextRaw = structuredClone(textRaw) as Array<AgentMessage & { content?: unknown }>;
	replacementTextRaw[0]!.content = `ordinary-${replacement}`;
	assert.notEqual(`ordinary-${lone}`.replace("\ud800", ""), `ordinary-${replacement}`, "Pi's lone-surrogate deletion and U+FFFD payloads differ");
	const textController = new HistoryProjectionController();
	textController.project({ messages: textRaw, ...config });
	const textBefore = textController.serialize();
	const textChanged = textController.project({ messages: replacementTextRaw, ...config });
	const textAfter = textController.serialize();
	assert.equal(textChanged.epochTransitioned, true);
	assert.equal(textChanged.transitionCause, "prefix_changed");
	assert.notEqual(textAfter.observedRawHash, textBefore.observedRawHash);
	assert.notEqual(textAfter.anchor.rawHash, textBefore.anchor.rawHash);
	assert.notEqual(textAfter.anchor.projectedHash, textBefore.anchor.projectedHash);
	assert.notEqual(textAfter.anchor.boundaryId, textBefore.anchor.boundaryId);
});

test("v3 canonical UTF-16 hashing is stable across JSON round trips for lone, normal, and astral Unicode", () => {
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	for (const [label, probe] of [
		["lone-surrogate", "JSON-WIRE-\ud800-STABLE"],
		["normal-unicode", "café-漢字-ไทย"],
		["astral-unicode", "emoji-😀-music-𝄞"],
	] as const) {
		const raw: AgentMessage[] = [];
		for (let index = 0; index < 8; index += 1) raw.push(...bundle(`${label}-${index}`, label[0]!.repeat(20 * 1_024)));
		const first = raw[0] as unknown as { content: Array<Record<string, unknown>> };
		first.content[0]!.arguments = { probe };
		const controller = new HistoryProjectionController();
		const initial = controller.project({ messages: raw, ...config });
		assert.equal(initial.epochTransitioned, true, label);
		const before = controller.serialize();
		const wire = JSON.stringify(raw);
		if (label === "lone-surrogate") assert.match(wire, /\\ud800/, "JSON keeps the lone surrogate as an escape");
		const roundTripped = JSON.parse(wire) as AgentMessage[];
		const roundTrippedCall = roundTripped[0] as unknown as { content: Array<Record<string, unknown>> };
		assert.equal((roundTrippedCall.content[0]!.arguments as { probe: string }).probe, probe, label);
		const replayed = controller.project({ messages: roundTripped, ...config });
		assert.equal(replayed.epochTransitioned, false, label);
		assert.equal(replayed.transitionCause, "none", label);
		assert.deepEqual(controller.serialize(), before, `${label} hashes remain stable`);
		assert.deepEqual(replayed.boundaryMarkers, initial.boundaryMarkers, label);
	}
});

test("v3 canonical hashing follows provider JSON property enumeration order", () => {
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const bundleCount = HISTORY_MAX_BUNDLES + 2;
	const protectedAnchorBundleIndex = bundleCount - HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES - 1;
	const raw: AgentMessage[] = [];
	for (let index = 0; index < bundleCount; index += 1) raw.push(...bundle(`key-order-${index}`, "k"));
	const withArguments = (argumentsValue: Record<string, unknown>): AgentMessage[] => {
		const messages = structuredClone(raw);
		const protectedAnchorCall = messages[protectedAnchorBundleIndex * 2] as unknown as { content: Array<Record<string, unknown>> };
		protectedAnchorCall.content[0]!.arguments = argumentsValue;
		return messages;
	};
	const leftArguments = { a: 1, b: 2 };
	const rightArguments = { b: 2, a: 1 };
	assert.equal(JSON.stringify(leftArguments), '{"a":1,"b":2}');
	assert.equal(JSON.stringify(rightArguments), '{"b":2,"a":1}');
	assert.notEqual(JSON.stringify(leftArguments), JSON.stringify(rightArguments), "provider function_call.arguments wires differ");

	const leftController = new HistoryProjectionController();
	const leftProjection = leftController.project({ messages: withArguments(leftArguments), ...config });
	const left = leftController.serialize();
	const rightController = new HistoryProjectionController();
	const rightProjection = rightController.project({ messages: withArguments(rightArguments), ...config });
	const right = rightController.serialize();
	assert.ok(
		left.anchor.rawEndMessageCount > protectedAnchorBundleIndex * 2 + 1,
		"property order is measured on the provider-visible bundle protected at the end of the anchor",
	);
	assert.equal(textOf(resultById(leftProjection.messages, `key-order-${protectedAnchorBundleIndex}`)!), "k");
	assert.notEqual(left.observedRawHash, right.observedRawHash, "canonical full-history hashes differ");
	assert.notEqual(left.anchor.rawHash, right.anchor.rawHash, "frozen raw hashes differ");
	assert.notEqual(left.anchor.projectedHash, right.anchor.projectedHash, "projected hashes differ");
	assert.notEqual(left.anchor.boundaryId, right.anchor.boundaryId, "provider boundary IDs differ");
	assert.notEqual(leftProjection.boundaryMarkers[0]!.marker, rightProjection.boundaryMarkers[0]!.marker, "markers differ");
	assert.notDeepEqual(
		jsonNormalizedProviderMessages(leftProjection.messages),
		jsonNormalizedProviderMessages(rightProjection.messages),
		"provider-visible property order changes actual provider messages",
	);

	const changed = leftController.project({ messages: withArguments(rightArguments), ...config });
	assert.equal(changed.epochTransitioned, true);
	assert.equal(changed.transitionCause, "prefix_changed");

	const numericLeft = withArguments({ 2: "two", 1: "one", tail: true });
	const numericRightArguments: Record<string, unknown> = {};
	numericRightArguments["1"] = "one";
	numericRightArguments["2"] = "two";
	numericRightArguments.tail = true;
	const numericRight = withArguments(numericRightArguments);
	const numericLeftWire = JSON.stringify(((numericLeft[protectedAnchorBundleIndex * 2] as unknown as { content: Array<Record<string, unknown>> }).content[0]!.arguments));
	const numericRightWire = JSON.stringify(((numericRight[protectedAnchorBundleIndex * 2] as unknown as { content: Array<Record<string, unknown>> }).content[0]!.arguments));
	assert.equal(numericLeftWire, numericRightWire, "array-index keys enumerate ascending regardless of insertion");
	const numericLeftController = new HistoryProjectionController();
	const numericLeftProjection = numericLeftController.project({ messages: numericLeft, ...config });
	const numericRightController = new HistoryProjectionController();
	const numericRightProjection = numericRightController.project({ messages: numericRight, ...config });
	assert.equal(numericLeftController.serialize().observedRawHash, numericRightController.serialize().observedRawHash);
	assert.equal(numericLeftController.serialize().anchor.projectedHash, numericRightController.serialize().anchor.projectedHash);
	assert.equal(numericLeftController.serialize().anchor.boundaryId, numericRightController.serialize().anchor.boundaryId);
	assert.deepEqual(numericLeftProjection.boundaryMarkers, numericRightProjection.boundaryMarkers);
});

test("v3 canonical sparse arrays match JSON null semantics within bounded shapes", () => {
	const sparse: unknown[] = new Array(4);
	sparse[1] = "kept";
	sparse[3] = undefined;
	assert.equal(JSON.stringify(sparse), '[null,"kept",null,null]');
	const raw: AgentMessage[] = [];
	for (let index = 0; index < 8; index += 1) raw.push(...bundle(`sparse-json-${index}`, "s".repeat(20 * 1_024)));
	const first = raw[0] as unknown as { content: Array<Record<string, unknown>> };
	first.content[0]!.arguments = { sparse };
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const controller = new HistoryProjectionController();
	const initial = controller.project({ messages: raw, ...config });
	assert.equal(initial.epochTransitioned, true);
	const before = controller.serialize();
	const wire = JSON.stringify(raw);
	assert.match(wire, /\[null,"kept",null,null\]/);
	const roundTripped = JSON.parse(wire) as AgentMessage[];
	const replayed = controller.project({ messages: roundTripped, ...config });
	assert.equal(replayed.epochTransitioned, false);
	assert.equal(replayed.transitionCause, "none");
	assert.deepEqual(replayed.boundaryMarkers, initial.boundaryMarkers);
	assert.deepEqual(controller.serialize(), before, "holes and undefined hash exactly like JSON null entries");
});

test("v3 canonical validation bounds hostile shapes before any executable traversal", () => {
	const rawSecret = "CANONICAL-HOSTILE-RAW-SECRET";
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const argumentsMessages = (argumentsValue: Record<string, unknown>): AgentMessage[] => {
		const messages = bundle("canonical-hostile", "safe-result");
		const first = messages[0] as unknown as { content: Array<Record<string, unknown>> };
		first.content[0]!.arguments = argumentsValue;
		return messages;
	};
	const assertFixedFailure = (messages: readonly AgentMessage[], label: string): number => {
		const controller = new HistoryProjectionController();
		const started = process.hrtime.bigint();
		const projected = controller.project({ messages, ...config });
		const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
		assert.deepEqual(projected.messages, safeHistoryProjectionFailureMessages(), label);
		assert.equal(projected.transitionCause, "failure", label);
		assert.equal(projected.epochTransitioned, true, label);
		assert.equal(historyToolTextBytes(projected.messages), 0, label);
		assert.equal(validateContextToolPairing(projected.messages), true, label);
		assert.doesNotMatch(JSON.stringify(projected.messages), /CANONICAL-HOSTILE-RAW-SECRET/, label);
		assert.doesNotMatch(JSON.stringify(projected.boundaryMarkers), /CANONICAL-HOSTILE-RAW-SECRET/, label);
		assert.doesNotMatch(JSON.stringify(controller.serialize()), /CANONICAL-HOSTILE-RAW-SECRET/, label);
		return elapsedMs;
	};

	const hugeSparse: unknown[] = [];
	hugeSparse[0] = rawSecret;
	let hugeSparseGetterCalls = 0;
	Object.defineProperty(hugeSparse, "1", {
		enumerable: true,
		configurable: true,
		get(): string {
			hugeSparseGetterCalls += 1;
			return rawSecret;
		},
	});
	hugeSparse.length = 0xffff_ffff;
	const nestedSparseMs = assertFixedFailure(argumentsMessages({ payload: hugeSparse }), "huge nested sparse array");
	assert.equal(hugeSparseGetterCalls, 0, "nested sparse indices are never inspected after the length gate");
	assert.ok(nestedSparseMs < 2_000, `huge nested sparse array rejected in ${nestedSparseMs.toFixed(1)} ms`);

	const hugeRoot: AgentMessage[] = [];
	hugeRoot[0] = user(rawSecret);
	hugeRoot.length = 0xffff_ffff;
	const rootSparseMs = assertFixedFailure(hugeRoot, "huge root sparse history");
	assert.ok(rootSparseMs < 2_000, `huge root sparse history rejected in ${rootSparseMs.toFixed(1)} ms`);

	const oversizedDense = Array.from({ length: 100_000 }, (_, index) => index === 0 ? rawSecret : index);
	assertFixedFailure(argumentsMessages({ payload: oversizedDense }), "oversized dense array");
	const excessiveNestedWork = Array.from({ length: 24_000 }, (_, index) => (
		index === 0 ? [rawSecret, 1, 2] : [0, 1, 2]
	));
	assertFixedFailure(argumentsMessages({ payload: excessiveNestedWork }), "nested canonical node budget");

	let outerProxyTraps = 0;
	const outerProxy = new Proxy(bundle("outer-proxy", rawSecret), {
		get(): never { outerProxyTraps += 1; throw new Error(rawSecret); },
		ownKeys(): never { outerProxyTraps += 1; throw new Error(rawSecret); },
		getOwnPropertyDescriptor(): never { outerProxyTraps += 1; throw new Error(rawSecret); },
	});
	assertFixedFailure(outerProxy, "outer messages proxy");
	assert.equal(outerProxyTraps, 0, "outer proxy detection precedes every trap");

	const revokedOuter = Proxy.revocable(bundle("outer-revoked", rawSecret), {});
	revokedOuter.revoke();
	assertFixedFailure(revokedOuter.proxy, "outer revoked messages proxy");

	let iteratorCalls = 0;
	const iteratorMessages = bundle("outer-iterator", "safe-result");
	Object.defineProperty(iteratorMessages, Symbol.iterator, {
		configurable: true,
		value(): never {
			iteratorCalls += 1;
			throw new Error(rawSecret);
		},
	});
	assertFixedFailure(iteratorMessages, "outer messages own Symbol.iterator");
	assert.equal(iteratorCalls, 0, "own iterators are rejected before any array traversal");

	let outerIndexGetterCalls = 0;
	const outerIndexAccessor = bundle("outer-index", "safe-result");
	Object.defineProperty(outerIndexAccessor, "0", {
		enumerable: true,
		configurable: true,
		get(): AgentMessage {
			outerIndexGetterCalls += 1;
			return user(rawSecret);
		},
	});
	assertFixedFailure(outerIndexAccessor, "outer messages index accessor");
	assert.equal(outerIndexGetterCalls, 0, "outer index getter is rejected from its descriptor");

	let speciesGetterCalls = 0;
	const constructorMessages = bundle("content-constructor", "safe-result");
	const constructorContent = (constructorMessages[0] as unknown as { content: unknown[] }).content;
	const hostileConstructor: Record<PropertyKey, unknown> = {};
	Object.defineProperty(hostileConstructor, Symbol.species, {
		get(): never {
			speciesGetterCalls += 1;
			throw new Error(rawSecret);
		},
	});
	Object.defineProperty(constructorContent, "constructor", {
		configurable: true,
		value: hostileConstructor,
	});
	assertFixedFailure(constructorMessages, "assistant content own constructor and species");
	assert.equal(speciesGetterCalls, 0, "array constructor is rejected before species lookup");

	const extraPropertyMessages = bundle("content-extra", "safe-result");
	const extraPropertyContent = (extraPropertyMessages[0] as unknown as { content: unknown[] }).content;
	Object.defineProperty(extraPropertyContent, "extra", {
		configurable: true,
		enumerable: true,
		value: rawSecret,
	});
	assertFixedFailure(extraPropertyMessages, "assistant content extra string property");

	for (const [roleLabel, messageIndex] of [["assistant", 0], ["toolResult", 1]] as const) {
		let contentProxyTraps = 0;
		const proxiedContentMessages = bundle(`content-proxy-${roleLabel}`, "safe-result");
		const contentTarget = (proxiedContentMessages[messageIndex] as unknown as { content: unknown[] }).content;
		(proxiedContentMessages[messageIndex] as unknown as { content: unknown }).content = new Proxy(contentTarget, {
			get(): never { contentProxyTraps += 1; throw new Error(rawSecret); },
			ownKeys(): never { contentProxyTraps += 1; throw new Error(rawSecret); },
			getOwnPropertyDescriptor(): never { contentProxyTraps += 1; throw new Error(rawSecret); },
		});
		assertFixedFailure(proxiedContentMessages, `${roleLabel} content proxy`);
		assert.equal(contentProxyTraps, 0, `${roleLabel} proxy detection precedes every trap`);

		let contentIndexGetterCalls = 0;
		const accessorContentMessages = bundle(`content-index-${roleLabel}`, "safe-result");
		const accessorContent = (accessorContentMessages[messageIndex] as unknown as { content: unknown[] }).content;
		Object.defineProperty(accessorContent, "0", {
			enumerable: true,
			configurable: true,
			get(): unknown {
				contentIndexGetterCalls += 1;
				return roleLabel === "assistant"
					? { type: "toolCall", id: rawSecret, name: "hostile", arguments: {} }
					: { type: "text", text: rawSecret };
			},
		});
		assertFixedFailure(accessorContentMessages, `${roleLabel} content index accessor`);
		assert.equal(contentIndexGetterCalls, 0, `${roleLabel} index getter is rejected from its descriptor`);
	}
});

test("provider-visible tool fields invalidate v3 immutable prefixes", () => {
	const base: AgentMessage[] = [];
	for (let index = 0; index < 8; index += 1) base.push(...bundle(`visible-${index}`, "v".repeat(20 * 1_024)));
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	for (const [label, mutate] of [
		["arguments", (messages: AgentMessage[]) => {
			const message = messages[0] as unknown as { content: Array<Record<string, unknown>> };
			message.content[0]!.arguments = { changed: true };
		}],
		["call-id", (messages: AgentMessage[]) => {
			const call = (messages[0] as unknown as { content: Array<Record<string, unknown>> }).content[0]!;
			call.id = "visible-renamed";
			(messages[1] as unknown as { toolCallId: string }).toolCallId = "visible-renamed";
		}],
		["tool-name", (messages: AgentMessage[]) => {
			const call = (messages[0] as unknown as { content: Array<Record<string, unknown>> }).content[0]!;
			call.name = "visible-tool-renamed";
			(messages[1] as unknown as { toolName: string }).toolName = "visible-tool-renamed";
		}],
		["result-text", (messages: AgentMessage[]) => {
			const content = (messages[1] as unknown as { content: Array<Record<string, unknown>> }).content;
			content[0]!.text = "changed".repeat(1_500);
		}],
		["result-image", (messages: AgentMessage[]) => {
			const content = (messages[1] as unknown as { content: Array<Record<string, unknown>> }).content;
			content.push({ type: "image", data: "changed-image", mimeType: "image/png" });
		}],
		["is-error", (messages: AgentMessage[]) => {
			(messages[1] as unknown as { isError: boolean }).isError = true;
		}],
		["added-tools", (messages: AgentMessage[]) => {
			(messages[1] as unknown as { addedToolNames: string[] }).addedToolNames = ["future_tool"];
		}],
	] as const) {
		const controller = new HistoryProjectionController();
		assert.equal(controller.project({ messages: structuredClone(base), ...config }).epochTransitioned, true, label);
		const changed = structuredClone(base);
		mutate(changed);
		const projected = controller.project({ messages: changed, ...config });
		assert.equal(projected.epochTransitioned, true, label);
		assert.equal(projected.transitionCause, "prefix_changed", label);
		assert.equal(validateContextToolPairing(projected.messages), true, label);
	}
});

test("shortening a frozen history below the hard cap emits one restorable prefix boundary", () => {
	const raw: AgentMessage[] = [];
	for (let index = 0; index < 8; index += 1) raw.push(...bundle(`shortened-${index}`, "s".repeat(20 * 1_024)));
	const shortened = structuredClone(raw.slice(0, 4));
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const controller = new HistoryProjectionController();
	const initial = controller.project({ messages: raw, ...config });
	assert.equal(initial.epochTransitioned, true);
	assert.equal(controller.serialize().active, 1);

	const switched = controller.project({ messages: shortened, ...config });
	assert.equal(historyToolTextBytes(shortened) < WORKER_HISTORY_TOOL_TEXT_MAX_BYTES, true);
	assert.deepEqual(switched.messages, shortened, "the new under-cap history remains raw");
	assert.notEqual(switched.messages, shortened, "the caller-owned array is not reused");
	assert.equal(validateContextToolPairing(switched.messages), true);
	assert.equal(switched.transitionCause, "prefix_changed");
	assert.equal(switched.epochTransitioned, true);
	assert.equal(switched.epoch, initial.epoch + 1);
	assert.match(switched.epochHash ?? "", /^[0-9a-f]{64}$/);
	assert.equal(switched.segmentSealed, false);
	assert.equal(switched.segmentChainHash, null);
	assert.deepEqual(switched.boundaryMarkers, []);

	const inactive = JSON.parse(JSON.stringify(controller.serialize())) as SerializedV3ProjectionState;
	assert.equal(inactive.active, 0, "an under-cap switch must not create an unnecessary frozen topology");
	assert.equal(inactive.epoch, switched.epoch);
	const restored = new HistoryProjectionController();
	assert.equal(restored.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: inactive },
	]), true);
	const repeated = restored.project({ messages: structuredClone(shortened), ...config });
	assert.deepEqual(repeated.messages, shortened);
	assert.equal(repeated.transitionCause, "none");
	assert.equal(repeated.epochTransitioned, false, "the same raw boundary is not signalled twice after restore");
	assert.equal(repeated.epochHash, null);
	assert.deepEqual(restored.serialize(), inactive);
});

test("raising a frozen worker history to the Commander cap emits one restorable policy boundary", () => {
	const raw: AgentMessage[] = [];
	for (let index = 0; index < 8; index += 1) raw.push(...bundle(`role-switch-${index}`, "r".repeat(20 * 1_024)));
	const workerConfig = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const commanderConfig = {
		...workerConfig,
		maxToolTextBytes: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
		role: "commander" as const,
	};
	const controller = new HistoryProjectionController();
	const initial = controller.project({ messages: raw, ...workerConfig });
	assert.equal(initial.epochTransitioned, true);
	assert.equal(controller.serialize().active, 1);

	const switched = controller.project({ messages: raw, ...commanderConfig });
	assert.equal(historyToolTextBytes(raw) < COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES, true);
	assert.deepEqual(switched.messages, raw, "the Commander receives the now-under-cap history unchanged");
	assert.equal(validateContextToolPairing(switched.messages), true);
	assert.equal(switched.transitionCause, "policy_changed");
	assert.equal(switched.epochTransitioned, true);
	assert.equal(switched.epoch, initial.epoch + 1);
	assert.match(switched.epochHash ?? "", /^[0-9a-f]{64}$/);
	assert.equal(switched.segmentSealed, false);
	assert.equal(switched.segmentChainHash, null);
	assert.deepEqual(switched.boundaryMarkers, []);

	const inactive = JSON.parse(JSON.stringify(controller.serialize())) as SerializedV3ProjectionState;
	assert.equal(inactive.active, 0, "the higher cap must not synthesize an active topology");
	assert.equal(inactive.epoch, switched.epoch);
	const restored = new HistoryProjectionController();
	assert.equal(restored.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: inactive },
	]), true);
	const repeated = restored.project({ messages: structuredClone(raw), ...commanderConfig });
	assert.deepEqual(repeated.messages, raw);
	assert.equal(repeated.transitionCause, "none");
	assert.equal(repeated.epochTransitioned, false, "the same Commander policy boundary is not signalled twice after restore");
	assert.equal(repeated.epochHash, null);
	assert.deepEqual(restored.serialize(), inactive);
});

test("f84409c v3 Commander/worker goldens migrate exactly once across the raised caps", () => {
	/*
	 * Golden provenance: git object f84409cbdebb75785efbe6cebd055763560a9584 was
	 * extracted with `git archive` into an isolated temporary directory. Node's
	 * strip-types loader imported that commit's context-history-budget.ts and
	 * output-policy.ts, then project()+serialize() ran against legacyFixture()
	 * below. The emitted JSON was copied verbatim; the current controller never
	 * produces expected state. Fixture text is synthetic repeated digits only.
	 */
	const legacyFixture = (
		role: "commander" | "worker",
		startTimestamp: number,
	): AgentMessage[] => {
		let timestamp = startTimestamp;
		const messages: AgentMessage[] = [asMessage({
			role: "user",
			content: `legacy-${role}-request`,
			timestamp: timestamp++,
		})];
		for (const [index, size] of [50 * 1_024, 50 * 1_024, 40 * 1_024].entries()) {
			const id = `legacy-${role}-${index}`;
			messages.push(asMessage({
				role: "assistant",
				content: [{ type: "toolCall", id, name: `tool_${id}`, arguments: {} }],
				api: "test",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: timestamp++,
			}));
			messages.push(asMessage({
				role: "toolResult",
				toolCallId: id,
				toolName: `tool_${id}`,
				content: [{ type: "text", text: String(index).repeat(size) }],
				isError: false,
				timestamp: timestamp++,
			}));
		}
		return messages;
	};

	const commander96KiB = JSON.parse(`{
		"schemaVersion": 3,
		"active": 1,
		"epoch": 1,
		"epochHash": "d9046cf673576bf5c3c74103ce954afb972f314552d3f300169c371aee437699",
		"segmentChainHash": "88938905172806274fd33d942f523b42d5ab2b7ba1e792d2e6295c1081f4e3d4",
		"hardToolTextBytes": 98304,
		"hardBundles": 128,
		"descriptorMaxBytes": 384,
		"anchorToolTextBytes": 26624,
		"anchorBundles": 96,
		"anchor": {
			"rawStartMessageCount": 0,
			"rawEndMessageCount": 5,
			"rawHash": "05bf283752c6e1801307bb59a9cd478d04cb27486af99c5b184e9d5510eec51f",
			"projectedMessageCount": 6,
			"projectedHash": "a6af6345a2d9d69d0b6873fab1fb938ac0b30b8922da5d293c5fb31088c740cd",
			"projectedToolTextBytes": 167,
			"projectedBundles": 1,
			"boundaryId": "9ffabf3deb4a9b5ed6249cbbb38b663fb6ed9104c9eba1cc707292472c979c8f",
			"collapsedResults": 2,
			"removedBundles": 1
		},
		"segments": [],
		"activeRawStartMessageCount": 5,
		"observedRawMessageCount": 7,
		"observedRawHash": "0b9eb3a0c98582c8b8567cb630210d8f47438ea60ca33ea3d7cce9f56447adfe",
		"transitionCollapsedResults": 2,
		"transitionRemovedBundles": 1,
		"rawToolTextBytes": 143360,
		"rawBundles": 3,
		"projectedToolTextBytes": 41127,
		"projectedBundles": 2,
		"stateHash": "eb061ba559f523abad8f8982555a15c05b0ee864a3b7b48509bf99e41b1a2e63"
	}`) as SerializedV3ProjectionState;
	const worker64KiB = JSON.parse(`{
		"schemaVersion": 3,
		"active": 1,
		"epoch": 1,
		"epochHash": "a9ac78e3392f96c17db992df9122d1d5081ab206bdad9e6f301d6d48febe6de9",
		"segmentChainHash": "363c3ffe439fdb7ab1f2d7aa523ac10ac394dc19e96390416c1a2048d364e881",
		"hardToolTextBytes": 65536,
		"hardBundles": 128,
		"descriptorMaxBytes": 384,
		"anchorToolTextBytes": 10240,
		"anchorBundles": 96,
		"anchor": {
			"rawStartMessageCount": 0,
			"rawEndMessageCount": 5,
			"rawHash": "2537f881b090e55dccb557ad6987bada603e51e03be7c911e17ec928934c7813",
			"projectedMessageCount": 6,
			"projectedHash": "baa037bcfd374420970c54fbc1aeac0aeba750852c599bc2c3a447533a377aba",
			"projectedToolTextBytes": 164,
			"projectedBundles": 1,
			"boundaryId": "1d5d93ad939c71a2b3fdca8628f78a04c3801255f251ff8bacd95f280f23e84c",
			"collapsedResults": 2,
			"removedBundles": 1
		},
		"segments": [],
		"activeRawStartMessageCount": 5,
		"observedRawMessageCount": 7,
		"observedRawHash": "2b6cddeadf5c98a7e8513f97ebf07a43e2ea750593949e392f5cf088303847e4",
		"transitionCollapsedResults": 2,
		"transitionRemovedBundles": 1,
		"rawToolTextBytes": 143360,
		"rawBundles": 3,
		"projectedToolTextBytes": 41124,
		"projectedBundles": 2,
		"stateHash": "ba8eed2e999f7a03b31532674ee3c87e5b20db1b8f439e8ad16a0f141a6299d0"
	}`) as SerializedV3ProjectionState;

	const scenarios = [
		{
			label: "Commander 96 KiB golden becomes raw under the 192 KiB cap",
			role: "commander" as const,
			newHard: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
			startTimestamp: 41_001,
			golden: commander96KiB,
			expectation: "inactive" as const,
		},
		{
			label: "worker 64 KiB golden remains over the 128 KiB cap",
			role: "worker" as const,
			newHard: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
			startTimestamp: 42_001,
			golden: worker64KiB,
			expectation: "checkpoint" as const,
		},
	];

	for (const scenario of scenarios) {
		const raw = legacyFixture(scenario.role, scenario.startTimestamp);
		assert.equal(historyToolTextBytes(raw), 140 * 1_024, scenario.label);
		assert.equal(v3StateHash(scenario.golden), scenario.golden.stateHash, scenario.label);
		assert.equal(
			historyToolTextBytes(raw) <= scenario.newHard,
			scenario.expectation === "inactive",
			scenario.label,
		);

		const migrated = new HistoryProjectionController();
		assert.equal(migrated.restoreFromEntries([{
			type: "custom",
			customType: HISTORY_PROJECTION_ENTRY_TYPE,
			data: JSON.parse(JSON.stringify(scenario.golden)),
		}]), true, scenario.label);
		const projected = migrated.project({
			messages: JSON.parse(JSON.stringify(raw)) as AgentMessage[],
			maxToolTextBytes: scenario.newHard,
			maxBundles: HISTORY_MAX_BUNDLES,
			descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
			role: scenario.role,
		});
		const migratedState = JSON.parse(JSON.stringify(migrated.serialize())) as SerializedV3ProjectionState;
		assert.equal(projected.transitionCause, "policy_changed", scenario.label);
		assert.equal(projected.epochTransitioned, true, scenario.label);
		assert.equal(projected.segmentSealed, false, scenario.label);
		assert.equal(projected.epoch, scenario.golden.epoch + 1, scenario.label);
		assert.equal(validateContextToolPairing(projected.messages), true, scenario.label);
		assert.ok(historyToolTextBytes(projected.messages) <= scenario.newHard, scenario.label);
		assert.ok(callBundleCount(projected.messages) <= HISTORY_MAX_BUNDLES, scenario.label);

		if (scenario.expectation === "inactive") {
			assert.equal(projected.observability.eventKind, "inactive_boundary", scenario.label);
			assert.equal(migratedState.active, 0, scenario.label);
			assert.deepEqual(
				jsonNormalizedProviderMessages(projected.messages),
				jsonNormalizedProviderMessages(raw),
				scenario.label,
			);
		} else {
			assert.equal(projected.observability.eventKind, "epoch_checkpoint", scenario.label);
			assert.equal(migratedState.active, 1, scenario.label);
			assert.equal(migratedState.hardToolTextBytes, WORKER_HISTORY_TOOL_TEXT_MAX_BYTES, scenario.label);
			assert.equal(
				migratedState.anchorToolTextBytes,
				WORKER_HISTORY_TOOL_TEXT_MAX_BYTES - WORKER_TURN_MAX_BYTES
					- HISTORY_PROJECTION_MAX_SEGMENTS * HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES,
				scenario.label,
			);
			assert.equal(
				textOf(resultById(projected.messages, "legacy-worker-2")!),
				"2".repeat(40 * 1_024),
				"the newest complete worker result stays raw through the new-cap checkpoint",
			);
		}

		const reloaded = new HistoryProjectionController();
		assert.equal(reloaded.restoreFromEntries([{
			type: "custom",
			customType: HISTORY_PROJECTION_ENTRY_TYPE,
			data: migratedState,
		}]), true, scenario.label);
		const repeated = reloaded.project({
			messages: JSON.parse(JSON.stringify(raw)) as AgentMessage[],
			maxToolTextBytes: scenario.newHard,
			maxBundles: HISTORY_MAX_BUNDLES,
			descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
			role: scenario.role,
		});
		assert.equal(repeated.transitionCause, "none", scenario.label);
		assert.equal(repeated.epochTransitioned, false, scenario.label);
		assert.equal(repeated.observability.eventKind, "none", scenario.label);
		assert.deepEqual(
			jsonNormalizedProviderMessages(repeated.messages),
			jsonNormalizedProviderMessages(projected.messages),
			scenario.label,
		);
		assert.deepEqual(reloaded.serialize(), migratedState, scenario.label);
	}
});

test("legacy v1/v2 states migrate pressure and epoch only; newest matching malformed wins", () => {
	const hex = (character: string): string => character.repeat(64);
	const legacy = {
		schemaVersion: 1,
		active: 1,
		epoch: 7,
		epochHash: hex("1"),
		prefixMessageCount: 4,
		prefixHash: hex("2"),
		projectedPrefixHash: hex("3"),
		hardToolTextBytes: 64 * 1_024,
		hardBundles: HISTORY_MAX_BUNDLES,
		lowToolTextBytes: 48 * 1_024,
		lowBundles: 96,
		transitionCollapsedResults: 2,
		transitionRemovedBundles: 1,
		rawToolTextBytes: 70 * 1_024,
		rawBundles: 9,
		projectedToolTextBytes: 40 * 1_024,
		projectedBundles: 8,
	};
	const controller = new HistoryProjectionController();
	assert.equal(controller.restoreFromEntries([
		{ type: "custom", customType: "workbench-history-projection-state-v1", data: legacy },
	]), true);
	const migrated = controller.serialize() as unknown as Record<string, unknown>;
	assert.equal(migrated.schemaVersion, 3);
	assert.equal(migrated.active, 0, "legacy frozen hashes are never reused");
	assert.equal(migrated.epoch, 7);
	assert.equal(migrated.epochHash, "0".repeat(64), "legacy v1 never inherits failure-boundary mode");
	assert.equal(migrated.rawToolTextBytes, legacy.rawToolTextBytes);
	assert.equal(migrated.projectedToolTextBytes, legacy.projectedToolTextBytes);

	const legacyV2: Record<string, unknown> = {
		schemaVersion: 2,
		active: 1,
		epoch: 11,
		epochHash: "0".repeat(64),
		hardToolTextBytes: 64 * 1_024,
		hardBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		anchorToolTextBytes: 16 * 1_024,
		anchorBundles: 96,
		anchorRawMessageCount: 10,
		anchorRawHash: hex("2"),
		anchorProjectedHash: hex("3"),
		anchorProjectedMessageCount: 2,
		anchorProjectedToolTextBytes: 100,
		anchorProjectedBundles: 1,
		sealedTailRawMessageCount: 12,
		sealedTailRawHash: hex("4"),
		sealedTailToolTextBytes: 16 * 1_024 - 100,
		sealedTailBundles: 95,
		sealedTailProjectedHash: hex("5"),
		sealedTailProjectedMessageCount: 2,
		sealedTailProjectedToolTextBytes: 100,
		sealedTailProjectedBundles: 1,
		observedRawMessageCount: 14,
		observedRawHash: hex("6"),
		transitionCollapsedResults: 2,
		transitionRemovedBundles: 1,
		rawToolTextBytes: 70 * 1_024,
		rawBundles: 9,
		projectedToolTextBytes: 40 * 1_024,
		projectedBundles: 8,
	};
	legacyV2.epochHash = v2EpochHash(legacyV2);
	const v2Controller = new HistoryProjectionController();
	assert.equal(v2Controller.restoreFromEntries([
		{ type: "custom", customType: "workbench-history-projection-state-v2", data: legacyV2 },
	]), true);
	const migratedV2 = v2Controller.serialize();
	assert.equal(migratedV2.schemaVersion, 3);
	assert.equal(migratedV2.active, 0, "v2 topology is never reused");
	assert.equal(migratedV2.epoch, 11);
	assert.equal(migratedV2.epochHash, "0".repeat(64), "legacy v2 never inherits failure-boundary mode");
	assert.equal(migratedV2.rawToolTextBytes, legacyV2.rawToolTextBytes);
	assert.equal(migratedV2.projectedToolTextBytes, legacyV2.projectedToolTextBytes);

	const underCapSecret = "LEGACY-UNDER-CAP-RAW-SECRET";
	const underCapRaw: AgentMessage[] = [user("legacy under cap"), ...bundle("legacy-under-cap", underCapSecret)];
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const assertUnderCapMigration = (
		customType: string,
		state: unknown,
		initialEpoch: number,
		label: string,
	): void => {
		const migrating = new HistoryProjectionController();
		assert.equal(migrating.restoreFromEntries([
			{ type: "custom", customType, data: JSON.parse(JSON.stringify(state)) as unknown },
		]), true, label);
		const migratedResult = migrating.project({ messages: underCapRaw, ...config });
		assert.deepEqual(migratedResult.messages, underCapRaw, label);
		assert.notEqual(migratedResult.messages, underCapRaw, label);
		assert.equal(validateContextToolPairing(migratedResult.messages), true, label);
		assert.equal(migratedResult.transitionCause, "legacy_migration", label);
		assert.equal(migratedResult.epochTransitioned, true, label);
		assert.equal(migratedResult.epoch, initialEpoch + 1, label);
		assert.match(migratedResult.epochHash ?? "", /^[0-9a-f]{64}$/, label);
		assert.equal(migratedResult.segmentSealed, false, label);
		assert.equal(migratedResult.segmentChainHash, null, label);
		assert.deepEqual(migratedResult.boundaryMarkers, [], label);

		const inactive = JSON.parse(JSON.stringify(migrating.serialize())) as SerializedV3ProjectionState;
		assert.equal(inactive.schemaVersion, 3, label);
		assert.equal(inactive.active, 0, label);
		assert.equal(inactive.epoch, initialEpoch + 1, label);
		assert.doesNotMatch(JSON.stringify(inactive), new RegExp(underCapSecret), label);
		const restoredInactive = new HistoryProjectionController();
		assert.equal(restoredInactive.restoreFromEntries([
			{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: inactive },
		]), true, label);
		const repeated = restoredInactive.project({ messages: structuredClone(underCapRaw), ...config });
		assert.deepEqual(repeated.messages, underCapRaw, label);
		assert.equal(repeated.transitionCause, "none", label);
		assert.equal(repeated.epochTransitioned, false, label);
		assert.equal(repeated.epochHash, null, label);
		assert.deepEqual(restoredInactive.serialize(), inactive, label);
	};
	assertUnderCapMigration("workbench-history-projection-state-v1", legacy, 7, "legacy v1 under cap");
	assertUnderCapMigration("workbench-history-projection-state-v2", legacyV2, 11, "legacy v2 under cap");

	const raw: AgentMessage[] = [];
	for (let index = 0; index < 8; index += 1) raw.push(...bundle(`migration-${index}`, "m".repeat(20 * 1_024)));
	const projected = controller.project({
		messages: raw,
		...config,
	});
	assert.equal(projected.epochTransitioned, true);
	assert.equal(projected.transitionCause, "legacy_migration");
	assert.ok(projected.epoch > legacy.epoch);
	const projectedV2 = v2Controller.project({ messages: structuredClone(raw), ...config });
	assert.equal(projectedV2.epochTransitioned, true);
	assert.equal(projectedV2.transitionCause, "legacy_migration");
	assert.ok(projectedV2.epoch > (legacyV2.epoch as number));

	const strictRoundTrip = JSON.parse(JSON.stringify(controller.serialize())) as unknown;
	const restored = new HistoryProjectionController();
	assert.equal(restored.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: strictRoundTrip },
	]), true);
	assert.deepEqual(restored.serialize(), strictRoundTrip);

	const unsafeV1 = new HistoryProjectionController();
	assert.equal(unsafeV1.restoreFromEntries([
		{
			type: "custom",
			customType: "workbench-history-projection-state-v1",
			data: { ...legacy, epoch: Number.MAX_SAFE_INTEGER },
		},
	]), false, "legacy v1 cannot consume the increment margin");
	assert.equal(unsafeV1.serialize().epoch, 0);

	const unsafeV2State: Record<string, unknown> = { ...legacyV2, epoch: Number.MAX_SAFE_INTEGER };
	unsafeV2State.epochHash = v2EpochHash(unsafeV2State);
	const unsafeV2 = new HistoryProjectionController();
	assert.equal(unsafeV2.restoreFromEntries([
		{ type: "custom", customType: "workbench-history-projection-state-v2", data: unsafeV2State },
	]), false, "correctly signed legacy v2 cannot consume the increment margin");
	assert.equal(unsafeV2.serialize().epoch, 0);

	const maximumLegacy = new HistoryProjectionController();
	assert.equal(maximumLegacy.restoreFromEntries([
		{
			type: "custom",
			customType: "workbench-history-projection-state-v1",
			data: { ...legacy, epoch: HISTORY_PROJECTION_MAX_EPOCH },
		},
	]), true, "the maximum legacy epoch remains restorable for fail-closed handling");
	const exhaustedMigration = maximumLegacy.project({ messages: underCapRaw, ...config });
	assert.equal(exhaustedMigration.transitionCause, "failure");
	assert.equal(exhaustedMigration.epoch, HISTORY_PROJECTION_MAX_EPOCH);
	assert.equal((exhaustedMigration.messages[0] as { customType?: unknown }).customType, "workbench-history-projection-failure");
	assert.doesNotMatch(JSON.stringify(exhaustedMigration.messages), new RegExp(underCapSecret));
	assert.equal(maximumLegacy.serialize().active, 0);
	assert.equal(maximumLegacy.serialize().epoch, HISTORY_PROJECTION_MAX_EPOCH);

	const poisoned = new HistoryProjectionController();
	assert.equal(poisoned.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: strictRoundTrip },
		{ type: "custom", customType: "workbench-history-projection-state-v1", data: { ...legacy, extra: true } },
	]), false, "latest matching malformed legacy entry prevents fallback to older valid v3 state");
	assert.equal(poisoned.serialize().epoch, 0);
});

test("v3 epoch advancement is bounded, signed, serializable, and fails closed at exhaustion", () => {
	const raw: AgentMessage[] = [];
	for (let index = 0; index < 8; index += 1) {
		raw.push(...bundle(`epoch-boundary-${index}`, String(index).repeat(20 * 1_024)));
	}
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const source = new HistoryProjectionController();
	assert.equal(source.project({ messages: raw, ...config }).epochTransitioned, true);
	const baseState = source.serialize();
	assert.equal(baseState.active, 1);

	const nearMaximumState = resignV3ProjectionEpoch(baseState, HISTORY_PROJECTION_MAX_EPOCH - 1);
	const nearMaximum = new HistoryProjectionController();
	assert.equal(nearMaximum.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: JSON.parse(JSON.stringify(nearMaximumState)) },
	]), true, "a correctly signed v3 epoch immediately below the maximum remains restorable");
	assert.deepEqual(nearMaximum.serialize(), nearMaximumState);

	const unsafeState = resignV3ProjectionEpoch(baseState, Number.MAX_SAFE_INTEGER);
	assert.equal(new HistoryProjectionController().restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: unsafeState },
	]), false, "even a correctly signed v3 state must preserve one safe increment margin");

	const advancingRaw = structuredClone(raw);
	const advancingResult = advancingRaw.find((message) => (
		(message as { role?: unknown }).role === "toolResult"
	)) as unknown as { content: Array<{ type: string; text?: string }> };
	advancingResult.content[0]!.text = "a".repeat(10 * 1_024);
	const advanced = nearMaximum.project({ messages: advancingRaw, ...config });
	assert.equal(advanced.transitionCause, "prefix_changed");
	assert.equal(advanced.epochTransitioned, true);
	assert.equal(advanced.epoch, HISTORY_PROJECTION_MAX_EPOCH, "the final safe advancement reaches the explicit maximum");
	assert.equal(Number.isSafeInteger(advanced.epoch), true);
	const maximumState = JSON.parse(JSON.stringify(nearMaximum.serialize())) as SerializedV3ProjectionState;
	assert.equal(maximumState.epoch, HISTORY_PROJECTION_MAX_EPOCH);
	assert.equal(maximumState.active, 1);
	const maximumRoundTrip = new HistoryProjectionController();
	assert.equal(maximumRoundTrip.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: maximumState },
	]), true, "a correctly signed maximum v3 epoch survives JSONL round trip");
	assert.deepEqual(maximumRoundTrip.serialize(), maximumState);

	const rawSecret = "EPOCH-EXHAUSTION-RAW-SECRET";
	const changedAtMaximum = structuredClone(advancingRaw);
	const exhaustedResult = changedAtMaximum.find((message) => (
		(message as { role?: unknown }).role === "toolResult"
	)) as unknown as { content: Array<{ type: string; text?: string }> };
	exhaustedResult.content[0]!.text = rawSecret + "z".repeat(10 * 1_024);
	const exhausted = maximumRoundTrip.project({ messages: changedAtMaximum, ...config });
	assert.equal(exhausted.transitionCause, "failure");
	assert.equal(exhausted.epoch, HISTORY_PROJECTION_MAX_EPOCH);
	assert.equal(Number.isSafeInteger(exhausted.epoch), true);
	assert.equal((exhausted.messages[0] as { customType?: unknown }).customType, "workbench-history-projection-failure");
	assert.doesNotMatch(JSON.stringify(exhausted.messages), new RegExp(rawSecret));
	const exhaustedState = JSON.parse(JSON.stringify(maximumRoundTrip.serialize())) as SerializedV3ProjectionState;
	assert.equal(exhaustedState.active, 0);
	assert.equal(exhaustedState.epoch, HISTORY_PROJECTION_MAX_EPOCH);
	assert.equal(exhaustedState.epochHash, exhausted.epochHash, "the max-epoch fixed failure remains durable");
	assert.equal(Number.isSafeInteger(exhaustedState.epoch), true);
	assert.doesNotMatch(JSON.stringify(exhaustedState), new RegExp(rawSecret));
	const exhaustedRoundTrip = new HistoryProjectionController();
	assert.equal(exhaustedRoundTrip.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: exhaustedState },
	]), true, "epoch exhaustion must retain a strict restorable state");
	assert.deepEqual(exhaustedRoundTrip.serialize(), exhaustedState);

	const underCapMaximum = new HistoryProjectionController();
	assert.equal(underCapMaximum.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: maximumState },
	]), true);
	const underCapSecret = "EPOCH-EXHAUSTION-UNDER-CAP-SECRET";
	const shortenedAtMaximum = structuredClone(advancingRaw.slice(0, 4));
	const shortenedResult = shortenedAtMaximum.find((message) => (
		(message as { role?: unknown }).role === "toolResult"
	)) as unknown as { content: Array<{ type: string; text?: string }> };
	shortenedResult.content[0]!.text = underCapSecret;
	assert.ok(historyToolTextBytes(shortenedAtMaximum) < WORKER_HISTORY_TOOL_TEXT_MAX_BYTES);
	const exhaustedUnderCap = underCapMaximum.project({ messages: shortenedAtMaximum, ...config });
	assert.equal(exhaustedUnderCap.transitionCause, "failure");
	assert.equal(exhaustedUnderCap.epoch, HISTORY_PROJECTION_MAX_EPOCH);
	assert.equal((exhaustedUnderCap.messages[0] as { customType?: unknown }).customType, "workbench-history-projection-failure");
	assert.doesNotMatch(JSON.stringify(exhaustedUnderCap.messages), new RegExp(underCapSecret));
	assert.equal(underCapMaximum.serialize().active, 0);
	assert.equal(new HistoryProjectionController().restoreFromEntries([
		{
			type: "custom",
			customType: HISTORY_PROJECTION_ENTRY_TYPE,
			data: JSON.parse(JSON.stringify(underCapMaximum.serialize())),
		},
	]), true, "the exhausted under-cap failure remains a strict inactive v3 state");

	const resetAtMaximum = new HistoryProjectionController();
	assert.equal(resetAtMaximum.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: maximumState },
	]), true);
	resetAtMaximum.reset();
	const resetState = JSON.parse(JSON.stringify(resetAtMaximum.serialize())) as SerializedV3ProjectionState;
	assert.equal(resetState.active, 0);
	assert.equal(resetState.epoch, HISTORY_PROJECTION_MAX_EPOCH, "reset cannot overflow or roll the epoch back");
	assert.equal(resetState.epochHash, "0".repeat(64), "reset clears failure-boundary mode");
	assert.equal(Number.isSafeInteger(resetState.epoch), true);
	assert.equal(new HistoryProjectionController().restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: resetState },
	]), true);
	const failedAfterReset = resetAtMaximum.project({ messages: changedAtMaximum, ...config });
	assert.equal(failedAfterReset.transitionCause, "failure");
	assert.equal(failedAfterReset.epoch, HISTORY_PROJECTION_MAX_EPOCH);
	assert.doesNotMatch(JSON.stringify(failedAfterReset.messages), new RegExp(rawSecret));
});

test("history projection state restores strictly and reset invalidates the frozen boundary", () => {
	const raw: AgentMessage[] = [];
	const stateRawSecret = "STATE-RAW-SECRET";
	for (let index = 0; index < 30; index += 1) raw.push(...bundle(`restore-${index}`, stateRawSecret.repeat(15)));
	const config = {
		maxToolTextBytes: 4_096,
		maxBundles: 128,
		descriptorMaxBytes: 48,
		role: "worker" as const,
	};
	const first = new HistoryProjectionController();
	const initial = first.project({ messages: raw, ...config });
	assert.equal(initial.epochTransitioned, true);
	const persisted = JSON.parse(JSON.stringify(first.serialize())) as ReturnType<HistoryProjectionController["serialize"]>;
	assert.deepEqual(Object.keys(persisted).sort(), [
		"active", "activeRawStartMessageCount", "anchor", "anchorBundles", "anchorToolTextBytes", "descriptorMaxBytes",
		"epoch", "epochHash", "hardBundles", "hardToolTextBytes", "observedRawHash", "observedRawMessageCount",
		"projectedBundles", "projectedToolTextBytes", "rawBundles", "rawToolTextBytes", "schemaVersion",
		"segmentChainHash", "segments", "stateHash",
		"transitionCollapsedResults", "transitionRemovedBundles",
	].sort());
	for (const [key, value] of Object.entries(persisted)) {
		if (key.endsWith("Hash")) assert.match(String(value), /^[0-9a-f]{64}$/, key);
		else if (key === "anchor" || key === "segments") continue;
		else assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, key);
	}
	for (const slice of [persisted.anchor, ...persisted.segments]) {
		assert.deepEqual(Object.keys(slice).sort(), [
			"boundaryId", "collapsedResults", "projectedBundles", "projectedHash", "projectedMessageCount",
			"projectedToolTextBytes", "rawEndMessageCount", "rawHash", "rawStartMessageCount", "removedBundles",
		].sort());
		for (const [key, value] of Object.entries(slice)) {
			if (key.endsWith("Hash") || key === "boundaryId") assert.match(String(value), /^[0-9a-f]{64}$/, key);
			else assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, key);
		}
	}
	assert.ok(Buffer.byteLength(JSON.stringify(persisted), "utf8") <= 32 * 1_024);
	assert.doesNotMatch(JSON.stringify(persisted), /STATE-RAW-SECRET/);

	const restored = new HistoryProjectionController();
	assert.equal(restored.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: persisted },
	]), true);
	const reloadedRaw = JSON.parse(JSON.stringify(raw)) as AgentMessage[];
	const replayed = restored.project({ messages: reloadedRaw, ...config });
	assert.equal(replayed.epochTransitioned, false);
	assert.equal(replayed.segmentSealed, false);
	assert.deepEqual(
		jsonNormalizedProviderMessages(replayed.messages),
		jsonNormalizedProviderMessages(initial.messages),
	);
	assert.deepEqual(restored.serialize(), persisted);

	const initialProvider = jsonNormalizedProviderMessages(initial.messages);
	reloadedRaw.push(user("after-reload"), ...bundle("restore-suffix", "suffix"));
	const continued = restored.project({ messages: reloadedRaw, ...config });
	assert.equal(continued.epochTransitioned, false);
	assert.equal(continued.segmentSealed, false, "an active-reserve crossing under the hard cap stays append-only after reload");
	assert.equal(continued.transitionCause, "none");
	assert.deepEqual(
		jsonNormalizedProviderMessages(continued.messages).slice(0, initialProvider.length),
		initialProvider,
	);
	const continuedState = JSON.parse(JSON.stringify(restored.serialize())) as SerializedV3ProjectionState;
	assert.ok(
		callBundleCount(reloadedRaw.slice(continuedState.activeRawStartMessageCount)) > HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES,
		"restored active tail exceeds its reserved bundle count without exceeding the hard cap",
	);
	assert.ok(continued.projectedBundleCount <= config.maxBundles);
	const continuedReload = new HistoryProjectionController();
	assert.equal(continuedReload.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: continuedState },
	]), true, "v3 restore accepts an under-hard active tail above the turn reserve");
	const continuedReplay = continuedReload.project({
		messages: JSON.parse(JSON.stringify(reloadedRaw)) as AgentMessage[],
		...config,
	});
	assert.equal(continuedReplay.segmentSealed, false);
	assert.equal(continuedReplay.transitionCause, "none");
	assert.deepEqual(jsonNormalizedProviderMessages(continuedReplay.messages), jsonNormalizedProviderMessages(continued.messages));

	const hostile = new HistoryProjectionController();
	assert.equal(hostile.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: { ...persisted, extra: "secret" } },
	]), false);
	hostile.reset();
	const afterReset = hostile.project({ messages: reloadedRaw, ...config });
	assert.equal(afterReset.epochTransitioned, true);
	assert.notEqual(afterReset.epochHash, initial.epochHash, "changed raw boundary derives a new epoch hash");
});

test("history epoch hashing executes no getters, toJSON hooks, or proxy traps and fails closed", () => {
	const rawSecret = `RAW-HASH-SECRET-${"z".repeat(5_000)}`;
	const config = {
		maxToolTextBytes: 1_024,
		maxBundles: 128,
		descriptorMaxBytes: 32,
		role: "worker" as const,
	};
	const assertTerminalFailure = (messages: AgentMessage[], label: string): void => {
		const projected = new HistoryProjectionController().project({ messages, ...config });
		assert.equal(projected.messages.length, 1, label);
		assert.equal((projected.messages[0] as { customType?: unknown }).customType, "workbench-history-projection-failure", label);
		assert.equal(historyToolTextBytes(projected.messages), 0, label);
		assert.equal(validateContextToolPairing(projected.messages), true, label);
		assert.doesNotMatch(textOf(projected.messages[0]!), /RAW-HASH-SECRET|HOSTILE-HASH/, label);
	};

	let getterCalls = 0;
	const getterMessage: Record<string, unknown> = { role: "user", timestamp: 1 };
	Object.defineProperty(getterMessage, "content", {
		enumerable: true,
		get(): never {
			getterCalls += 1;
			throw new Error("HOSTILE-HASH-GETTER");
		},
	});
	assertTerminalFailure([
		getterMessage as unknown as AgentMessage,
		...bundle("hash-getter", rawSecret),
	], "getter");
	assert.equal(getterCalls, 0, "canonical hashing must inspect descriptors without invoking getters");

	let toJsonCalls = 0;
	const toJsonMessage = {
		role: "user",
		content: "safe",
		timestamp: 2,
		toJSON(): never {
			toJsonCalls += 1;
			throw new Error("HOSTILE-HASH-TOJSON");
		},
	} as unknown as AgentMessage;
	assertTerminalFailure([toJsonMessage, ...bundle("hash-tojson", rawSecret)], "toJSON");
	assert.equal(toJsonCalls, 0, "canonical hashing must reject toJSON without invoking it");

	let proxyTrapCalls = 0;
	const proxyMessage = new Proxy({ role: "user", content: "HOSTILE-HASH-PROXY" }, {
		get(): never { proxyTrapCalls += 1; throw new Error("HOSTILE-HASH-PROXY"); },
		ownKeys(): never { proxyTrapCalls += 1; throw new Error("HOSTILE-HASH-PROXY"); },
		getOwnPropertyDescriptor(): never { proxyTrapCalls += 1; throw new Error("HOSTILE-HASH-PROXY"); },
	});
	assertTerminalFailure([proxyMessage as AgentMessage, ...bundle("hash-proxy", rawSecret)], "proxy");
	assert.equal(proxyTrapCalls, 0, "proxy detection must precede every proxy trap");

	const revoked = Proxy.revocable({ role: "user", content: "HOSTILE-HASH-REVOKED" }, {});
	revoked.revoke();
	assertTerminalFailure([revoked.proxy as AgentMessage, ...bundle("hash-revoked", rawSecret)], "revoked proxy");
});

test("history projection restore considers only the latest matching strict state entry", () => {
	const raw: AgentMessage[] = [];
	for (let index = 0; index < 12; index += 1) raw.push(...bundle(`latest-${index}`, "l".repeat(180)));
	const source = new HistoryProjectionController();
	const projected = source.project({
		messages: raw,
		maxToolTextBytes: 1_024,
		maxBundles: 128,
		descriptorMaxBytes: 32,
		role: "worker",
	});
	assert.equal(projected.epochTransitioned, true);
	const valid = source.serialize();
	const malformed = { ...valid, extra: "must-not-poison-newer-valid-state" };

	const latestValid = new HistoryProjectionController();
	assert.equal(latestValid.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: malformed },
		{ type: "custom", customType: "unrelated", data: malformed },
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: valid },
	]), true);
	assert.deepEqual(latestValid.serialize(), valid);

	const safeUnrelatedNewer = new HistoryProjectionController();
	assert.equal(safeUnrelatedNewer.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: valid },
		{ type: "custom", customType: "unrelated", data: malformed },
	]), true, "a safely unrelated newer entry does not hide the older matching state");
	assert.deepEqual(safeUnrelatedNewer.serialize(), valid);

	const assertNewestFailsClosed = (newest: unknown, label: string): void => {
		const controller = new HistoryProjectionController();
		assert.equal(controller.restoreFromEntries([
			{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: valid },
			newest,
		]), false, label);
		const reset = controller.serialize();
		assert.equal(reset.active, 0, label);
		assert.equal(reset.epoch, 0, label);
		assert.equal(reset.rawToolTextBytes, 0, label);
	};

	assertNewestFailsClosed(
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: malformed },
		"a recognized malformed newest entry is authoritative",
	);

	let proxyTrapCalls = 0;
	const proxyEntry = new Proxy({ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: valid }, {
		get(): never { proxyTrapCalls += 1; throw new Error("projection entry proxy get"); },
		getPrototypeOf(): never { proxyTrapCalls += 1; throw new Error("projection entry proxy prototype"); },
		ownKeys(): never { proxyTrapCalls += 1; throw new Error("projection entry proxy keys"); },
		getOwnPropertyDescriptor(): never { proxyTrapCalls += 1; throw new Error("projection entry proxy descriptor"); },
	});
	assertNewestFailsClosed(proxyEntry, "an unsafe newest proxy cannot revive the older state");
	assert.equal(proxyTrapCalls, 0, "entry proxy detection must precede every trap");

	let revokedTrapCalls = 0;
	const revokedEntry = Proxy.revocable({ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: valid }, {
		get(): never { revokedTrapCalls += 1; throw new Error("revoked projection entry get"); },
		getPrototypeOf(): never { revokedTrapCalls += 1; throw new Error("revoked projection entry prototype"); },
		ownKeys(): never { revokedTrapCalls += 1; throw new Error("revoked projection entry keys"); },
		getOwnPropertyDescriptor(): never { revokedTrapCalls += 1; throw new Error("revoked projection entry descriptor"); },
	});
	revokedEntry.revoke();
	assertNewestFailsClosed(revokedEntry.proxy, "an unsafe newest revoked proxy cannot revive the older state");
	assert.equal(revokedTrapCalls, 0, "revoked entry proxy detection must precede every trap");

	let customTypeGetterCalls = 0;
	const customTypeAccessor: Record<string, unknown> = { type: "custom", data: valid };
	Object.defineProperty(customTypeAccessor, "customType", {
		enumerable: true,
		get(): never { customTypeGetterCalls += 1; throw new Error("projection entry customType getter"); },
	});
	assertNewestFailsClosed(customTypeAccessor, "an unsafe newest customType accessor cannot revive the older state");
	assert.equal(customTypeGetterCalls, 0, "customType accessors are rejected from descriptors");

	let dataGetterCalls = 0;
	const dataAccessor: Record<string, unknown> = { type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE };
	Object.defineProperty(dataAccessor, "data", {
		enumerable: true,
		get(): never { dataGetterCalls += 1; throw new Error("projection entry data getter"); },
	});
	assertNewestFailsClosed(dataAccessor, "an unsafe newest data accessor cannot revive the older state");
	assert.equal(dataGetterCalls, 0, "data accessors are rejected from descriptors");
});

test("history projection restore validates the outer entry array without executing traps", () => {
	const valid = JSON.parse(JSON.stringify(new HistoryProjectionController().serialize())) as SerializedV3ProjectionState;
	const entry = { type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: valid };
	const normal = new HistoryProjectionController();
	assert.equal(normal.restoreFromEntries([entry]), true, "a normal dense array remains accepted");
	assert.deepEqual(normal.serialize(), valid);

	const empty = new HistoryProjectionController();
	assert.equal(empty.restoreFromEntries([]), false, "empty input still has no matching state");
	const noMatch = new HistoryProjectionController();
	assert.equal(noMatch.restoreFromEntries([{ type: "custom", customType: "unrelated", data: valid }]), false, "no-match behavior is unchanged");

	let proxyTraps = 0;
	const proxy = new Proxy([entry], {
		get(): never { proxyTraps += 1; throw new Error("outer entries proxy"); },
		ownKeys(): never { proxyTraps += 1; throw new Error("outer entries proxy"); },
		getOwnPropertyDescriptor(): never { proxyTraps += 1; throw new Error("outer entries proxy"); },
	});
	assert.equal(new HistoryProjectionController().restoreFromEntries(proxy), false);
	assert.equal(proxyTraps, 0, "outer proxy detection must precede every trap");

	const revoked = Proxy.revocable([entry], {});
	revoked.revoke();
	assert.equal(new HistoryProjectionController().restoreFromEntries(revoked.proxy), false, "a revoked outer proxy fails closed");

	let indexGetterCalls = 0;
	const indexAccessor: unknown[] = [entry];
	Object.defineProperty(indexAccessor, "0", {
		enumerable: true,
		configurable: true,
		get(): never { indexGetterCalls += 1; throw new Error("outer entries index getter"); },
	});
	assert.equal(new HistoryProjectionController().restoreFromEntries(indexAccessor), false);
	assert.equal(indexGetterCalls, 0, "outer index accessors are rejected from descriptors");

	const sparse: unknown[] = new Array(2);
	sparse[1] = entry;
	assert.equal(new HistoryProjectionController().restoreFromEntries(sparse), false, "sparse outer entry arrays fail closed");
	const oversized = Array.from({ length: 262_145 }, () => entry);
	assert.equal(new HistoryProjectionController().restoreFromEntries(oversized), false, "oversized outer entry arrays fail closed");
});

test("v3 immutable segments optimize Commander and worker through sixteen seals before one checkpoint", () => {
	const cases = [
		{
			role: "commander" as const,
			hard: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
			turn: COMMANDER_TURN_MAX_BYTES,
			seed: 64 * 1_024,
			sizes: [50 * 1_024, 64 * 1_024, 45 * 1_024, 60 * 1_024, 40 * 1_024],
		},
		{
			role: "worker" as const,
			hard: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
			turn: WORKER_TURN_MAX_BYTES,
			seed: 40 * 1_024,
			sizes: [48 * 1_024, 40 * 1_024],
		},
	] as const;

	for (const scenario of cases) {
		const controller = new HistoryProjectionController();
		const raw: AgentMessage[] = [user(`${scenario.role}-anchor`)];
		for (let index = 0; index < 6; index += 1) {
			raw.push(...bundle(`${scenario.role}-old-${index}`, "o".repeat(scenario.role === "commander" ? 24 * 1_024 : 20 * 1_024)));
		}
		raw.push(...bundle(`${scenario.role}-seed`, "s".repeat(scenario.seed)));
		const config = {
			maxToolTextBytes: scenario.hard,
			maxBundles: HISTORY_MAX_BUNDLES,
			descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
			role: scenario.role,
		};
		const assertJsonRoundTrip = (expected: ReturnType<HistoryProjectionController["project"]>, label: string): void => {
			const persisted = JSON.parse(JSON.stringify(controller.serialize())) as unknown;
			const reloaded = new HistoryProjectionController();
			assert.equal(reloaded.restoreFromEntries([
				{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: persisted },
			]), true, label);
			const replayed = reloaded.project({ messages: JSON.parse(JSON.stringify(raw)) as AgentMessage[], ...config });
			assert.deepEqual(
				jsonNormalizedProviderMessages(replayed.messages),
				jsonNormalizedProviderMessages(expected.messages),
				label,
			);
			assert.deepEqual(replayed.boundaryMarkers, expected.boundaryMarkers, label);
			assert.deepEqual(reloaded.serialize(), persisted, label);
		};
		let previous = controller.project({ messages: raw, ...config });
		const firstEpoch = previous.epoch;
		const firstEpochHash = previous.epochHash;
		assert.equal(previous.epochTransitioned, true, scenario.role);
		assert.equal(previous.segmentSealed, false, scenario.role);
		assert.equal(controller.serialize().schemaVersion, 3, scenario.role);
		assert.equal(controller.serialize().segments.length, 0, scenario.role);
		let previousStableCount = controller.serialize().anchor.projectedMessageCount;
		let previousLcp = 0;
		let previousMarkers = previous.boundaryMarkers;
		let previousChainHash = previous.segmentChainHash;
		assertJsonRoundTrip(previous, `${scenario.role}/segments-0`);

		for (let seal = 1; seal <= 19; seal += 1) {
			const size = scenario.sizes[(seal - 1) % scenario.sizes.length]!;
			const id = `${scenario.role}-seal-${seal}`;
			raw.push(user(`${id}-turn`), ...bundle(id, String(seal % 10).repeat(size)));
			const current = controller.project({ messages: raw, ...config });
			const state = controller.serialize();
			assert.equal(validateContextToolPairing(current.messages), true, `${scenario.role}/${seal}`);
			assert.ok(historyToolTextBytes(current.messages) <= scenario.hard, `${scenario.role}/${seal}`);
			assert.ok(callBundleCount(current.messages) <= HISTORY_MAX_BUNDLES, `${scenario.role}/${seal}`);
			assert.equal(textOf(resultById(current.messages, id)!), String(seal % 10).repeat(size), `${scenario.role}/${seal} latest raw`);
			assert.ok(historyToolTextBytes(raw.slice(state.activeRawStartMessageCount)) <= scenario.turn, `${scenario.role}/${seal} active bytes`);
			assert.ok(callBundleCount(raw.slice(state.activeRawStartMessageCount)) <= HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES, `${scenario.role}/${seal} active bundles`);
			assert.ok(state.segments.length <= HISTORY_PROJECTION_MAX_SEGMENTS, `${scenario.role}/${seal}`);
			assert.equal(current.boundaryMarkers.length, state.segments.length + 1, `${scenario.role}/${seal} markers`);
			assert.equal(current.segmentChainHash, state.segmentChainHash, `${scenario.role}/${seal} chain`);
			for (const marker of current.boundaryMarkers) {
				assert.match(marker.boundaryId, /^[0-9a-f]{64}$/);
				assert.equal(marker.marker, `[workbench history cache boundary]\nboundary_id=${marker.boundaryId}`);
			}
			for (const segment of state.segments) {
				assert.ok(segment.projectedToolTextBytes <= HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES, `${scenario.role}/${seal}`);
				assert.ok(segment.projectedBundles <= HISTORY_PROJECTION_SEGMENT_MAX_BUNDLES, `${scenario.role}/${seal}`);
			}

			if (seal <= HISTORY_PROJECTION_MAX_SEGMENTS) {
				assert.equal(current.segmentSealed, true, `${scenario.role}/${seal}`);
				assert.equal(current.epochTransitioned, false, `${scenario.role}/${seal}`);
				assert.equal(current.transitionCause, "segment_sealed", `${scenario.role}/${seal}`);
				assert.equal(current.epoch, firstEpoch, `${scenario.role}/${seal}`);
				assert.equal(current.epochHash, firstEpochHash, `${scenario.role}/${seal}`);
				assert.equal(state.segments.length, seal, `${scenario.role}/${seal}`);
				assert.deepEqual(current.boundaryMarkers.slice(0, previousMarkers.length), previousMarkers);
				assert.notEqual(current.segmentChainHash, previousChainHash);
				const oldProvider = providerMessages(previous.messages);
				const nextProvider = providerMessages(current.messages);
				const lcp = commonProviderPrefixLength(oldProvider, nextProvider);
				assert.deepEqual(
					nextProvider.slice(0, previousStableCount),
					oldProvider.slice(0, previousStableCount),
					`${scenario.role}/${seal} rewrote an immutable prefix`,
				);
				assert.ok(lcp >= previousStableCount, `${scenario.role}/${seal} shortened the immutable prefix`);
				assert.ok(lcp > previousLcp, `${scenario.role}/${seal} provider LCP did not grow`);
				const stableCount = state.anchor.projectedMessageCount
					+ state.segments.reduce((sum, segment) => sum + segment.projectedMessageCount, 0);
				assert.ok(stableCount > previousStableCount, `${scenario.role}/${seal} stable prefix did not grow`);
				previousStableCount = stableCount;
				previousLcp = lcp;
			} else if (seal === HISTORY_PROJECTION_MAX_SEGMENTS + 1) {
				assert.equal(current.segmentSealed, false, scenario.role);
				assert.equal(current.epochTransitioned, true, scenario.role);
				assert.ok(current.transitionCause === "hard_bytes" || current.transitionCause === "hard_bundles", scenario.role);
				assert.equal(state.segments.length, 0, `${scenario.role} checkpoint must reset segments`);
				assert.equal(current.epoch, firstEpoch + 1, scenario.role);
				assert.notEqual(current.epochHash, firstEpochHash, scenario.role);
				previousStableCount = state.anchor.projectedMessageCount;
				previousLcp = 0;
			} else {
				assert.equal(current.segmentSealed, true, `${scenario.role}/${seal}`);
				assert.equal(current.epochTransitioned, false, `${scenario.role}/${seal}`);
				assert.equal(state.segments.length, seal - HISTORY_PROJECTION_MAX_SEGMENTS - 1, `${scenario.role}/${seal}`);
				const oldProvider = providerMessages(previous.messages);
				const nextProvider = providerMessages(current.messages);
				const lcp = commonProviderPrefixLength(oldProvider, nextProvider);
				assert.deepEqual(nextProvider.slice(0, previousStableCount), oldProvider.slice(0, previousStableCount));
				assert.ok(lcp >= previousStableCount && lcp > previousLcp, `${scenario.role}/${seal} post-checkpoint LCP`);
				previousStableCount = state.anchor.projectedMessageCount
					+ state.segments.reduce((sum, segment) => sum + segment.projectedMessageCount, 0);
				previousLcp = lcp;
			}
			previousMarkers = current.boundaryMarkers;
			previousChainHash = current.segmentChainHash;
			if (seal === 1 || seal === HISTORY_PROJECTION_MAX_SEGMENTS
				|| seal === HISTORY_PROJECTION_MAX_SEGMENTS + 1 || seal === HISTORY_PROJECTION_MAX_SEGMENTS + 2) {
				assertJsonRoundTrip(current, `${scenario.role}/roundtrip-${seal}`);
			}
			previous = current;
		}
	}
});

test("v3 same-state append remains wholly append-only when the active bundle reserve is crossed under the hard cap", () => {
	const controller = new HistoryProjectionController();
	const raw: AgentMessage[] = [];
	for (let index = 0; index < 8; index += 1) raw.push(...bundle(`same-${index}`, "x".repeat(20 * 1_024)));
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const initial = controller.project({ messages: raw, ...config });
	raw.push(user("small-append"), ...bundle("small-append", "small"));
	const appended = controller.project({ messages: raw, ...config });
	assert.equal(appended.segmentSealed, false);
	assert.equal(appended.epochTransitioned, false);
	assert.deepEqual(
		providerMessages(appended.messages).slice(0, providerMessages(initial.messages).length),
		providerMessages(initial.messages),
	);

	for (let index = 0; index < HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES; index += 1) {
		raw.push(...bundle(`bundle-pressure-${index}`, "b"));
	}
	const bundlePressure = controller.project({ messages: raw, ...config });
	assert.equal(bundlePressure.segmentSealed, false);
	assert.equal(bundlePressure.epochTransitioned, false);
	assert.equal(bundlePressure.transitionCause, "none");
	assert.ok(callBundleCount(bundlePressure.messages) <= HISTORY_MAX_BUNDLES);
	assert.ok(callBundleCount(raw.slice(controller.serialize().activeRawStartMessageCount)) > HISTORY_PROJECTION_ACTIVE_MAX_BUNDLES);
	assert.equal(controller.serialize().segments.length, 0);
	assert.deepEqual(
		providerMessages(bundlePressure.messages).slice(0, providerMessages(appended.messages).length),
		providerMessages(appended.messages),
	);
});

test("v3 keeps the newest complete multi-call batch raw and collapses an exact 129 KiB oversize batch safely", () => {
	const controller = new HistoryProjectionController();
	const raw: AgentMessage[] = [];
	for (let index = 0; index < 7; index += 1) raw.push(...bundle(`multi-old-${index}`, "m".repeat(15 * 1_024)));
	raw.push(...batchBundle("multi-latest-v3", [20 * 1_024, 20 * 1_024]));
	const projected = controller.project({
		messages: raw,
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker",
	});
	assert.equal(textOf(resultById(projected.messages, "multi-latest-v3-0")!), "0".repeat(20 * 1_024));
	assert.equal(textOf(resultById(projected.messages, "multi-latest-v3-1")!), "1".repeat(20 * 1_024));
	assert.equal(validateContextToolPairing(projected.messages), true);

	const oversizeSecret = "OVERSIZE-V3-SECRET";
	const oversizeRaw = oversizeSecret + "q".repeat(129 * 1_024 - Buffer.byteLength(oversizeSecret));
	const oversize = new HistoryProjectionController().project({
		messages: [assistant([{ id: "oversize-v3-0", name: "tool_oversize-v3-0" }]), result("oversize-v3-0", oversizeRaw)],
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker",
	});
	assert.equal(validateContextToolPairing(oversize.messages), true);
	assert.ok(historyToolTextBytes(oversize.messages) <= WORKER_HISTORY_TOOL_TEXT_MAX_BYTES);
	assert.doesNotMatch(JSON.stringify(oversize.messages), new RegExp(oversizeSecret));
	assert.notEqual(textOf(resultById(oversize.messages, "oversize-v3-0")!), oversizeRaw);
});

test("v3 boundary ids depend on projected provider structure rather than collapsed raw secrets", () => {
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const projectSecret = (character: string) => {
		const raw = [
			...bundle("boundary-old", character.repeat(140 * 1_024)),
			...bundle("boundary-latest", "latest"),
		];
		return new HistoryProjectionController().project({ messages: raw, ...config });
	};
	const left = projectSecret("A");
	const right = projectSecret("B");
	assert.equal(left.boundaryMarkers.length, 1);
	assert.deepEqual(left.boundaryMarkers, right.boundaryMarkers);
	assert.doesNotMatch(JSON.stringify(left.messages), /AAAAAA/);
	assert.doesNotMatch(JSON.stringify(right.messages), /BBBBBB/);
});

test("strict v3 state rejects hostile containers, bad segment bounds, seventeenth segments, and bad chains", () => {
	const raw: AgentMessage[] = [];
	for (let index = 0; index < 6; index += 1) raw.push(...bundle(`strict-v3-old-${index}`, "o".repeat(24 * 1_024)));
	raw.push(...bundle("strict-v3-seed", "s".repeat(64 * 1_024)));
	const controller = new HistoryProjectionController();
	const config = {
		maxToolTextBytes: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "commander" as const,
	};
	controller.project({ messages: raw, ...config });
	raw.push(...bundle("strict-v3-seal", "n".repeat(50 * 1_024)));
	controller.project({ messages: raw, ...config });
	const valid = controller.serialize();
	assert.equal(valid.segments.length, 1);
	const restore = (data: unknown): boolean => new HistoryProjectionController().restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data },
	]);
	assert.equal(restore(JSON.parse(JSON.stringify(valid))), true);

	const mutatedSegment = (changes: Record<string, unknown>): Record<string, unknown> => ({
		...valid,
		segments: [{ ...valid.segments[0]!, ...changes }],
	});
	assert.equal(restore(mutatedSegment({ projectedToolTextBytes: HISTORY_PROJECTION_SEGMENT_MAX_TOOL_TEXT_BYTES + 1 })), false);
	assert.equal(restore(mutatedSegment({ projectedBundles: HISTORY_PROJECTION_SEGMENT_MAX_BUNDLES + 1 })), false);
	assert.equal(restore(mutatedSegment({ rawStartMessageCount: valid.segments[0]!.rawStartMessageCount + 1 })), false);
	assert.equal(restore(mutatedSegment({ boundaryId: "not-a-hash" })), false);
	assert.equal(restore({ ...valid, segmentChainHash: "f".repeat(64) }), false);
	assert.equal(restore({ ...valid, segments: Array.from({ length: HISTORY_PROJECTION_MAX_SEGMENTS + 1 }, () => valid.segments[0]) }), false);

	let proxyTraps = 0;
	const proxy = new Proxy(valid, {
		get(): never { proxyTraps += 1; throw new Error("state proxy"); },
		ownKeys(): never { proxyTraps += 1; throw new Error("state proxy"); },
		getOwnPropertyDescriptor(): never { proxyTraps += 1; throw new Error("state proxy"); },
	});
	assert.equal(restore(proxy), false);
	assert.equal(proxyTraps, 0);

	let getterCalls = 0;
	const accessor = { ...valid } as Record<string, unknown>;
	Object.defineProperty(accessor, "epoch", {
		enumerable: true,
		get(): never { getterCalls += 1; throw new Error("state getter"); },
	});
	assert.equal(restore(accessor), false);
	assert.equal(getterCalls, 0);

	let toJsonCalls = 0;
	const withToJson = {
		...valid,
		toJSON(): never { toJsonCalls += 1; throw new Error("state toJSON"); },
	};
	assert.equal(restore(withToJson), false);
	assert.equal(toJsonCalls, 0);
	assert.equal(restore(Object.assign({ ...valid }, { [Symbol("state")]: true })), false);
});

test("v3 lowered bundle reserves fail closed without exceeding caller caps", () => {
	const raw: AgentMessage[] = [];
	for (let index = 0; index < 17; index += 1) raw.push(...bundle(`lowered-bundle-${index}`, "x"));
	const projected = new HistoryProjectionController().project({
		messages: raw,
		maxToolTextBytes: 4_096,
		maxBundles: 16,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker",
	});
	assert.equal(projected.transitionCause, "failure");
	assert.equal(projected.messages.length, 1);
	assert.equal((projected.messages[0] as { customType?: unknown }).customType, "workbench-history-projection-failure");
	assert.equal(validateContextToolPairing(projected.messages), true);
	assert.ok(historyToolTextBytes(projected.messages) <= 4_096);
	assert.ok(callBundleCount(projected.messages) <= 16);
});

test("history projection observability is exact and content-free for Commander, worker, and strict JSON restore", () => {
	assert.deepEqual(HISTORY_PROJECTION_EVENT_KINDS, [
		"none",
		"initial_hard_projection",
		"segment_seal",
		"epoch_checkpoint",
		"inactive_boundary",
		"fixed_failure",
		"recovery_boundary",
	]);
	assert.deepEqual(HISTORY_PROJECTION_OBSERVATION_CAUSES, [
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
	]);
	const expectedKeys = [
		"eventKind", "transitionCause", "epoch", "epochTransitioned", "segmentSealed",
		"byteOverflow", "bundleOverflow", "segmentsBefore", "segmentsAfter",
		"hardToolTextBytes", "hardBundles", "rawToolTextBytes", "rawBundles",
		"projectedToolTextBytes", "projectedBundles", "stableToolTextBytesBefore",
		"stableBundlesBefore", "activeToolTextBytesBefore", "activeBundlesBefore",
		"agedRawToolTextBytes", "agedRawBundles", "agedProjectedToolTextBytes",
		"agedProjectedBundles", "suffixRawToolTextBytes", "suffixRawBundles",
	].sort();

	for (const [role, hard, secret] of [
		["commander", COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES, "COMMANDER-OBSERVABILITY-SECRET"],
		["worker", WORKER_HISTORY_TOOL_TEXT_MAX_BYTES, "WORKER-OBSERVABILITY-SECRET"],
	] as const) {
		const messages = [user(`${role}-ordinary`), ...bundle(`${role}-under-cap`, secret)];
		const projected = new HistoryProjectionController().project({
			messages,
			maxToolTextBytes: hard,
			maxBundles: HISTORY_MAX_BUNDLES,
			descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
			role,
		});
		const observation = projected.observability;
		assert.deepEqual(Object.keys(observation).sort(), expectedKeys, role);
		assert.equal(observation.eventKind, "none", role);
		assert.equal(observation.transitionCause, "none", role);
		assert.equal(observation.epoch, 0, role);
		assert.equal(observation.epochTransitioned, 0, role);
		assert.equal(observation.segmentSealed, 0, role);
		assert.equal(observation.byteOverflow, 0, role);
		assert.equal(observation.bundleOverflow, 0, role);
		assert.equal(observation.segmentsBefore, 0, role);
		assert.equal(observation.segmentsAfter, 0, role);
		assert.equal(observation.hardToolTextBytes, hard, role);
		assert.equal(observation.hardBundles, HISTORY_MAX_BUNDLES, role);
		assert.equal(observation.rawToolTextBytes, Buffer.byteLength(secret), role);
		assert.equal(observation.rawBundles, 1, role);
		assert.equal(observation.projectedToolTextBytes, Buffer.byteLength(secret), role);
		assert.equal(observation.projectedBundles, 1, role);
		assert.equal(observation.stableToolTextBytesBefore, 0, role);
		assert.equal(observation.stableBundlesBefore, 0, role);
		assert.equal(observation.activeToolTextBytesBefore, Buffer.byteLength(secret), role);
		assert.equal(observation.activeBundlesBefore, 1, role);
		assert.equal(observation.agedRawToolTextBytes, 0, role);
		assert.equal(observation.agedRawBundles, 0, role);
		assert.equal(observation.agedProjectedToolTextBytes, 0, role);
		assert.equal(observation.agedProjectedBundles, 0, role);
		assert.equal(observation.suffixRawToolTextBytes, Buffer.byteLength(secret), role);
		assert.equal(observation.suffixRawBundles, 1, role);
		for (const [key, value] of Object.entries(observation)) {
			if (key === "eventKind" || key === "transitionCause") continue;
			assert.equal(typeof value, "number", `${role}/${key}`);
			assert.ok(Number.isSafeInteger(value) && value >= 0, `${role}/${key}`);
		}
		assert.doesNotMatch(JSON.stringify(observation), new RegExp(secret), role);
	}

	const raw: AgentMessage[] = [];
	for (let index = 0; index < 8; index += 1) raw.push(...bundle(`observability-restore-${index}`, "r".repeat(20 * 1_024)));
	const config = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const source = new HistoryProjectionController();
	source.project({ messages: raw, ...config });
	const persisted = JSON.parse(JSON.stringify(source.serialize())) as SerializedV3ProjectionState;
	const restored = new HistoryProjectionController();
	assert.equal(restored.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: persisted },
	]), true);
	const replayed = restored.project({ messages: structuredClone(raw), ...config });
	const stableBytes = persisted.anchor.projectedToolTextBytes
		+ persisted.segments.reduce((sum, segment) => sum + segment.projectedToolTextBytes, 0);
	const stableBundles = persisted.anchor.projectedBundles
		+ persisted.segments.reduce((sum, segment) => sum + segment.projectedBundles, 0);
	const active = raw.slice(persisted.activeRawStartMessageCount);
	assert.equal(replayed.observability.eventKind, "none");
	assert.equal(replayed.observability.transitionCause, "none");
	assert.equal(replayed.observability.segmentsBefore, persisted.segments.length);
	assert.equal(replayed.observability.segmentsAfter, persisted.segments.length);
	assert.equal(replayed.observability.stableToolTextBytesBefore, stableBytes);
	assert.equal(replayed.observability.stableBundlesBefore, stableBundles);
	assert.equal(replayed.observability.activeToolTextBytesBefore, historyToolTextBytes(active));
	assert.equal(replayed.observability.activeBundlesBefore, callBundleCount(active));
	assert.equal(replayed.observability.suffixRawToolTextBytes, historyToolTextBytes(active));
	assert.equal(replayed.observability.suffixRawBundles, callBundleCount(active));
	assert.deepEqual(restored.serialize(), persisted, "observability is not persisted and cannot perturb strict restore");
});

test("history projection observability distinguishes initial projection, byte and bundle seals, and the seventeenth checkpoint", () => {
	const workerConfig = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const controller = new HistoryProjectionController();
	const raw: AgentMessage[] = [];
	for (let index = 0; index < 8; index += 1) raw.push(...bundle(`observation-byte-${index}`, "b".repeat(20 * 1_024)));
	const initial = controller.project({ messages: raw, ...workerConfig });
	const initialState = controller.serialize();
	const initialAged = raw.slice(0, initialState.activeRawStartMessageCount);
	const initialSuffix = raw.slice(initialState.activeRawStartMessageCount);
	assert.equal(initial.observability.eventKind, "initial_hard_projection");
	assert.equal(initial.observability.transitionCause, "initial_hard_limit");
	assert.equal(initial.observability.byteOverflow, 1);
	assert.equal(initial.observability.bundleOverflow, 0);
	assert.equal(initial.observability.activeToolTextBytesBefore, historyToolTextBytes(raw));
	assert.equal(initial.observability.activeBundlesBefore, callBundleCount(raw));
	assert.equal(initial.observability.agedRawToolTextBytes, historyToolTextBytes(initialAged));
	assert.equal(initial.observability.agedRawBundles, callBundleCount(initialAged));
	assert.equal(initial.observability.agedProjectedToolTextBytes, initialState.anchor.projectedToolTextBytes);
	assert.equal(initial.observability.agedProjectedBundles, initialState.anchor.projectedBundles);
	assert.equal(initial.observability.suffixRawToolTextBytes, historyToolTextBytes(initialSuffix));
	assert.equal(initial.observability.suffixRawBundles, callBundleCount(initialSuffix));
	assert.equal(initial.observability.projectedToolTextBytes, historyToolTextBytes(initial.messages));
	assert.equal(initial.observability.projectedBundles, callBundleCount(initial.messages));

	const byteStateBefore = controller.serialize();
	raw.push(...bundle("observation-byte-seal", "n".repeat(30 * 1_024)));
	const byteActiveBefore = raw.slice(byteStateBefore.activeRawStartMessageCount);
	const byteStableBefore = byteStateBefore.anchor.projectedToolTextBytes
		+ byteStateBefore.segments.reduce((sum, segment) => sum + segment.projectedToolTextBytes, 0);
	const byteStableBundlesBefore = byteStateBefore.anchor.projectedBundles
		+ byteStateBefore.segments.reduce((sum, segment) => sum + segment.projectedBundles, 0);
	const byteSeal = controller.project({ messages: raw, ...workerConfig });
	const byteStateAfter = controller.serialize();
	const byteSegment = byteStateAfter.segments.at(-1)!;
	const byteAged = raw.slice(byteSegment.rawStartMessageCount, byteSegment.rawEndMessageCount);
	const byteSuffix = raw.slice(byteStateAfter.activeRawStartMessageCount);
	assert.equal(byteSeal.observability.eventKind, "segment_seal");
	assert.equal(byteSeal.observability.transitionCause, "segment_sealed");
	assert.equal(byteSeal.observability.byteOverflow, 1);
	assert.equal(byteSeal.observability.bundleOverflow, 0);
	assert.equal(byteSeal.observability.segmentsBefore, 0);
	assert.equal(byteSeal.observability.segmentsAfter, 1);
	assert.equal(byteSeal.observability.stableToolTextBytesBefore, byteStableBefore);
	assert.equal(byteSeal.observability.stableBundlesBefore, byteStableBundlesBefore);
	assert.equal(byteSeal.observability.activeToolTextBytesBefore, historyToolTextBytes(byteActiveBefore));
	assert.equal(byteSeal.observability.activeBundlesBefore, callBundleCount(byteActiveBefore));
	assert.equal(byteSeal.observability.agedRawToolTextBytes, historyToolTextBytes(byteAged));
	assert.equal(byteSeal.observability.agedRawBundles, callBundleCount(byteAged));
	assert.equal(byteSeal.observability.agedProjectedToolTextBytes, byteSegment.projectedToolTextBytes);
	assert.equal(byteSeal.observability.agedProjectedBundles, byteSegment.projectedBundles);
	assert.equal(byteSeal.observability.suffixRawToolTextBytes, historyToolTextBytes(byteSuffix));
	assert.equal(byteSeal.observability.suffixRawBundles, callBundleCount(byteSuffix));

	const bundleController = new HistoryProjectionController();
	const bundleRaw: AgentMessage[] = [];
	for (let index = 0; index < 35; index += 1) bundleRaw.push(...bundle(`observation-bundle-${index}`, "x"));
	const bundleConfig = {
		maxToolTextBytes: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: 34,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "commander" as const,
	};
	const bundleInitial = bundleController.project({ messages: bundleRaw, ...bundleConfig });
	assert.equal(bundleInitial.observability.eventKind, "initial_hard_projection");
	assert.equal(bundleInitial.observability.byteOverflow, 0);
	assert.equal(bundleInitial.observability.bundleOverflow, 1);
	const bundleStateBefore = bundleController.serialize();
	for (let index = 0; index < 17; index += 1) bundleRaw.push(...bundle(`observation-bundle-tail-${index}`, "y"));
	const bundleSeal = bundleController.project({ messages: bundleRaw, ...bundleConfig });
	assert.equal(bundleSeal.observability.eventKind, "segment_seal");
	assert.equal(bundleSeal.observability.transitionCause, "segment_sealed");
	assert.equal(bundleSeal.observability.byteOverflow, 0);
	assert.equal(bundleSeal.observability.bundleOverflow, 1);
	assert.equal(bundleSeal.observability.segmentsBefore, bundleStateBefore.segments.length);
	assert.equal(bundleSeal.observability.segmentsAfter, bundleStateBefore.segments.length + 1);

	const checkpointController = new HistoryProjectionController();
	const checkpointRaw: AgentMessage[] = [user("checkpoint-anchor")];
	for (let index = 0; index < 6; index += 1) {
		checkpointRaw.push(...bundle(`observation-checkpoint-old-${index}`, "o".repeat(20 * 1_024)));
	}
	checkpointRaw.push(...bundle("observation-checkpoint-seed", "s".repeat(40 * 1_024)));
	checkpointController.project({ messages: checkpointRaw, ...workerConfig });
	for (let seal = 1; seal <= HISTORY_PROJECTION_MAX_SEGMENTS; seal += 1) {
		checkpointRaw.push(
			user(`observation-checkpoint-turn-${seal}`),
			...bundle(`observation-checkpoint-${seal}`, String(seal % 10).repeat(seal % 2 === 0 ? 40 * 1_024 : 48 * 1_024)),
		);
		const sealed = checkpointController.project({ messages: checkpointRaw, ...workerConfig });
		assert.equal(sealed.observability.eventKind, "segment_seal", `seal ${seal}`);
	}
	const checkpointBefore = checkpointController.serialize();
	assert.equal(checkpointBefore.segments.length, HISTORY_PROJECTION_MAX_SEGMENTS);
	checkpointRaw.push(user("observation-checkpoint-turn-17"), ...bundle("observation-checkpoint-17", "z".repeat(48 * 1_024)));
	const checkpointActiveBefore = checkpointRaw.slice(checkpointBefore.activeRawStartMessageCount);
	const checkpoint = checkpointController.project({ messages: checkpointRaw, ...workerConfig });
	const checkpointAfter = checkpointController.serialize();
	const checkpointAged = checkpointRaw.slice(0, checkpointAfter.activeRawStartMessageCount);
	const checkpointSuffix = checkpointRaw.slice(checkpointAfter.activeRawStartMessageCount);
	assert.equal(checkpoint.observability.eventKind, "epoch_checkpoint");
	assert.ok(checkpoint.observability.transitionCause === "hard_bytes" || checkpoint.observability.transitionCause === "hard_bundles");
	assert.equal(checkpoint.observability.epochTransitioned, 1);
	assert.equal(checkpoint.observability.segmentSealed, 0);
	assert.equal(checkpoint.observability.segmentsBefore, HISTORY_PROJECTION_MAX_SEGMENTS);
	assert.equal(checkpoint.observability.segmentsAfter, 0);
	assert.equal(checkpoint.observability.activeToolTextBytesBefore, historyToolTextBytes(checkpointActiveBefore));
	assert.equal(checkpoint.observability.activeBundlesBefore, callBundleCount(checkpointActiveBefore));
	assert.equal(checkpoint.observability.agedRawToolTextBytes, historyToolTextBytes(checkpointAged));
	assert.equal(checkpoint.observability.agedRawBundles, callBundleCount(checkpointAged));
	assert.equal(checkpoint.observability.agedProjectedToolTextBytes, checkpointAfter.anchor.projectedToolTextBytes);
	assert.equal(checkpoint.observability.agedProjectedBundles, checkpointAfter.anchor.projectedBundles);
	assert.equal(checkpoint.observability.suffixRawToolTextBytes, historyToolTextBytes(checkpointSuffix));
	assert.equal(checkpoint.observability.suffixRawBundles, callBundleCount(checkpointSuffix));
});

test("history projection observability identifies inactive boundaries, fixed failure, and one-shot recovery", () => {
	const workerConfig = {
		maxToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		maxBundles: HISTORY_MAX_BUNDLES,
		descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
		role: "worker" as const,
	};
	const frozenRaw: AgentMessage[] = [];
	for (let index = 0; index < 8; index += 1) frozenRaw.push(...bundle(`observation-boundary-${index}`, "q".repeat(20 * 1_024)));

	const prefixController = new HistoryProjectionController();
	prefixController.project({ messages: frozenRaw, ...workerConfig });
	const prefixBefore = prefixController.serialize();
	const shortened = frozenRaw.slice(0, 4);
	const prefix = prefixController.project({ messages: shortened, ...workerConfig });
	assert.equal(prefix.observability.eventKind, "inactive_boundary");
	assert.equal(prefix.observability.transitionCause, "prefix_changed");
	assert.equal(prefix.observability.segmentsBefore, prefixBefore.segments.length);
	assert.equal(prefix.observability.segmentsAfter, 0);
	assert.equal(prefix.observability.activeToolTextBytesBefore, 0, "invalidated active topology is structurally unavailable");
	assert.equal(prefix.observability.activeBundlesBefore, 0);
	assert.equal(prefix.observability.suffixRawToolTextBytes, historyToolTextBytes(shortened));
	assert.equal(prefix.observability.suffixRawBundles, callBundleCount(shortened));

	const policyController = new HistoryProjectionController();
	policyController.project({ messages: frozenRaw, ...workerConfig });
	const policyBefore = policyController.serialize();
	const policy = policyController.project({
		messages: frozenRaw,
		...workerConfig,
		maxToolTextBytes: COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
		role: "commander",
	});
	assert.equal(policy.observability.eventKind, "inactive_boundary");
	assert.equal(policy.observability.transitionCause, "policy_changed");
	assert.equal(policy.observability.segmentsBefore, policyBefore.segments.length);
	assert.equal(policy.observability.segmentsAfter, 0);
	assert.equal(policy.observability.hardToolTextBytes, COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES);

	const legacy = {
		schemaVersion: 1,
		active: 1,
		epoch: 7,
		epochHash: "1".repeat(64),
		prefixMessageCount: 4,
		prefixHash: "2".repeat(64),
		projectedPrefixHash: "3".repeat(64),
		hardToolTextBytes: WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
		hardBundles: HISTORY_MAX_BUNDLES,
		lowToolTextBytes: 48 * 1_024,
		lowBundles: 96,
		transitionCollapsedResults: 2,
		transitionRemovedBundles: 1,
		rawToolTextBytes: 70 * 1_024,
		rawBundles: 9,
		projectedToolTextBytes: 40 * 1_024,
		projectedBundles: 8,
	};
	const legacyController = new HistoryProjectionController();
	assert.equal(legacyController.restoreFromEntries([
		{ type: "custom", customType: "workbench-history-projection-state-v1", data: legacy },
	]), true);
	const legacyRaw = [user("legacy-observation"), ...bundle("legacy-observation", "legacy")];
	const legacyProjection = legacyController.project({ messages: legacyRaw, ...workerConfig });
	assert.equal(legacyProjection.observability.eventKind, "inactive_boundary");
	assert.equal(legacyProjection.observability.transitionCause, "legacy_migration");
	assert.equal(legacyProjection.observability.segmentsBefore, 0);
	assert.equal(legacyProjection.observability.segmentsAfter, 0);
	assert.equal(legacyProjection.observability.activeToolTextBytesBefore, historyToolTextBytes(legacyRaw));
	assert.equal(legacyProjection.observability.suffixRawToolTextBytes, historyToolTextBytes(legacyRaw));

	const failureController = new HistoryProjectionController();
	const corrupt = [user("failure-observation"), result("orphan-observation", "FAILURE-OBSERVATION-SECRET")];
	const failure = failureController.project({ messages: corrupt, ...workerConfig });
	assert.equal(failure.observability.eventKind, "fixed_failure");
	assert.equal(failure.observability.transitionCause, "failure");
	assert.equal(failure.observability.epochTransitioned, 1);
	assert.equal(failure.observability.projectedToolTextBytes, 0);
	assert.equal(failure.observability.projectedBundles, 0);
	assert.equal(failure.observability.agedRawToolTextBytes, 0);
	assert.equal(failure.observability.suffixRawToolTextBytes, 0);
	assert.doesNotMatch(JSON.stringify(failure.observability), /FAILURE-OBSERVATION-SECRET/);

	const repeatedFailure = failureController.project({ messages: structuredClone(corrupt), ...workerConfig });
	assert.equal(repeatedFailure.observability.eventKind, "fixed_failure");
	assert.equal(repeatedFailure.observability.epochTransitioned, 0);
	const healthy = [user("healthy-observation"), ...bundle("healthy-observation", "ok")];
	const recovery = failureController.project({ messages: healthy, ...workerConfig });
	assert.equal(recovery.observability.eventKind, "recovery_boundary");
	assert.equal(recovery.observability.transitionCause, "recovery");
	assert.equal(recovery.observability.epochTransitioned, 1);
	assert.equal(recovery.observability.activeToolTextBytesBefore, historyToolTextBytes(healthy));
	assert.equal(recovery.observability.suffixRawToolTextBytes, historyToolTextBytes(healthy));
	const stable = failureController.project({ messages: [...healthy, user("post-recovery")], ...workerConfig });
	assert.equal(stable.observability.eventKind, "none");
	assert.equal(stable.observability.transitionCause, "none");
	assert.equal(stable.observability.epochTransitioned, 0);
});
