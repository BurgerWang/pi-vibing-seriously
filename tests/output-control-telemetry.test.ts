import assert from "node:assert/strict";
import { test } from "node:test";

import {
	COMMANDER_HISTORY_MAX_BYTES,
	COMMANDER_TURN_MAX_BYTES,
	WORKER_HISTORY_MAX_BYTES,
	WORKER_TURN_MAX_BYTES,
} from "../extensions/workbench-runtime/core/output-policy.ts";
import {
	OUTPUT_CONTROL_ADVISORY_THRESHOLDS,
	OUTPUT_CONTROL_STATUS_MAX_BYTES,
	OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE,
	OUTPUT_CONTROL_TELEMETRY_SCHEMA,
	OUTPUT_CONTROL_TOOL_IDS,
	OutputControlTelemetryAccumulator,
	createOutputControlTelemetry,
	evaluateOutputControlAdvisory,
	mergeOutputControlTelemetry,
	parseOutputControlTelemetry,
	parseOutputControlTelemetryEntry,
	renderOutputControlStatusJson,
	renderOutputControlStatusText,
	serializeOutputControlTelemetry,
	type OutputControlTelemetrySnapshot,
} from "../extensions/workbench-runtime/core/output-control-telemetry.ts";

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: "workbench-output-v1",
		policy: "default",
		truncated: false,
		originalTextBytes: 100,
		originalTextLines: 2,
		shownTextBytes: 100,
		shownTextLines: 2,
		omittedTextBytes: 0,
		omittedTextLines: 0,
		originalImageCount: 0,
		shownImageCount: 0,
		omittedImageCount: 0,
		reason: "none",
		...overrides,
	};
}

function turn(
	role: "commander" | "worker" | "other",
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const maxBytes = role === "commander" ? COMMANDER_TURN_MAX_BYTES : WORKER_TURN_MAX_BYTES;
	return {
		schema: "workbench-turn-output-telemetry-v1",
		turnSerial: 1,
		role,
		planned: true,
		maxBytes,
		reservationCount: 2,
		blockedCalls: 1,
		consumedCalls: 1,
		releasedCalls: 0,
		reservedBytes: 12_000,
		consumedBytes: 8_000,
		controlConsumedBytes: 40,
		totalAccountedBytes: 8_040,
		releasedBytes: 3_960,
		unusedBytes: maxBytes - 8_040,
		...overrides,
	};
}

function history(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		originalToolTextBytes: 10_000,
		finalToolTextBytes: 8_000,
		collapsedResults: 2,
		removedBundles: 1,
		protectedLatestBundles: 2,
		...overrides,
	};
}

