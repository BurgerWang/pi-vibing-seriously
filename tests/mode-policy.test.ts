/**
 * Unit tests for the workbench mode policy and state logic.
 * Pure functions only — no Pi runtime required.
 *
 * Run: npm test  (node:test via tsx)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	AUDIT_TOOLS,
	CATASTROPHIC_RULES,
	checkToolCall,
	computeActiveTools,
	DEV_TOOLS,
	findCatastrophicCommand,
	isToolAllowedInMode,
	isToolHardDenied,
	MODE_TOOLS,
	normalizeMode,
	VERIFY_TOOLS,
	WORKBENCH_TOOLS,
} from "../extensions/workbench-runtime/core/mode-policy.ts";
import {
	describeMode,
	loadModeFromEntries,
	MODE_ENTRY_TYPE,
	statusText,
} from "../extensions/workbench-runtime/core/state.ts";

// ---------------------------------------------------------------------------
// Tool sets per mode (P1: VERIFY has no free bash; workbench tools are part
// of every mode's set)
// ---------------------------------------------------------------------------

test("AUDIT tool set is exactly read/grep/find/ls + read-only workbench tools (P3 adds workbench_read_gate/workbench_list_gates; no run tools)", () => {
	assert.deepEqual(AUDIT_TOOLS, [
		"read",
		"grep",
		"find",
		"ls",
		"workbench_project_inspect",
		"workbench_read_run",
		"workbench_read_gate",
		"workbench_list_gates",
		"workbench_compare_runs",
	]);
	for (const tool of AUDIT_TOOLS) {
		assert.ok(isToolAllowedInMode("AUDIT", tool), `AUDIT should allow ${tool}`);
	}
	assert.ok(!isToolAllowedInMode("AUDIT", "bash"));
	assert.ok(!isToolAllowedInMode("AUDIT", "edit"));
	assert.ok(!isToolAllowedInMode("AUDIT", "write"));
	assert.ok(!isToolAllowedInMode("AUDIT", "workbench_run_recipe"));
	assert.ok(!isToolAllowedInMode("AUDIT", "workbench_run_gate"));
	assert.ok(!isToolAllowedInMode("AUDIT", "workbench_delegate_worker"));
});

test("DEV tool set contains all local development tools plus all workbench tools", () => {
	assert.deepEqual(DEV_TOOLS, ["read", "grep", "find", "ls", "bash", "edit", "write", ...WORKBENCH_TOOLS]);
	for (const tool of DEV_TOOLS) {
		assert.ok(isToolAllowedInMode("DEV", tool), `DEV should allow ${tool}`);
	}
});

test("VERIFY tool set has no bash/edit/write/delegation and keeps verification tools", () => {
	const expected = ["read", "grep", "find", "ls", "workbench_project_inspect", "workbench_run_recipe", "workbench_read_run", "workbench_run_gate", "workbench_read_gate", "workbench_list_gates", "workbench_compare_runs"];
	assert.deepEqual(VERIFY_TOOLS, expected);
	for (const tool of expected) {
		assert.ok(isToolAllowedInMode("VERIFY", tool), `VERIFY should allow ${tool}`);
	}
	assert.ok(!isToolAllowedInMode("VERIFY", "bash"));
	assert.ok(!isToolAllowedInMode("VERIFY", "edit"));
	assert.ok(!isToolAllowedInMode("VERIFY", "write"));
	assert.ok(!isToolAllowedInMode("VERIFY", "workbench_delegate_worker"));
});

// ---------------------------------------------------------------------------
// Hard denial (second-layer tool_call guard)
// ---------------------------------------------------------------------------

test("AUDIT hard-denies mutation, gate execution, and worker delegation", () => {
	for (const tool of ["bash", "edit", "write", "workbench_run_recipe", "workbench_run_gate", "workbench_delegate_worker"]) {
		assert.ok(isToolHardDenied("AUDIT", tool), `AUDIT should hard-deny ${tool}`);
		assert.equal(checkToolCall("AUDIT", tool, {}).allowed, false, `${tool} blocked`);
	}
	for (const tool of ["read", "grep", "find", "ls", "workbench_project_inspect", "workbench_read_run", "workbench_read_gate", "workbench_list_gates"]) {
		assert.ok(!isToolHardDenied("AUDIT", tool));
		assert.equal(checkToolCall("AUDIT", tool, {}).allowed, true);
	}
});

test("VERIFY hard-denies bash, edit and write (no free bash in P1)", () => {
	for (const tool of ["edit", "write", "bash"]) {
		assert.ok(isToolHardDenied("VERIFY", tool), `VERIFY should hard-deny ${tool}`);
		assert.equal(checkToolCall("VERIFY", tool, { command: "ls -la" }).allowed, false, `${tool} blocked in VERIFY`);
	}
	assert.equal(checkToolCall("VERIFY", "workbench_run_recipe", {}).allowed, true);
	assert.equal(checkToolCall("VERIFY", "workbench_run_gate", {}).allowed, true);
	assert.equal(checkToolCall("VERIFY", "workbench_project_inspect", {}).allowed, true);
	assert.equal(checkToolCall("VERIFY", "workbench_read_run", {}).allowed, true);
	assert.equal(checkToolCall("VERIFY", "workbench_read_gate", {}).allowed, true);
	assert.equal(checkToolCall("VERIFY", "workbench_list_gates", {}).allowed, true);
	assert.equal(checkToolCall("VERIFY", "workbench_delegate_worker", {}).allowed, false);
});

test("DEV hard-denies nothing", () => {
	for (const tool of ["read", "grep", "find", "ls", "bash", "edit", "write", "workbench_delegate_worker"]) {
		assert.ok(!isToolHardDenied("DEV", tool));
		assert.equal(checkToolCall("DEV", tool, {}).allowed, true, `${tool} allowed in DEV`);
	}
});

test("AUDIT and VERIFY hard-deny workbench_run_recipe/workbench_run_gate / free bash respectively (guard is independent)", () => {
	// Simulate: some other logic re-enabled the tool while in a restricted mode.
	assert.ok(!isToolAllowedInMode("VERIFY", "bash"));
	assert.equal(checkToolCall("VERIFY", "bash", { command: "npm test" }).allowed, false);
	assert.ok(!isToolAllowedInMode("AUDIT", "workbench_run_recipe"));
	assert.equal(checkToolCall("AUDIT", "workbench_run_recipe", {}).allowed, false);
	assert.ok(!isToolAllowedInMode("AUDIT", "workbench_run_gate"));
	assert.equal(checkToolCall("AUDIT", "workbench_run_gate", {}).allowed, false);
	assert.equal(checkToolCall("VERIFY", "edit", {}).allowed, false);
});

// ---------------------------------------------------------------------------
// Catastrophic command guard
// ---------------------------------------------------------------------------

test("catastrophic shell commands are blocked", () => {
	const catastrophic = [
		"rm -rf /",
		"rm -rf /*",
		"rm -fr /",
		"rm -r -f /",
		"sudo rm -rf /",
		"rm -rf / --no-preserve-root",
		"git reset --hard",
		"git reset --hard HEAD~1",
		"git clean -fdx",
		"git clean -fd",
		"git clean -dfx",
		"git push --force",
		"git push -f",
		"git push -f origin main",
		"git push --force-with-lease origin main",
		"echo hi && rm -rf /",
		"rm -rf / ; ls",
	];
	for (const cmd of catastrophic) {
		const rule = findCatastrophicCommand(cmd);
		assert.ok(rule !== undefined, `expected ${cmd} to match a catastrophic rule`);
		assert.equal(checkToolCall("DEV", "bash", { command: cmd }).allowed, false, cmd);
	}
});

test("every catastrophic rule id is descriptive and referenced", () => {
	const ids = CATASTROPHIC_RULES.map((r) => r.id);
	assert.ok(ids.includes("rm-rf-root"));
	assert.ok(ids.includes("git-reset-hard"));
	assert.ok(ids.includes("git-clean-fd"));
	assert.ok(ids.includes("git-push-force"));
});

test("safe shell commands are not blocked", () => {
	const safe = [
		"ls -la",
		"cat package.json",
		"git status",
		"git diff",
		"git log --oneline -5",
		"git fetch --all",
		"git push origin main",
		"git pull",
		"git clean -n",
		"git clean -nd",
		"rm file.txt",
		"rm -r ./build",
		"rm -rf ./node_modules",
		"npm test",
		"npm run typecheck",
		"node --version",
		"echo hello",
		"mkdir -p dist",
	];
	for (const cmd of safe) {
		const rule = findCatastrophicCommand(cmd);
		assert.equal(rule, undefined, `expected ${cmd} to be safe (got ${rule})`);
		assert.equal(checkToolCall("DEV", "bash", { command: cmd }).allowed, true, cmd);
	}
});

test("catastrophic guard applies in every mode including DEV", () => {
	for (const mode of ["AUDIT", "DEV", "VERIFY"] as const) {
		const check = checkToolCall(mode, "bash", { command: "rm -rf /" });
		assert.equal(check.allowed, false, `${mode} should block rm -rf /`);
	}
});

test("non-string bash input is not treated as a command", () => {
	assert.equal(checkToolCall("DEV", "bash", { command: 42 }).allowed, true);
	assert.equal(checkToolCall("DEV", "bash", undefined).allowed, true);
});

// ---------------------------------------------------------------------------
// normalizeMode fallback
// ---------------------------------------------------------------------------

test("invalid or missing mode values fall back to DEV", () => {
	assert.equal(normalizeMode("DEV"), "DEV");
	assert.equal(normalizeMode("AUDIT"), "AUDIT");
	assert.equal(normalizeMode("VERIFY"), "VERIFY");
	assert.equal(normalizeMode(undefined), "DEV");
	assert.equal(normalizeMode(null), "DEV");
	assert.equal(normalizeMode(""), "DEV");
	assert.equal(normalizeMode("HFT"), "DEV");
	assert.equal(normalizeMode("audit"), "DEV");
	assert.equal(normalizeMode(42), "DEV");
});

// ---------------------------------------------------------------------------
// computeActiveTools
// ---------------------------------------------------------------------------

test("DEV keeps non-managed custom tools from other extensions", () => {
	const active = computeActiveTools("DEV", ["read", "bash", "workbench_gate_check", "other_ext_tool"]);
	assert.ok(active.includes("edit"));
	assert.ok(active.includes("workbench_run_recipe"), "workbench tools come from the DEV tool set");
	assert.ok(active.includes("workbench_gate_check"));
	assert.ok(active.includes("other_ext_tool"));
	assert.deepEqual(
		new Set(active),
		new Set(DEV_TOOLS.concat(["workbench_gate_check", "other_ext_tool"])),
	);
});

test("AUDIT and VERIFY tool sets are strict — only their declared tools are kept", () => {
	const active = ["read", "bash", "workbench_run_recipe", "workbench_gate_check"];
	assert.deepEqual(computeActiveTools("AUDIT", active), ["read", "grep", "find", "ls", "workbench_project_inspect", "workbench_read_run", "workbench_read_gate", "workbench_list_gates", "workbench_compare_runs"]);
	assert.deepEqual(computeActiveTools("VERIFY", active), ["read", "grep", "find", "ls", "workbench_project_inspect", "workbench_run_recipe", "workbench_read_run", "workbench_run_gate", "workbench_read_gate", "workbench_list_gates", "workbench_compare_runs"]);
	assert.ok(!computeActiveTools("VERIFY", active).includes("workbench_delegate_worker"));
});

test("mode tool sets are deduplicated", () => {
	const active = computeActiveTools("DEV", ["read", "read", "bash"]);
	assert.equal(active.filter((t) => t === "read").length, 1);
});

// ---------------------------------------------------------------------------
// Session-entry persistence logic
// ---------------------------------------------------------------------------

function entry(mode?: unknown): { type: string; customType?: string; data?: unknown } {
	return { type: "custom", customType: MODE_ENTRY_TYPE, data: { mode } };
}

test("no saved state falls back to DEV", () => {
	assert.equal(loadModeFromEntries([]), "DEV");
	assert.equal(loadModeFromEntries([{ type: "message" }]), "DEV");
	assert.equal(loadModeFromEntries([{ type: "custom", customType: "other-ext", data: { mode: "AUDIT" } }]), "DEV");
});

test("restores the last persisted mode from session entries", () => {
	const entries = [entry("DEV"), entry("AUDIT"), entry("VERIFY")];
	assert.equal(loadModeFromEntries(entries), "VERIFY");
});

test("invalid persisted mode falls back to DEV", () => {
	assert.equal(loadModeFromEntries([entry("AUDIT"), entry("MARKET_MAKING")]), "DEV");
	assert.equal(loadModeFromEntries([entry("AUDIT"), entry(undefined)]), "DEV");
	assert.equal(loadModeFromEntries([entry("AUDIT"), entry(null)]), "DEV");
});

test("statusText and describeMode cover all modes", () => {
	assert.equal(statusText("AUDIT"), "WB:AUDIT");
	assert.equal(statusText("DEV"), "WB:DEV");
	assert.equal(statusText("VERIFY"), "WB:VERIFY");
	for (const mode of ["AUDIT", "DEV", "VERIFY"] as const) {
		assert.ok(describeMode(mode).length > 10);
	}
	assert.ok(describeMode("VERIFY").toLowerCase().includes("recipe"));
	assert.ok(describeMode("VERIFY").toLowerCase().includes("no free bash"));
});

// ---------------------------------------------------------------------------
// MODE_TOOLS consistency
// ---------------------------------------------------------------------------

test("MODE_TOOLS maps every mode to its declared tool set", () => {
	assert.deepEqual(MODE_TOOLS.AUDIT, AUDIT_TOOLS);
	assert.deepEqual(MODE_TOOLS.DEV, DEV_TOOLS);
	assert.deepEqual(MODE_TOOLS.VERIFY, VERIFY_TOOLS);
});
