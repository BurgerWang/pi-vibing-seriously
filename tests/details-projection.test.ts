import assert from "node:assert/strict";
import { test } from "node:test";

import {
	projectLegacyDetails,
	projectToolResultDetails,
	type BoundedReceiptFacts,
} from "../extensions/workbench-runtime/core/details-projection.ts";
import type { OutputEnvelopeFacts } from "../extensions/workbench-runtime/core/output-envelope.ts";
import { DETAILS_MAX_BYTES } from "../extensions/workbench-runtime/core/output-policy.ts";
import { WORKBENCH_TOOL_NAMES } from "../extensions/workbench-runtime/core/tool-catalog.ts";

function envelope(overrides: Partial<OutputEnvelopeFacts> = {}): OutputEnvelopeFacts {
	return {
		schema: "workbench-output-v1",
		policy: "default",
		truncated: false,
		originalTextBytes: 7,
		originalTextLines: 1,
		shownTextBytes: 7,
		shownTextLines: 1,
		omittedTextBytes: 0,
		omittedTextLines: 0,
		originalImageCount: 0,
		shownImageCount: 0,
		omittedImageCount: 0,
		reason: "none",
		...overrides,
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
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

test("per-tool DTO drops full records and rebuilds security facts only from trusted arguments", () => {
	const trustedEnvelope = envelope({ policy: "run-summary", shownTextBytes: 5 });
	const receipt: BoundedReceiptFacts = {
		available: true,
		result_id: "wtr1-abc",
		tool: "workbench_run_recipe",
		status: "finalized",
		path: ".pi/workbench/tool-results/wtr1-abc/finalized.json",
	};
	const result = projectToolResultDetails({
		toolName: "workbench_run_recipe",
			details: {
				ok: true,
				run_id: "20260812-000000-abcd",
				recipe: "check",
				command_effect_status: "RECIPE_DECLARATION_VIOLATION",
				command_effect_path: ".pi/workbench/runs/20260812-000000-abcd/command-effect.json",
				command_effect_warning: "COMMAND_EFFECT_EVIDENCE_UNAVAILABLE",
			record: { secret: "full-record" },
			stdout: "raw stdout",
			output_envelope: { policy: "compare", shownTextBytes: 999_999 },
			receipt: { available: true, result_id: "attacker" },
			unknown_field: "not in DTO",
		},
		envelope: trustedEnvelope,
		receipt,
	});
	const details = asRecord(result.details);
	assert.equal(details.ok, true);
	assert.equal(details.run_id, "20260812-000000-abcd");
	assert.equal(details.recipe, "check");
	assert.equal(details.command_effect_status, "RECIPE_DECLARATION_VIOLATION");
	assert.equal(details.command_effect_path, ".pi/workbench/runs/20260812-000000-abcd/command-effect.json");
	assert.equal(details.command_effect_warning, "COMMAND_EFFECT_EVIDENCE_UNAVAILABLE");
	assert.equal(Object.hasOwn(details, "record"), false);
	assert.equal(Object.hasOwn(details, "stdout"), false);
	assert.equal(Object.hasOwn(details, "unknown_field"), false);
	assert.deepEqual(details.output_envelope, trustedEnvelope);
	assert.deepEqual(details.receipt, receipt);
	assert.equal(JSON.stringify(details).includes("full-record"), false);
	assert.equal(JSON.stringify(details).includes("attacker"), false);
	assert.equal(result.truncated, true);
	assert.equal(result.serializedBytes, Buffer.byteLength(JSON.stringify(details), "utf8"));
	assert.ok(result.serializedBytes <= DETAILS_MAX_BYTES);
});

test("all registered tools use a whitelist and reject an unlisted domain payload", () => {
	for (const toolName of WORKBENCH_TOOL_NAMES) {
		const result = projectToolResultDetails({
			toolName,
			details: { ok: true, definitely_not_a_dto_field: `secret-${toolName}` },
			envelope: envelope(),
		});
		const details = asRecord(result.details);
		assert.equal(Object.hasOwn(details, "definitely_not_a_dto_field"), false, toolName);
		assert.equal(JSON.stringify(details).includes(`secret-${toolName}`), false, toolName);
		assert.ok(result.serializedBytes <= DETAILS_MAX_BYTES, toolName);
	}
});

test("trusted bash/edit/write details use explicit root and nested DTO whitelists", () => {
	const bash = projectToolResultDetails({
		toolName: "bash",
		details: {
			truncation: {
				content: "raw-output-secret",
				truncated: true,
				truncatedBy: "bytes",
				totalLines: 10_000,
				totalBytes: 500_000,
				outputLines: 2_000,
				outputBytes: 51_200,
				lastLinePartial: false,
				firstLineExceedsLimit: false,
				maxLines: 2_000,
				maxBytes: 51_200,
				nested_injection: "nested-secret",
			},
			fullOutputPath: "/tmp/pi-bash-output.log",
			root_injection: "root-secret",
		},
		envelope: envelope(),
	});
	const bashDetails = asRecord(bash.details);
	const truncation = asRecord(bashDetails.truncation);
	assert.deepEqual(Object.keys(truncation), [
		"truncated", "truncatedBy", "totalLines", "totalBytes", "outputLines", "outputBytes",
		"lastLinePartial", "firstLineExceedsLimit", "maxLines", "maxBytes",
	]);
	assert.equal(truncation.truncated, true);
	assert.equal(truncation.totalBytes, 500_000);
	assert.equal(Object.hasOwn(truncation, "content"), false, "raw output is not duplicated into session details");
	assert.equal(bashDetails.fullOutputPath, "/tmp/pi-bash-output.log");
	assert.equal(Object.hasOwn(bashDetails, "root_injection"), false);
	assert.doesNotMatch(JSON.stringify(bashDetails), /(?:raw-output|nested|root)-secret/);
	assert.equal(bash.truncated, true);
	assert.ok(bash.serializedBytes <= DETAILS_MAX_BYTES);

	const edit = projectToolResultDetails({
		toolName: "edit",
		details: {
			diff: "full-diff-secret",
			patch: "full-patch-secret",
			firstChangedLine: 17,
			unexpected: "edit-secret",
		},
		envelope: envelope(),
	});
	const editDetails = asRecord(edit.details);
	assert.equal(editDetails.firstChangedLine, 17);
	assert.equal(Object.hasOwn(editDetails, "diff"), false);
	assert.equal(Object.hasOwn(editDetails, "patch"), false);
	assert.equal(Object.hasOwn(editDetails, "unexpected"), false);
	assert.doesNotMatch(JSON.stringify(editDetails), /secret/);
	assert.ok(edit.serializedBytes <= DETAILS_MAX_BYTES);

	const write = projectToolResultDetails({
		toolName: "write",
		details: { content: "write-content-secret", unexpected: "write-secret" },
		envelope: envelope(),
	});
	const writeDetails = asRecord(write.details);
	assert.deepEqual(Object.keys(writeDetails), ["output_envelope"]);
	assert.doesNotMatch(JSON.stringify(writeDetails), /write-(?:content-)?secret/);
	assert.equal(write.truncated, true);
	assert.ok(write.serializedBytes <= DETAILS_MAX_BYTES);

	const normalWrite = projectToolResultDetails({ toolName: "write", details: undefined, envelope: envelope() });
	assert.equal(normalWrite.truncated, false, "the builtin write tool's documented undefined details are valid");
	assert.ok(normalWrite.serializedBytes <= DETAILS_MAX_BYTES);
});

test("generic fallback enforces depth, key, item, string, UTF-8 and total bounds", () => {
	const manyKeys = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`key_${String(index).padStart(3, "0")}`, "汉🙂".repeat(400)]));
	const nested = { level1: { level2: { level3: { level4: { raw: "too deep" } } } } };
	const result = projectToolResultDetails({
		toolName: "third_party_tool",
		details: {
			manyKeys,
			items: Array.from({ length: 100 }, (_, index) => `item-${index}`),
			nested,
			long: "🙂".repeat(1_000),
		},
		envelope: envelope(),
	});
	const details = asRecord(result.details);
	const serialized = JSON.stringify(details);
	assert.ok(result.serializedBytes <= DETAILS_MAX_BYTES);
	assert.equal(result.serializedBytes, Buffer.byteLength(serialized, "utf8"));
	assert.equal(result.truncated, true);
	assert.ok(Buffer.byteLength(String(details.long), "utf8") <= 512);
	const items = details.items as unknown[];
	assert.equal(items.length, 32);
	assert.deepEqual(items[31], { original_items: 100, shown_items: 31, omitted_items: 69 });
	assert.match(serialized, /\[depth_limit\]/);
	assert.doesNotMatch(serialized, /too deep/);
	assert.equal(hasLoneSurrogate(serialized), false);
});