function cloneSnapshot(value: OutputControlTelemetrySnapshot): Record<string, unknown> {
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

test("session accumulator records envelope, turn, history, per-tool maxima and fixed unknown bucket", () => {
	const telemetry = createOutputControlTelemetry("commander");
	assert.equal(telemetry.recordEnvelope("read", envelope()), true);
	assert.equal(telemetry.recordEnvelope("secret-tool-name", envelope({
		truncated: true,
		originalTextBytes: 1_000,
		shownTextBytes: 200,
		omittedTextBytes: 850,
		reason: "per-tool-cap",
	})), true);
	assert.equal(telemetry.recordTurn(turn("commander")), true);
	assert.equal(telemetry.recordHistory(history(), "commander"), true);

	const snapshot = telemetry.snapshot();
	assert.deepEqual(snapshot.totals, {
		toolResults: 2,
		rawTextBytes: 1_100,
		shownTextBytes: 300,
		omittedTextBytes: 850,
		truncatedResults: 1,
		blockedCalls: 1,
		batchReservedBytes: 12_000,
		historyCollapsedResults: 2,
		historyRemovedBundles: 1,
	});
	assert.deepEqual(snapshot.perTool.map((item) => item.tool), ["read", "other"]);
	assert.equal(snapshot.perTool[1]!.maxResultBytes, 200);
	assert.equal(snapshot.maxResultBytes, 200);
	assert.equal(snapshot.maxBatchReservedBytes, 12_000);
	assert.equal(snapshot.activeHistoryToolTextBytes, 8_000);
	assert.equal(snapshot.turnHardCapBytes, COMMANDER_TURN_MAX_BYTES);
	assert.equal(snapshot.historyHardCapBytes, COMMANDER_HISTORY_MAX_BYTES);
	assert.equal(snapshot.compliance, "COMPLIANT");
	assert.equal(Object.isFrozen(snapshot), true);
	assert.equal(Object.isFrozen(snapshot.totals), true);
	assert.equal(Object.isFrozen(snapshot.perTool), true);
	assert.equal(Object.isFrozen(snapshot.perTool[0]), true);
});

test("role hard caps are fixed and telemetry observes violations without changing enforcement", () => {
	for (const [role, expectedTurn, expectedHistory] of [
		["commander", COMMANDER_TURN_MAX_BYTES, COMMANDER_HISTORY_MAX_BYTES],
		["worker", WORKER_TURN_MAX_BYTES, WORKER_HISTORY_MAX_BYTES],
		["other", WORKER_TURN_MAX_BYTES, WORKER_HISTORY_MAX_BYTES],
	] as const) {
		const telemetry = createOutputControlTelemetry(role);
		assert.equal(telemetry.snapshot().turnHardCapBytes, expectedTurn);
		assert.equal(telemetry.snapshot().historyHardCapBytes, expectedHistory);
		assert.equal(telemetry.recordTurn(turn(role, {
			maxBytes: expectedTurn + 1,
			reservedBytes: expectedTurn + 1,
			totalAccountedBytes: expectedTurn + 1,
		})), true);
		assert.equal(telemetry.recordHistory(history({ finalToolTextBytes: expectedHistory + 1 }), role), true);
		const snapshot = telemetry.snapshot();
		assert.equal(snapshot.turnCapViolations, 1);
		assert.equal(snapshot.historyCapViolations, 1);
		assert.equal(snapshot.hardCapViolations, 2);
		assert.equal(snapshot.compliance, "VIOLATION");
	}

	const envelopeViolation = createOutputControlTelemetry("worker");
	assert.equal(envelopeViolation.recordEnvelope("read", envelope({
		policy: "native-read-page",
		shownTextBytes: 12_289,
		shownTextLines: 253,
	})), true);
	assert.equal(envelopeViolation.snapshot().envelopeCapViolations, 1);
	assert.equal(envelopeViolation.snapshot().compliance, "VIOLATION");
});

test("advisory bands are fixed, threshold-inclusive and observation-only", () => {
	const totals = createOutputControlTelemetry("worker").snapshot().totals;
	assert.equal(evaluateOutputControlAdvisory(totals), "OK");
	assert.equal(evaluateOutputControlAdvisory({
		...totals,
		toolResults: OUTPUT_CONTROL_ADVISORY_THRESHOLDS.softTruncatedResults,
		truncatedResults: OUTPUT_CONTROL_ADVISORY_THRESHOLDS.softTruncatedResults,
	}), "SOFT");
	assert.equal(evaluateOutputControlAdvisory({
		...totals,
		toolResults: OUTPUT_CONTROL_ADVISORY_THRESHOLDS.highHistoryCollapsedResults,
		historyCollapsedResults: OUTPUT_CONTROL_ADVISORY_THRESHOLDS.highHistoryCollapsedResults,
	}), "HIGH");
	assert.equal(evaluateOutputControlAdvisory({
		...totals,
		toolResults: OUTPUT_CONTROL_ADVISORY_THRESHOLDS.highHistoryRemovedBundles,
		historyRemovedBundles: OUTPUT_CONTROL_ADVISORY_THRESHOLDS.highHistoryRemovedBundles,
	}), "HIGH");

	const telemetry = createOutputControlTelemetry("worker");
	for (let index = 0; index < OUTPUT_CONTROL_ADVISORY_THRESHOLDS.softTruncatedResults; index += 1) {
		telemetry.recordEnvelope("read", envelope({ truncated: true, reason: "per-tool-cap" }));
	}
	assert.equal(telemetry.snapshot().advisory, "SOFT");
	assert.equal(telemetry.snapshot().compliance, "COMPLIANT", "advisory cannot manufacture a hard-cap violation");
});

test("canonical persistence is deterministic, strict and JSON round-trippable", () => {
	const first = createOutputControlTelemetry("worker");
	first.recordEnvelope("grep", envelope({ originalTextBytes: 3, shownTextBytes: 3 }));
	first.recordEnvelope("read", envelope({ originalTextBytes: 5, shownTextBytes: 5 }));
	first.recordTurn(turn("worker"));
	first.recordHistory(history(), "worker");

	const second = createOutputControlTelemetry("worker");
	second.recordHistory(history(), "worker");
	second.recordEnvelope("read", envelope({ originalTextBytes: 5, shownTextBytes: 5 }));
	second.recordTurn(turn("worker"));
	second.recordEnvelope("grep", envelope({ originalTextBytes: 3, shownTextBytes: 3 }));

	const serialized = serializeOutputControlTelemetry(first.snapshot());
	assert.equal(JSON.stringify(serialized), JSON.stringify(second.snapshot()));
	const json = JSON.stringify(serialized);
	const parsed = parseOutputControlTelemetry(JSON.parse(json));
	assert.deepEqual(parsed, serialized);
	assert.equal(Object.isFrozen(parsed), true);
	assert.deepEqual(parseOutputControlTelemetryEntry({
		type: "custom",
		customType: OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE,
		data: JSON.parse(json),
		id: "pi-metadata-is-not-telemetry-data",
	}), serialized);

	const unknown = { ...cloneSnapshot(serialized), unexpected: 1 };
	assert.equal(parseOutputControlTelemetry(unknown), undefined);
	const unknownTotals = cloneSnapshot(serialized);
	(unknownTotals.totals as Record<string, unknown>).unexpected = 1;
	assert.equal(parseOutputControlTelemetry(unknownTotals), undefined);
	const unknownTool = cloneSnapshot(serialized);
	((unknownTool.perTool as Array<Record<string, unknown>>)[0]!).unexpected = 1;
	assert.equal(parseOutputControlTelemetry(unknownTool), undefined);
	const arrayProperty = cloneSnapshot(serialized);
	(arrayProperty.perTool as unknown[] & { secret?: number }).secret = 1;
	assert.equal(parseOutputControlTelemetry(arrayProperty), undefined);
});

test("malformed, non-finite, overflow, proxy and accessor inputs fail closed without traps", () => {
	const telemetry = createOutputControlTelemetry("worker");
	let proxyTraps = 0;
	const proxy = new Proxy(envelope(), {
		get() { proxyTraps += 1; throw new Error("must not run"); },
		ownKeys() { proxyTraps += 1; throw new Error("must not run"); },
	});
	assert.equal(telemetry.recordEnvelope("read", proxy), false);
	assert.equal(parseOutputControlTelemetry(proxy), undefined);
	assert.equal(proxyTraps, 0);

	let getterCalls = 0;
	const accessor = { ...envelope() };
	Object.defineProperty(accessor, "shownTextBytes", {
		enumerable: true,
		get() { getterCalls += 1; return 1; },
	});
	assert.equal(telemetry.recordEnvelope("read", accessor), false);
	assert.equal(getterCalls, 0);

	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
		assert.equal(telemetry.recordEnvelope("read", envelope({ originalTextBytes: bad })), false);
		assert.equal(telemetry.recordTurn(turn("worker", { reservedBytes: bad })), false);
		assert.equal(telemetry.recordHistory(history({ collapsedResults: bad }), "worker"), false);
	}
	assert.equal(telemetry.recordTurn(turn("commander")), false, "cross-role facts are rejected");
	assert.equal(telemetry.recordHistory(history(), "commander"), false);
	assert.deepEqual(telemetry.snapshot().totals, createOutputControlTelemetry("worker").snapshot().totals);

	const valid = cloneSnapshot(createOutputControlTelemetry("worker").snapshot());
	for (const key of ["maxResultBytes", "hardCapViolations"] as const) {
		const malformed = structuredClone(valid);
		malformed[key] = Number.POSITIVE_INFINITY;
		assert.equal(parseOutputControlTelemetry(malformed), undefined);
	}
	for (const [key, value] of [
		["advisory", "HIGH"],
		["compliance", "VIOLATION"],
		["turnHardCapBytes", 999_999],
	] as const) {
		const forged = structuredClone(valid);
		forged[key] = value;
		assert.equal(parseOutputControlTelemetry(forged), undefined);
	}
});

