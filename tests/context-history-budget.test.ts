import assert from "node:assert/strict";
import { test } from "node:test";

import {
	COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
	HISTORY_DESCRIPTOR_MAX_BYTES,
	HISTORY_MAX_BUNDLES,
	HISTORY_PROJECTION_ENTRY_TYPE,
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

test("role and caller limits are downward-only from 96 KiB and 64 KiB hard ceilings", () => {
	const eightyKiB = "x".repeat(80 * 1_024);
	const messages = bundle("large", eightyKiB);
	const commander = project(messages, { role: "commander", maxToolTextBytes: Number.MAX_SAFE_INTEGER });
	assert.equal(historyToolTextBytes(commander.messages), 80 * 1_024);
	assert.ok(historyToolTextBytes(commander.messages) <= COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES);

	for (const role of ["worker", "other", "future-role"] as const) {
		const bounded = project(messages, { role, maxToolTextBytes: Number.MAX_SAFE_INTEGER });
		assert.ok(historyToolTextBytes(bounded.messages) <= WORKER_HISTORY_TOOL_TEXT_MAX_BYTES, role);
		assert.ok(historyToolTextBytes(bounded.messages) <= OTHER_HISTORY_TOOL_TEXT_MAX_BYTES, role);
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

test("history projection epochs preserve Pi provider-visible append-only payloads with hysteresis", () => {
	const controller = new HistoryProjectionController();
	const raw: AgentMessage[] = [user("epoch-start")];
	for (let index = 0; index < 24; index += 1) raw.push(...bundle(`epoch-seed-${index}`, "x".repeat(220)));
	const config = {
		maxToolTextBytes: 4_096,
		maxBundles: 128,
		descriptorMaxBytes: 32,
		role: "worker" as const,
	};

	let projected = controller.project({ messages: raw, ...config });
	assert.equal(projected.epochTransitioned, true);
	assert.equal(projected.epoch, 1);
	assert.ok(historyToolTextBytes(projected.messages) <= 4_096);
	assert.equal(validateContextToolPairing(projected.messages), true);
	let providerVisible = convertToLlm(projected.messages);
	let transitionCount = 1;
	let collapsedDelta = projected.newlyCollapsedResults;
	let removedDelta = projected.newlyRemovedBundles;

	for (let turn = 0; turn < 25; turn += 1) {
		raw.push(user(`suffix-user-${turn}`), ...bundle(`epoch-suffix-${turn}`, "s".repeat(12)));
		const next = controller.project({ messages: raw, ...config });
		if (next.epochTransitioned) transitionCount += 1;
		collapsedDelta += next.newlyCollapsedResults;
		removedDelta += next.newlyRemovedBundles;
		const nextProviderVisible = convertToLlm(next.messages);
		assert.deepEqual(
			nextProviderVisible.slice(0, providerVisible.length),
			providerVisible,
			`turn ${turn} rewrote the Pi provider-visible epoch prefix`,
		);
		assert.ok(historyToolTextBytes(next.messages) <= 4_096, `turn=${turn}`);
		assert.ok(next.projectedBundleCount <= 128, `turn=${turn}`);
		assert.equal(validateContextToolPairing(next.messages), true, `turn=${turn}`);
		providerVisible = nextProviderVisible;
		projected = next;
	}

	assert.equal(transitionCount, 1, "25 suffix turns stay inside one low-watermark epoch");
	assert.equal(collapsedDelta, projected.facts.collapsedResults, "same epoch never re-counts collapsed results");
	assert.equal(removedDelta, projected.facts.removedBundles, "same epoch never re-counts removed bundles");
});

test("history projection state restores strictly and reset invalidates the frozen boundary", () => {
	const raw: AgentMessage[] = [];
	for (let index = 0; index < 30; index += 1) raw.push(...bundle(`restore-${index}`, "r".repeat(200)));
	const config = {
		maxToolTextBytes: 4_096,
		maxBundles: 128,
		descriptorMaxBytes: 48,
		role: "worker" as const,
	};
	const first = new HistoryProjectionController();
	const initial = first.project({ messages: raw, ...config });
	assert.equal(initial.epochTransitioned, true);
	const persisted = first.serialize();
	assert.deepEqual(Object.keys(persisted).sort(), [
		"active", "epoch", "epochHash", "hardBundles", "hardToolTextBytes", "lowBundles",
		"lowToolTextBytes", "prefixHash", "prefixMessageCount", "projectedBundles", "projectedPrefixHash",
		"projectedToolTextBytes", "rawBundles", "rawToolTextBytes", "schemaVersion",
		"transitionCollapsedResults", "transitionRemovedBundles",
	].sort());
	for (const [key, value] of Object.entries(persisted)) {
		if (key === "epochHash" || key === "prefixHash" || key === "projectedPrefixHash") assert.match(String(value), /^[0-9a-f]{64}$/);
		else assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, key);
	}

	raw.push(user("after-reload"), ...bundle("restore-suffix", "suffix"));
	const restored = new HistoryProjectionController();
	assert.equal(restored.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: persisted },
	]), true);
	const continued = restored.project({ messages: raw, ...config });
	assert.equal(continued.epochTransitioned, false);
	assert.deepEqual(
		convertToLlm(continued.messages).slice(0, convertToLlm(initial.messages).length),
		convertToLlm(initial.messages),
	);

	const hostile = new HistoryProjectionController();
	assert.equal(hostile.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: { ...persisted, extra: "secret" } },
	]), false);
	hostile.reset();
	const afterReset = hostile.project({ messages: raw, ...config });
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

	const latestMalformed = new HistoryProjectionController();
	assert.equal(latestMalformed.restoreFromEntries([
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: valid },
		{ type: "custom", customType: HISTORY_PROJECTION_ENTRY_TYPE, data: malformed },
	]), false);
	const reset = latestMalformed.serialize();
	assert.equal(reset.active, 0);
	assert.equal(reset.epoch, 0);
	assert.equal(reset.rawToolTextBytes, 0);
});