test("circular, BigInt, non-finite, accessor and unsupported values are stable pure data", () => {
	let getterCalls = 0;
	const source: Record<string, unknown> = {
		big: 12345678901234567890n,
		nan: Number.NaN,
		positive: Number.POSITIVE_INFINITY,
		negative: Number.NEGATIVE_INFINITY,
		fn: () => "secret",
	};
	source.self = source;
	Object.defineProperty(source, "danger", {
		enumerable: true,
		get(): never { getterCalls += 1; throw new Error("getter secret"); },
	});
	const first = projectToolResultDetails({ toolName: "unknown", details: source, envelope: envelope() });
	const second = projectToolResultDetails({ toolName: "unknown", details: source, envelope: envelope() });
	assert.equal(getterCalls, 0);
	assert.deepEqual(first, second);
	const details = asRecord(first.details);
	assert.equal(details.big, "12345678901234567890n");
	assert.equal(details.nan, "NaN");
	assert.equal(details.positive, "Infinity");
	assert.equal(details.negative, "-Infinity");
	assert.equal(details.fn, "[unsupported]");
	assert.equal(details.self, "[circular]");
	assert.equal(details.danger, "[unavailable_accessor]");
	assert.doesNotThrow(() => structuredClone(details));
	assert.doesNotMatch(JSON.stringify(details), /getter secret/);
});