test("100k hostile-sized events saturate at safe integers and remain serializable", () => {
	const telemetry = createOutputControlTelemetry("worker");
	const huge = envelope({
		truncated: true,
		originalTextBytes: Number.MAX_SAFE_INTEGER,
		shownTextBytes: 0,
		omittedTextBytes: Number.MAX_SAFE_INTEGER,
		reason: "per-tool-cap",
	});
	for (let index = 0; index < 100_000; index += 1) {
		assert.equal(telemetry.recordEnvelope("read", huge), true);
	}
	const snapshot = telemetry.snapshot();
	assert.equal(snapshot.totals.toolResults, 100_000);
	assert.equal(snapshot.totals.truncatedResults, 100_000);
	assert.equal(snapshot.totals.rawTextBytes, Number.MAX_SAFE_INTEGER);
	assert.equal(snapshot.totals.omittedTextBytes, Number.MAX_SAFE_INTEGER);
	assert.ok(Object.values(snapshot.totals).every(Number.isSafeInteger));
	assert.equal(snapshot.advisory, "HIGH");
	assert.deepEqual(parseOutputControlTelemetry(JSON.parse(JSON.stringify(snapshot))), snapshot);
});

test("unknown names and cursor payloads never survive into persisted or rendered telemetry", () => {
	const secret = "TOP-SECRET-ARGS-CURSOR-PATH-123";
	const telemetry = createOutputControlTelemetry("commander");
	assert.equal(telemetry.recordEnvelope(secret, envelope({
		truncated: true,
		reason: "per-tool-cap",
		continuation: new Proxy({ kind: secret, value: secret }, {
			get() { throw new Error("telemetry must not inspect continuation"); },
		}),
	})), true);
	const snapshot = serializeOutputControlTelemetry(telemetry.snapshot());
	const combined = [JSON.stringify(snapshot), renderOutputControlStatusJson(snapshot), renderOutputControlStatusText(snapshot)].join("\n");
	assert.doesNotMatch(combined, /TOP-SECRET|ARGS|CURSOR|PATH-123/);
	assert.deepEqual(snapshot.perTool.map((item) => item.tool), ["other"]);

	const fixedStrings = new Set<string>([
		OUTPUT_CONTROL_TELEMETRY_SCHEMA,
		"commander", "worker", "other", "OK", "SOFT", "HIGH", "COMPLIANT", "VIOLATION",
		...OUTPUT_CONTROL_TOOL_IDS,
	]);
	const inspect = (value: unknown): void => {
		if (typeof value === "string") assert.ok(fixedStrings.has(value), `unexpected persisted string: ${value}`);
		else if (Array.isArray(value)) value.forEach(inspect);
		else if (value && typeof value === "object") Object.values(value).forEach(inspect);
	};
	inspect(snapshot);
});

