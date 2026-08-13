import assert from "node:assert/strict";
import { test } from "node:test";

import {
	STREAM_UPDATE_MAX_LINES,
	enforceOutputEnvelope,
	enforceStreamingUpdate,
	type ImageContent,
	type TextContent,
} from "../extensions/workbench-runtime/core/output-envelope.ts";
import {
	STREAM_UPDATE_MAX_BYTES,
	resolveOutputPolicyHardCeiling,
	resolveToolOutputPolicy,
	type ToolOutputPolicy,
} from "../extensions/workbench-runtime/core/output-policy.ts";

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const lines = (text: string): number => text.length === 0 ? 0 : text.split("\n").length;
const textBlocks = (content: Array<TextContent | ImageContent>): TextContent[] => content.filter((block): block is TextContent => block.type === "text");
const shownText = (content: Array<TextContent | ImageContent>): string => textBlocks(content).map((block) => block.text).join("");
const providerVisibleText = (content: Array<TextContent | ImageContent>): string => textBlocks(content).map((block) => block.text).join("\n");
const policy = (maxTextBytes: number, maxLines: number, preserveImages = false): ToolOutputPolicy => ({ id: "default", maxTextBytes, maxLines, minReservationBytes: 1, overflow: "receipt-only", preserveImages });

function hasLoneSurrogate(text: string): boolean {
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return true;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
	}
	return false;
}

test("policy resolver covers the approved tool map and hostile read-run args cannot raise caps", () => {
	const cases: Array<[string, unknown, string, number, number, number, string, boolean]> = [
		["read", {}, "native-read-page", 12_288, 252, 2_048, "cursor", true],
		["grep", {}, "native-search", 16_384, 240, 2_048, "narrow-query", false],
		["find", {}, "native-search", 16_384, 240, 2_048, "narrow-query", false],
		["ls", {}, "native-search", 16_384, 240, 2_048, "narrow-query", false],
		["workbench_project_inspect", {}, "default", 16_384, 240, 2_048, "receipt-only", false],
		["workbench_run_recipe", {}, "run-summary", 16_384, 240, 4_096, "source-pointer", false],
		["workbench_read_run", {}, "run-summary", 8_192, 120, 2_048, "source-pointer", false],
		["workbench_read_run", { include: "manifest" }, "run-summary", 8_192, 120, 2_048, "source-pointer", false],
		["workbench_read_run", { include: "logs" }, "run-log-page", 32_768, 400, 4_096, "cursor", false],
		["workbench_read_run", { include: "all" }, "run-log-page", 32_768, 400, 4_096, "cursor", false],
		["workbench_run_gate", {}, "gate-summary", 16_384, 240, 4_096, "artifact-pointer", false],
		["workbench_read_gate", {}, "gate-read", 24_576, 320, 4_096, "source-pointer", false],
		["workbench_list_gates", {}, "gate-read", 16_384, 240, 2_048, "narrow-query", false],
		["workbench_compare_runs", {}, "compare", 32_768, 400, 4_096, "artifact-pointer", false],
		["workbench_delegate_worker", {}, "worker-handoff", 12_288, 120, 4_096, "source-pointer", false],
		["workbench_review_worker_diff", {}, "diff-review", 32_768, 400, 4_096, "narrow-query", false],
		["workbench_delegation_status", {}, "default", 16_384, 240, 2_048, "receipt-only", false],
		["workbench_recover_tool_result", {}, "recovery", 8_192, 120, 2_048, "receipt-only", false],
		["unknown_tool", {}, "default", 16_384, 240, 2_048, "receipt-only", false],
	];
	for (const [toolName, args, id, maxTextBytes, maxLines, minReservationBytes, overflow, preserveImages] of cases) {
		assert.deepEqual(resolveToolOutputPolicy({ toolName, args, role: "commander" }), { id, maxTextBytes, maxLines, minReservationBytes, overflow, preserveImages });
	}
	const hostile = new Proxy({}, { get(): never { throw new Error("hostile"); } });
	assert.equal(resolveToolOutputPolicy({ toolName: "workbench_read_run", args: hostile, role: "worker" }).maxTextBytes, 8_192);
});