test("a hostile proxy is brand-checked without invoking any reflection or value trap", () => {
	const trapCalls = {
		ownKeys: 0,
		getOwnPropertyDescriptor: 0,
		getPrototypeOf: 0,
		get: 0,
	};
	const hostile = new Proxy({}, {
		ownKeys(): never { trapCalls.ownKeys += 1; throw new Error("proxy ownKeys secret"); },
		getOwnPropertyDescriptor(): never {
			trapCalls.getOwnPropertyDescriptor += 1;
			throw new Error("proxy descriptor secret");
		},
		getPrototypeOf(): never { trapCalls.getPrototypeOf += 1; throw new Error("proxy prototype secret"); },
		get(): never { trapCalls.get += 1; throw new Error("proxy get secret"); },
	});
	const result = projectToolResultDetails({
		toolName: "workbench_project_inspect",
		details: hostile,
		envelope: envelope({ truncated: true, reason: "runtime-failure" }),
	});
	const details = asRecord(result.details);
	assert.deepEqual(details.details_projection, { available: false, code: "projection_error" });
	assert.equal(Object.hasOwn(details, "output_envelope"), true);
	assert.equal(Object.hasOwn(details, "receipt"), false);
	assert.equal(JSON.stringify(details).includes("secret"), false);
	assert.deepEqual(trapCalls, { ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0, get: 0 });
	assert.equal(result.truncated, true);
	assert.ok(result.serializedBytes <= DETAILS_MAX_BYTES);
});

test("a nested selected proxy also fails closed without invoking traps", () => {
	let trapCalls = 0;
	const nested = new Proxy([], {
		ownKeys(): never { trapCalls += 1; throw new Error("nested proxy secret"); },
		getOwnPropertyDescriptor(): never { trapCalls += 1; throw new Error("nested proxy secret"); },
		getPrototypeOf(): never { trapCalls += 1; throw new Error("nested proxy secret"); },
		get(): never { trapCalls += 1; throw new Error("nested proxy secret"); },
	});
	const result = projectToolResultDetails({
		toolName: "workbench_run_recipe",
		details: { ok: true, artifact_paths: nested },
		envelope: envelope(),
	});
	const details = asRecord(result.details);
	assert.deepEqual(details.details_projection, { available: false, code: "projection_error" });
	assert.equal(trapCalls, 0);
	assert.equal(JSON.stringify(details).includes("nested proxy secret"), false);
	assert.ok(result.serializedBytes <= DETAILS_MAX_BYTES);
});

test("review DTO replaces full arrays with exact counts and bounded continuation paths", () => {
	const result = projectToolResultDetails({
		toolName: "workbench_review_worker_diff",
		details: {
			ok: true,
			delegation_id: "20260812-000000-abcd",
			verdict: "PASS",
			violations: Array.from({ length: 10 }, (_, index) => ({ path: `v-${index}`, reason: "long prose" })),
			drift_paths: Array.from({ length: 20 }, (_, index) => `d-${index}`),
			checked_paths: Array.from({ length: 40 }, (_, index) => `c-${index}`),
			displayed_paths: Array.from({ length: 30 }, (_, index) => `p-${index}`),
			remaining_paths: Array.from({ length: 50 }, (_, index) => `r-${index}`),
			patch_paths: Array.from({ length: 50 }, (_, index) => ({ path: `secret-${index}`, patch: "raw" })),
			patch_truncated: true,
		},
		envelope: envelope({ policy: "diff-review" }),
	});
	const details = asRecord(result.details);
	assert.equal(details.violation_count, 10);
	assert.equal(details.drift_count, 20);
	assert.equal(details.checked_count, 40);
	assert.equal(details.displayed_count, 30);
	assert.equal(details.remaining_count, 50);
	assert.equal(Object.hasOwn(details, "violations"), false);
	assert.equal(Object.hasOwn(details, "drift_paths"), false);
	assert.equal(Object.hasOwn(details, "patch_paths"), false);
	const next = details.next_include_paths as unknown[];
	assert.equal(next.length, 32);
	assert.deepEqual(next[31], { original_items: 50, shown_items: 31, omitted_items: 19 });
	assert.equal(JSON.stringify(details).includes("long prose"), false);
	assert.equal(JSON.stringify(details).includes("secret-"), false);
	assert.ok(result.serializedBytes <= DETAILS_MAX_BYTES);
});