test("merge adds counters safely, keeps maxima, and treats active history as a latest gauge", () => {
	const left = createOutputControlTelemetry("worker");
	left.recordEnvelope("read", envelope({ originalTextBytes: 10, shownTextBytes: 10 }));
	left.recordTurn(turn("worker", { reservedBytes: 100 }));
	left.recordHistory(history({ finalToolTextBytes: 111 }), "worker");
	const right = createOutputControlTelemetry("worker");
	right.recordEnvelope("read", envelope({ originalTextBytes: 20, shownTextBytes: 20 }));
	right.recordTurn(turn("worker", { reservedBytes: 200 }));
	right.recordHistory(history({ finalToolTextBytes: 222 }), "worker");

	const merged = mergeOutputControlTelemetry(left.snapshot(), right.snapshot());
	assert.ok(merged);
	assert.equal(merged.totals.toolResults, 2);
	assert.equal(merged.totals.rawTextBytes, 30);
	assert.equal(merged.totals.batchReservedBytes, 300);
	assert.equal(merged.maxResultBytes, 20);
	assert.equal(merged.maxBatchReservedBytes, 200);
	assert.equal(merged.activeHistoryToolTextBytes, 222);
	assert.equal(mergeOutputControlTelemetry(left.snapshot(), createOutputControlTelemetry("commander").snapshot()), undefined);

	const accumulator = new OutputControlTelemetryAccumulator("worker");
	assert.equal(accumulator.merge(left.snapshot()), true);
	assert.deepEqual(accumulator.snapshot(), left.snapshot());
});