test("exact provider-visible boundary is canonicalized to one text block with its separator counted", () => {
	const content: TextContent[] = [{ type: "text", text: "a".repeat(39) }, { type: "text", text: "b".repeat(24) }];
	const result = enforceOutputEnvelope({ toolName: "x", content, isError: false, policy: policy(64, 2), allocatedBytes: 64 });
	assert.deepEqual(result.content, [{ type: "text", text: `${"a".repeat(39)}\n${"b".repeat(24)}` }]);
	assert.equal(result.facts.truncated, false);
	assert.equal(result.facts.reason, "none");
	assert.equal(result.facts.shownTextBytes, 64);
	assert.equal(result.facts.originalTextBytes, bytes(providerVisibleText(content)));
	assert.equal(result.facts.originalTextLines, lines(providerVisibleText(content)));
	assert.equal(result.facts.shownTextBytes, bytes(providerVisibleText(result.content)));
	assert.equal(result.facts.shownTextLines, lines(providerVisibleText(result.content)));
});

test("many short blocks cannot amplify past the default cap through provider separators", () => {
	const content: TextContent[] = Array.from({ length: 240 }, () => ({ type: "text", text: "x".repeat(68) }));
	const rawProviderText = providerVisibleText(content);
	assert.equal(bytes(rawProviderText), 16_559);
	const result = enforceOutputEnvelope({ toolName: "x", content, isError: false, policy: policy(16_384, 240), allocatedBytes: 16_384 });
	const visible = providerVisibleText(result.content);
	assert.equal(textBlocks(result.content).length, 1);
	assert.equal(result.facts.originalTextBytes, 16_559);
	assert.equal(result.facts.originalTextLines, 240);
	assert.equal(result.facts.shownTextBytes, bytes(visible));
	assert.equal(result.facts.shownTextLines, lines(visible));
	assert.ok(bytes(visible) <= 16_384);
	assert.ok(lines(visible) <= 240);
	assert.equal(result.facts.truncated, true);
	assert.match(visible, /workbench-output truncated/);
	assert.match(visible, /action=rerun_narrow_or_persist_then_bounded_read/);
});

test("multiple text blocks share lower byte and line caps with marker inside both", () => {
	const result = enforceOutputEnvelope({
		toolName: "x",
		content: [{ type: "text", text: "one\ntwo\nthree" }, { type: "text", text: "汉🙂".repeat(40) }],
		isError: false,
		policy: policy(400, 4),
		allocatedBytes: 180,
		continuation: { kind: "run-log", value: "wbcur1.safe" },
	});
	assert.equal(result.facts.truncated, true);
	assert.equal(result.facts.reason, "turn-reservation");
	assert.ok(result.facts.shownTextBytes <= 180);
	assert.ok(result.facts.shownTextLines <= 4);
	assert.equal(result.facts.shownTextBytes, textBlocks(result.content).reduce((sum, block) => sum + bytes(block.text), 0));
	assert.equal(result.facts.shownTextLines, textBlocks(result.content).reduce((sum, block) => sum + lines(block.text), 0));
	assert.match(shownText(result.content), /workbench-output truncated/);
	assert.match(shownText(result.content), /continuation=run-log:wbcur1\.safe/);
	assert.doesNotMatch(shownText(result.content), /action=/);
	assert.equal(hasLoneSurrogate(shownText(result.content)), false);
});