test("whole-details fitting preserves security metadata when ordinary DTO fields exceed 8 KiB", () => {
	const huge = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`field_${index}`, "x".repeat(512)]));
	const result = projectToolResultDetails({
		toolName: "unknown",
		details: huge,
		envelope: envelope({ policy: "compare", truncated: true, omittedTextBytes: 1_000 }),
		receipt: { available: false, code: "storage_error", result_id: "wtr1-safe" },
	});
	const details = asRecord(result.details);
	assert.ok(result.serializedBytes <= DETAILS_MAX_BYTES);
	assert.equal(result.serializedBytes, Buffer.byteLength(JSON.stringify(details), "utf8"));
	assert.equal(result.truncated, true);
	assert.equal(asRecord(details.output_envelope).policy, "compare");
	assert.deepEqual(details.receipt, { available: false, code: "storage_error", result_id: "wtr1-safe" });
	const shownOrdinaryKeys = Object.keys(details).filter((key) =>
		key !== "details_projection_omitted_keys" && key !== "output_envelope" && key !== "receipt").length;
	const omittedKeys = details.details_projection_omitted_keys;
	assert.equal(typeof omittedKeys, "number");
	assert.equal(shownOrdinaryKeys + Number(omittedKeys), 32);
});

test("whole-details fitting keeps a 32 by 512-byte array field with exact item counts", () => {
	const items = Array.from({ length: 32 }, (_, index) =>
		`item-${String(index).padStart(2, "0")}-` + "x".repeat(504));
	for (const item of items) assert.equal(Buffer.byteLength(item, "utf8"), 512);

	const first = projectToolResultDetails({
		toolName: "third_party_tool",
		details: { items },
		envelope: envelope(),
	});
	const second = projectToolResultDetails({
		toolName: "third_party_tool",
		details: { items },
		envelope: envelope(),
	});
	assert.deepEqual(first, second);
	const details = asRecord(first.details);
	const shown = details.items as unknown[];
	assert.ok(Array.isArray(shown));
	assert.ok(shown.length <= 32);
	const marker = asRecord(shown.at(-1));
	assert.equal(marker.original_items, 32);
	assert.equal(marker.shown_items, shown.length - 1);
	assert.equal(marker.omitted_items, 32 - (shown.length - 1));
	assert.ok(Number(marker.omitted_items) > 0);
	assert.equal(first.serializedBytes, Buffer.byteLength(JSON.stringify(details), "utf8"));
	assert.ok(first.serializedBytes <= DETAILS_MAX_BYTES);
	assert.equal(first.truncated, true);
	assert.doesNotThrow(() => structuredClone(details));
});

test("nested arrays are fitted item-by-item and retain exact counts at every clipped level", () => {
	const inner = (prefix: string) => Array.from({ length: 32 }, (_, index) =>
		`${prefix}-${String(index).padStart(2, "0")}-` + "z".repeat(505));
	const result = projectToolResultDetails({
		toolName: "third_party_tool",
		details: { nested: [inner("a"), inner("b")] },
		envelope: envelope(),
	});
	const details = asRecord(result.details);
	const outer = details.nested as unknown[];
	assert.equal(outer.length, 2);
	for (const projectedInner of outer) {
		assert.ok(Array.isArray(projectedInner));
		assert.ok(projectedInner.length <= 32);
		const marker = asRecord(projectedInner.at(-1));
		assert.equal(marker.original_items, 32);
		assert.equal(marker.shown_items, projectedInner.length - 1);
		assert.equal(marker.omitted_items, 32 - (projectedInner.length - 1));
	}
	assert.ok(result.serializedBytes <= DETAILS_MAX_BYTES);
	assert.equal(result.serializedBytes, Buffer.byteLength(JSON.stringify(details), "utf8"));
	assert.equal(result.truncated, true);
});

test("legacy generic projection never mints trusted security facts", () => {
	const source: Record<string, unknown> = {
		ok: true,
		record: { full: "domain record" },
		output_envelope: { policy: "forged" },
		receipt: { result_id: "forged" },
	};
	source.self = source;
	const result = projectLegacyDetails(source);
	const details = asRecord(result.details);
	assert.equal(details.ok, true);
	assert.equal(Object.hasOwn(details, "record"), false);
	assert.equal(Object.hasOwn(details, "output_envelope"), false);
	assert.equal(Object.hasOwn(details, "receipt"), false);
	assert.equal(details.self, "[circular]");
	assert.equal(JSON.stringify(details).includes("domain record"), false);
	assert.ok(result.serializedBytes <= DETAILS_MAX_BYTES);
});