test("restore chooses the latest cumulative entry and a malformed matching entry resets fail closed", () => {
	const first = createOutputControlTelemetry("worker");
	first.recordEnvelope("read", envelope());
	const second = createOutputControlTelemetry("worker");
	second.recordEnvelope("read", envelope());
	second.recordEnvelope("grep", envelope());
	const entry = (snapshot: OutputControlTelemetrySnapshot): Record<string, unknown> => ({
		type: "custom",
		customType: OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE,
		data: serializeOutputControlTelemetry(snapshot),
	});

	const restored = createOutputControlTelemetry("worker");
	assert.equal(restored.restoreFromEntries([{ type: "custom", customType: "unrelated", data: "secret" }, entry(first.snapshot()), entry(second.snapshot())]), true);
	assert.deepEqual(restored.snapshot(), second.snapshot());
	assert.equal(restored.restoreFromEntries([entry(second.snapshot()), {
		type: "custom",
		customType: OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE,
		data: { bad: "secret" },
	}]), false);
	assert.equal(restored.snapshot().totals.toolResults, 0);
});

test("status text and JSON are deterministic, bounded, and include every fixed per-tool row", () => {
	const telemetry = createOutputControlTelemetry("commander");
	for (const tool of OUTPUT_CONTROL_TOOL_IDS) telemetry.recordEnvelope(tool, envelope());
	telemetry.recordTurn(turn("commander"));
	telemetry.recordHistory(history(), "commander");
	const snapshot = telemetry.snapshot();
	const text = renderOutputControlStatusText(snapshot);
	const json = renderOutputControlStatusJson(snapshot);
	assert.equal(text, renderOutputControlStatusText(snapshot));
	assert.equal(json, renderOutputControlStatusJson(snapshot));
	assert.ok(Buffer.byteLength(text, "utf8") <= OUTPUT_CONTROL_STATUS_MAX_BYTES);
	assert.ok(Buffer.byteLength(json, "utf8") <= OUTPUT_CONTROL_STATUS_MAX_BYTES);
	assert.equal(text.match(/^tool=/gm)?.length, OUTPUT_CONTROL_TOOL_IDS.length);
	assert.deepEqual(parseOutputControlTelemetry(JSON.parse(json)), snapshot);
	assert.match(text, /observation=ONLY/);
	assert.match(text, /compliance=COMPLIANT/);
});