test("truncated bash uses a fixed rerun-redirect-read action without trusting details", () => {
	const result = enforceOutputEnvelope({
		toolName: "bash",
		content: [{ type: "text", text: "x".repeat(80 * 1_024) }],
		isError: false,
		policy: policy(16_384, 240),
		allocatedBytes: 16_384,
	});
	const visible = providerVisibleText(result.content);
	assert.equal(result.facts.truncated, true);
	assert.ok(bytes(visible) <= 16_384);
	assert.match(visible, /action=rerun_redirect_file_then_bounded_read/);
	assert.doesNotMatch(visible, /receipt=/);
});

test("a lower allocation does not relabel line-only truncation as a turn reservation", () => {
	const result = enforceOutputEnvelope({
		toolName: "x",
		content: [{ type: "text", text: "one\ntwo\nthree" }],
		isError: false,
		policy: policy(400, 2),
		allocatedBytes: 180,
	});
	assert.equal(result.facts.truncated, true);
	assert.ok(result.facts.originalTextBytes < 180);
	assert.equal(result.facts.reason, "per-tool-cap");
});

test("error cap, zero/invalid allocation, and policy cap can only lower output", () => {
	const huge = [{ type: "text" as const, text: "x".repeat(20_000) }];
	const error = enforceOutputEnvelope({ toolName: "x", content: huge, isError: true, policy: policy(16_384, 240), allocatedBytes: 20_000 });
	assert.ok(error.facts.shownTextBytes <= 8_192);
	const fitsPolicy = [{ type: "text" as const, text: "x".repeat(100) }];
	for (const allocatedBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		const empty = enforceOutputEnvelope({ toolName: "x", content: fitsPolicy, isError: false, policy: policy(16_384, 240), allocatedBytes });
		assert.deepEqual(empty.content, []);
		assert.equal(empty.facts.shownTextBytes, 0);
		assert.equal(empty.facts.reason, "turn-reservation");
	}
});

test("only native-read preserves the first image; all other images become bounded omission facts", () => {
	const first: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };
	const second: ImageContent = { type: "image", data: "BBBB", mimeType: "image/png" };
	const preserved = enforceOutputEnvelope({ toolName: "read", content: [first, { type: "text", text: "caption" }, second], isError: false, policy: resolveToolOutputPolicy({ toolName: "read", args: {}, role: "commander" }), allocatedBytes: 12_288 });
	assert.deepEqual(preserved.content[0], first);
	assert.equal(preserved.facts.shownImageCount, 1);
	assert.equal(preserved.facts.omittedImageCount, 1);
	assert.equal(textBlocks(preserved.content).length, 1);
	assert.match(shownText(preserved.content), /image omitted/);
	const dropped = enforceOutputEnvelope({ toolName: "x", content: [first], isError: false, policy: policy(128, 4), allocatedBytes: 64 });
	assert.equal(dropped.content.some((block) => block.type === "image"), false);
	assert.equal(dropped.facts.omittedImageCount, 1);
	assert.equal(dropped.facts.reason, "per-tool-cap");
});

