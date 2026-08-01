/**
 * P4 status + widget tests (P4 spec §1, §2, §6).
 *
 * Status line: WB:<MODE> | <profile> | <gate>:<status> | run:<id>.
 * Widget: shown only while a task is active, a gate is failing, or forced
 * on; never shown without UI (print/json); lines are ASCII, fitted to
 * narrow widths, missing fields skipped.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildStatusLine } from "../extensions/workbench-runtime/core/status.ts";
import {
	buildWidgetLines,
	shouldShowWidget,
	widgetAction,
	type WidgetState,
} from "../extensions/workbench-runtime/core/widget.ts";
import { fitToWidth } from "../extensions/workbench-runtime/core/format.ts";

const BASE: WidgetState = { taskActive: false, gateFailed: false, forced: false };

// ------------------------------------------------------------------- status

test("status line matches the P4 example exactly", () => {
	const line = buildStatusLine({
		mode: "VERIFY",
		profile: "quant-research/stock-selection",
		activeGate: { id: "Q3", status: "FAIL", run_id: "20260801-004" },
		latestRun: { run_id: "20260801-004", status: "OK", ok: true },
	});
	assert.equal(line, "WB:VERIFY | quant-research/stock-selection | Q3:FAIL | run:20260801-004");
});

test("status line shows the latest run status when it is not OK", () => {
	const line = buildStatusLine({
		mode: "DEV",
		activeGate: { id: "b1", status: "PASS" },
		latestRun: { run_id: "20260801-004", status: "FAILED", ok: false },
	});
	assert.equal(line, "WB:DEV | b1:PASS | run:20260801-004:FAILED");
});

test("status line degrades to mode-only when nothing else is known", () => {
	assert.equal(buildStatusLine({ mode: "AUDIT" }), "WB:AUDIT");
});

test("status line skips missing parts", () => {
	const line = buildStatusLine({
		mode: "VERIFY",
		profile: "generic",
		latestRun: { run_id: "20260801-004", status: "TIMED OUT", ok: false },
	});
	assert.equal(line, "WB:VERIFY | generic | run:20260801-004:TIMED OUT");
});

test("status line fits an over-long profile to the footer width", () => {
	const line = buildStatusLine({ mode: "DEV", profile: "quant-research/stock-selection/very-long-profile-name" });
	assert.ok(line.length < 60, `status must stay compact, got: ${line}`);
	assert.ok(line.includes("..."));
	assert.ok(line.startsWith("WB:DEV | "));
});

// ------------------------------------------------------------------- widget

test("widget is hidden when there is no task, no gate failure and no forcing", () => {
	assert.equal(shouldShowWidget(BASE), false);
	assert.equal(widgetAction(BASE, true), "hide");
});

test("widget shows while a task is active", () => {
	const state = { ...BASE, taskActive: true, task: "implement P4" };
	assert.equal(shouldShowWidget(state), true);
	assert.equal(widgetAction(state, true), "show");
});

test("widget shows when the latest gate run is failing", () => {
	const state = { ...BASE, gateFailed: true, activeGate: "Q3 FAIL (run 20260801-004)", blockingReason: "prerequisite q2 is FAIL" };
	assert.equal(shouldShowWidget(state), true);
	assert.equal(widgetAction(state, true), "show");
});

test("widget shows when forced on by the user, even when idle and green", () => {
	const state = { ...BASE, forced: true };
	assert.equal(shouldShowWidget(state), true);
	assert.equal(widgetAction(state, true), "show");
});

test("widget action is a no-op without UI (print/json never touch TUI APIs)", () => {
	const state = { ...BASE, forced: true, taskActive: true, gateFailed: true };
	assert.equal(widgetAction(state, false), "noop");
	assert.equal(widgetAction(BASE, false), "noop");
});

test("widget lines carry the P4 content: task, phase, gate, last run, blocking", () => {
	const state: WidgetState = {
		...BASE,
		task: "implement P4 TUI status",
		phase: "running workbench_run_gate",
		activeGate: "Q3 FAIL (run 20260801-004)",
		lastRun: "run:20260801-004 npm test exit=1 FAILED",
		blockingReason: "prerequisite q2 is FAIL",
	};
	const lines = buildWidgetLines(state);
	assert.deepEqual(lines, [
		"task: implement P4 TUI status",
		"phase: running workbench_run_gate",
		"gate: Q3 FAIL (run 20260801-004)",
		"last run: run:20260801-004 npm test exit=1 FAILED",
		"blocking: prerequisite q2 is FAIL",
	]);
});

test("widget lines skip missing fields and are ASCII-only", () => {
	const lines = buildWidgetLines({ ...BASE, gateFailed: true });
	assert.deepEqual(lines, []);
	const withTask = buildWidgetLines({ ...BASE, taskActive: true, task: "t" });
	assert.deepEqual(withTask, ["task: t"]);
	for (const line of [...lines, ...withTask]) {
		assert.ok(!/[^\x20-\x7E]/.test(line), `widget line must be plain ASCII: ${line}`);
	}
});

test("widget lines fit narrow terminals", () => {
	const state: WidgetState = {
		...BASE,
		task: "this is an extremely long task description that will not fit a narrow terminal",
		phase: "running workbench_run_gate",
	};
	const lines = buildWidgetLines(state, { width: 40 });
	for (const line of lines) {
		assert.ok(Array.from(line).length <= 40, `line too wide: ${line}`);
	}
	assert.ok(lines[0]!.endsWith("..."));
});

test("fitToWidth truncates with an ellipsis and keeps short lines intact", () => {
	assert.equal(fitToWidth("short", 40), "short");
	const fitted = fitToWidth("0123456789", 5);
	assert.equal(fitted, "01...");
	assert.equal(Array.from(fitted).length, 5);
	assert.equal(fitToWidth("x", 1), "x");
	assert.equal(fitToWidth("abcdef", 3), "...");
	assert.equal(fitToWidth("abc", 0), "abc");
});