test("forged policy objects cannot enlarge fixed ceilings or enable images", () => {
	const hugeText = `${"x".repeat(20_000)}\n${"line\n".repeat(300)}`;
	const forgedDefault: ToolOutputPolicy = {
		id: "default",
		maxTextBytes: 1_000_000_000,
		maxLines: 1_000_000_000,
		minReservationBytes: 1,
		overflow: "receipt-only",
		preserveImages: true,
	};
	const image: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };
	const boundedDefault = enforceOutputEnvelope({
		toolName: "forged",
		content: [{ type: "text", text: hugeText }, image],
		isError: false,
		policy: forgedDefault,
		allocatedBytes: 1_000_000_000,
	});
	assert.ok(boundedDefault.facts.shownTextBytes <= 16_384);
	assert.ok(boundedDefault.facts.shownTextLines <= 240);
	assert.equal(boundedDefault.facts.policy, "default");
	assert.equal(boundedDefault.content.some((block) => block.type === "image"), false);

	const forgedUnknown = { ...forgedDefault, id: "unknown-policy" } as unknown as ToolOutputPolicy;
	const boundedUnknown = enforceOutputEnvelope({
		toolName: "forged",
		content: [{ type: "text", text: hugeText }],
		isError: false,
		policy: forgedUnknown,
		allocatedBytes: 1_000_000_000,
	});
	assert.equal(boundedUnknown.facts.policy, "default");
	assert.ok(boundedUnknown.facts.shownTextBytes <= 16_384);
	assert.ok(boundedUnknown.facts.shownTextLines <= 240);
	assert.deepEqual(resolveOutputPolicyHardCeiling("unknown-policy"), resolveOutputPolicyHardCeiling("default"));

	const forgedNative: ToolOutputPolicy = { ...forgedDefault, id: "native-read-page" };
	const boundedNative = enforceOutputEnvelope({
		toolName: "forged",
		content: [{ type: "text", text: hugeText }, image],
		isError: false,
		policy: forgedNative,
		allocatedBytes: 1_000_000_000,
	});
	assert.ok(boundedNative.facts.shownTextBytes <= 12_288);
	assert.ok(boundedNative.facts.shownTextLines <= 252);
	assert.equal(boundedNative.facts.shownImageCount, 1);
});

test("hostile getters fail closed deterministically without returning raw content", () => {
	const hostile = new Proxy({} as TextContent, { get(_target, key): never { throw new Error(`secret-${String(key)}`); } });
	const input = { toolName: "x", content: [hostile], isError: false, policy: policy(100, 4), allocatedBytes: 100 };
	const a = enforceOutputEnvelope(input);
	const b = enforceOutputEnvelope(input);
	assert.deepEqual(a, b);
	assert.equal(a.isError, true);
	assert.equal(a.facts.reason, "runtime-failure");
	assert.equal(shownText(a.content), "output_envelope_error");
	assert.doesNotMatch(shownText(a.content), /secret/);
});

test("runtime failure obeys the policy byte and line caps as well as the allocation", () => {
	const hostile = new Proxy({} as TextContent, { get(): never { throw new Error("raw-secret"); } });
	const policyFive = enforceOutputEnvelope({ toolName: "x", content: [hostile], isError: false, policy: policy(5, 4), allocatedBytes: 100 });
	assert.ok(policyFive.facts.shownTextBytes <= 5);
	assert.equal(shownText(policyFive.content), "outpu");

	const noLines = enforceOutputEnvelope({ toolName: "x", content: [hostile], isError: false, policy: policy(100, 0), allocatedBytes: 100 });
	assert.deepEqual(noLines.content, []);
	assert.equal(noLines.facts.shownTextLines, 0);

	const allocationTen = enforceOutputEnvelope({ toolName: "x", content: [hostile], isError: false, policy: policy(100, 4), allocatedBytes: 10 });
	assert.ok(allocationTen.facts.shownTextBytes <= 10);
	assert.equal(shownText(allocationTen.content), "output_env");
	assert.doesNotMatch(shownText(allocationTen.content), /raw-secret/);
});

test("unknown or throwing cap getters keep runtime failure at the zero-output lower bound", () => {
	const hostileContent = new Proxy({} as TextContent, { get(): never { throw new Error("raw-secret"); } });
	const throwingPolicy = new Proxy(policy(100, 4), {
		get(target, key, receiver): unknown {
			if (key === "maxTextBytes") throw new Error("policy-secret");
			return Reflect.get(target, key, receiver);
		},
	});
	const badPolicy = enforceOutputEnvelope({ toolName: "x", content: [hostileContent], isError: false, policy: throwingPolicy, allocatedBytes: 100 });
	assert.deepEqual(badPolicy.content, []);
	assert.equal(badPolicy.facts.shownTextBytes, 0);

	const throwingAllocation = new Proxy({
		toolName: "x",
		content: [hostileContent],
		isError: false,
		policy: policy(100, 4),
		allocatedBytes: 100,
	}, {
		get(target, key, receiver): unknown {
			if (key === "allocatedBytes") throw new Error("allocation-secret");
			return Reflect.get(target, key, receiver);
		},
	});
	const badAllocation = enforceOutputEnvelope(throwingAllocation as typeof throwingAllocation & Parameters<typeof enforceOutputEnvelope>[0]);
	assert.deepEqual(badAllocation.content, []);
	assert.equal(badAllocation.facts.shownTextBytes, 0);
});

test("streaming envelope bounds a 2 MiB multi-block unicode update with its marker inside 4096 bytes", () => {
	const first = "汉🙂line\n".repeat(150_000);
	const second = `${"β".repeat(300_000)}\ud800STREAM-RAW-TAIL`;
	const image: ImageContent = { type: "image", data: "A".repeat(2_000_000), mimeType: "image/png" };
	const result = enforceStreamingUpdate({
		toolName: "workbench_run_recipe",
		content: [
			{ type: "text", text: first },
			{ type: "text", text: second },
			image,
		],
	});
	const shown = shownText(result.content);
	assert.ok(result.facts.originalTextBytes > 2 * 1_024 * 1_024);
	assert.ok(result.facts.shownTextBytes <= STREAM_UPDATE_MAX_BYTES);
	assert.ok(result.facts.shownTextLines <= STREAM_UPDATE_MAX_LINES);
	assert.equal(result.facts.shownTextBytes, textBlocks(result.content).reduce((sum, block) => sum + bytes(block.text), 0));
	assert.equal(result.facts.shownTextLines, textBlocks(result.content).reduce((sum, block) => sum + lines(block.text), 0));
	assert.equal(result.facts.truncated, true);
	assert.equal(result.facts.reason, "per-tool-cap");
	assert.equal(result.facts.shownImageCount, 0);
	assert.equal(result.facts.omittedImageCount, 1);
	assert.equal(result.content.some((block) => block.type === "image"), false);
	assert.match(shown, /workbench-output image omitted/);
	assert.match(shown, /workbench-output truncated/);
	assert.doesNotMatch(shown, /receipt=/);
	assert.doesNotMatch(shown, /STREAM-RAW-TAIL/);
	assert.equal(hasLoneSurrogate(shown), false);
});

test("streaming envelope returns one fixed short fail-closed result for proxy, getter, and circular hostile blocks", () => {
	const proxy = new Proxy({} as TextContent, {
		get(): never { throw new Error("PROXY-STREAM-SECRET"); },
	});
	const getter = Object.defineProperty({}, "type", {
		enumerable: true,
		get(): never { throw new Error("GETTER-STREAM-SECRET"); },
	}) as TextContent;
	const circular: Record<string, unknown> = { type: "text" };
	circular.text = circular;
	const arrayProxy = new Proxy([] as TextContent[], {
		get(): never { throw new Error("ARRAY-STREAM-SECRET"); },
	});
	const results = [
		enforceStreamingUpdate({ toolName: "workbench_run_recipe", content: [proxy] }),
		enforceStreamingUpdate({ toolName: "workbench_run_recipe", content: [getter] }),
		enforceStreamingUpdate({ toolName: "workbench_run_recipe", content: [circular] }),
		enforceStreamingUpdate({ toolName: "workbench_run_recipe", content: arrayProxy }),
	];
	for (const result of results) {
		assert.equal(shownText(result.content), "output_envelope_error");
		assert.equal(result.facts.reason, "runtime-failure");
		assert.equal(result.isError, true);
		assert.ok(result.facts.shownTextBytes <= STREAM_UPDATE_MAX_BYTES);
		assert.ok(result.facts.shownTextLines <= STREAM_UPDATE_MAX_LINES);
		assert.doesNotMatch(JSON.stringify(result), /STREAM-SECRET/);
	}
	for (const result of results.slice(1)) assert.deepEqual(result, results[0]);
});
