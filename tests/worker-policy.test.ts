import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { WORKBENCH_TOOL_METADATA, WORKBENCH_TOOL_PARAMETERS } from "../extensions/workbench-runtime/core/tool-catalog.ts";
import { STRICT_SOL_DEV_ALLOWLIST } from "../extensions/workbench-runtime/core/write-authority.ts";
import {
	commanderBlockReason,
	computeRoleActiveTools,
	formatWorkerTask,
	isWorkerPathAllowed,
	parseWorkerAllowedPaths,
	parseWorkerTaskKindEnvironment,
	parseWorkerTimeoutMsEnvironment,
	recipeMutationBlockReason,
	resolveWorkerBudgetProfile,
	resolveWorkerRepairOf,
	resolveWorkerTaskKind,
	workerRecipeBlockReason,
	workerRoleToolCallBlockReason,
	WORKER_MODEL_ID,
	WORKER_MODEL_SELECTOR,
	WORKER_PROVIDER,
	WORKER_ROLE,
	WORKER_THINKING_LEVEL,
	type WorkerTaskContract,
} from "../extensions/workbench-runtime/core/worker-policy.ts";
import { isWorkerPathAllowedRealpath } from "../extensions/workbench-runtime/worker/path-scope.ts";
import { WORKER_REPAIR_CAPSULE_SCHEMA, type WorkerRepairCapsule } from "../extensions/workbench-runtime/core/worker-repair-capsule.ts";
import { withTempDir } from "./helpers.ts";

test("only GPT-5.6 Sol on an approved provider may command the worker", () => {
	assert.equal(commanderBlockReason("openai-codex", "gpt-5.6-sol"), undefined);
	assert.equal(commanderBlockReason("openai", "gpt-5.6-sol"), undefined);
	assert.match(commanderBlockReason("deepseek", "deepseek-v4-flash") ?? "", /requires commander/);
	assert.match(commanderBlockReason("openai-codex", "gpt-5.6-terra") ?? "", /active model/);
	assert.match(commanderBlockReason(undefined, undefined) ?? "", /\(none\)/);
});

test("worker identity is pinned to GPT-5.6 Luna at xhigh reasoning", () => {
	assert.equal(WORKER_PROVIDER, "openai-codex");
	assert.equal(WORKER_MODEL_ID, "gpt-5.6-luna");
	assert.equal(WORKER_THINKING_LEVEL, "xhigh");
	assert.equal(WORKER_MODEL_SELECTOR, "openai-codex/gpt-5.6-luna:xhigh");
});

test("worker timeout env parsing is strict and advisory-only", () => {
	assert.equal(parseWorkerTimeoutMsEnvironment("3600000"), 3_600_000);
	assert.equal(parseWorkerTimeoutMsEnvironment(undefined), undefined);
	assert.equal(parseWorkerTimeoutMsEnvironment("0"), undefined);
	assert.equal(parseWorkerTimeoutMsEnvironment(" 3600000"), undefined);
	assert.equal(parseWorkerTimeoutMsEnvironment("86400001"), undefined);
});

test("active worker runtime is DeepSeek-free and formal stress isolates only the explicit legacy-v1 fixture", async () => {
	const root = join(import.meta.dirname, "..");
	const activeRuntime = [
		"extensions/workbench-runtime/core/worker-policy.ts",
		"extensions/workbench-runtime/core/delegation-execution-v2.ts",
		"extensions/workbench-runtime/core/delegate-tool-controller.ts",
		"extensions/workbench-runtime/worker/runner.ts",
		"extensions/workbench-runtime/index.ts",
	];
	for (const path of activeRuntime) {
		const source = await readFile(join(root, path), "utf8");
		assert.doesNotMatch(source, /deepseek|deepseek-v4|runDeepseekWorker/i, `${path} must use only the current pinned-worker identity`);
	}
	const currentDelegateMetadata = [
		WORKBENCH_TOOL_METADATA.workbench_delegate_worker.description,
		WORKBENCH_TOOL_METADATA.workbench_delegate_worker.promptSnippet,
		...WORKBENCH_TOOL_METADATA.workbench_delegate_worker.promptGuidelines,
	].join("\n");
	assert.doesNotMatch(currentDelegateMetadata, /deepseek|deepseek-v4/i);
	assert.match(currentDelegateMetadata, /GPT-5\.6 Luna xhigh/);

	const evidenceSource = await readFile(join(root, "scripts/context-output-evidence.ts"), "utf8");
	assert.doesNotMatch(evidenceSource, /runDeepseekWorker/i);
	const legacyMatches = evidenceSource.match(/deepseek(?:-v4-flash)?/gi) ?? [];
	assert.deepEqual(legacyMatches.map((value) => value.toLowerCase()), ["deepseek", "deepseek-v4-flash"]);
	assert.match(evidenceSource, /const LEGACY_V1_WORKER_PROVIDER = "deepseek"/);
	assert.match(evidenceSource, /registerProvider\(\$\{JSON\.stringify\(WORKER_PROVIDER\)\}/);
});

test("worker allowed-path rules support exact files and explicit subtrees", () => {
	const root = "/repo";
	assert.equal(isWorkerPathAllowed(root, "README.md", ["README.md"]), true);
	assert.equal(isWorkerPathAllowed(root, "README.md/child", ["README.md"]), false);
	assert.equal(isWorkerPathAllowed(root, "src/main.ts", ["src/**"]), true);
	assert.equal(isWorkerPathAllowed(root, "src/nested/test.ts", ["src/"]), true);
	assert.equal(isWorkerPathAllowed(root, "tests/a.ts", ["src/**"]), false);
	assert.equal(isWorkerPathAllowed(root, "../outside", ["/**"]), false);
	assert.equal(isWorkerPathAllowed(root, "/etc/passwd", ["/**"]), false);
	assert.equal(isWorkerPathAllowed(root, "/repo/src/main.ts", ["src/**"]), false, "absolute paths are refused even inside root");
	assert.equal(isWorkerPathAllowed(root, "src/main.ts", ["/repo/src/**"]), false, "absolute rules are refused");
	assert.equal(isWorkerPathAllowed(root, "src/main.ts", ["../**"]), false);
});

test("worker realpath scope blocks symlink escapes and symlink hops outside the approved subtree", async () => {
	await withTempDir(async (root) => {
		const src = join(root, "src");
		const other = join(root, "other");
		await mkdir(src);
		await mkdir(other);
		await writeFile(join(other, "inside-project.ts"), "x", "utf8");
		const outside = await mkdtemp(join(root, "..", "worker-outside-"));
		try {
			await writeFile(join(outside, "escaped.ts"), "x", "utf8");
			await symlink(outside, join(src, "outside-link"));
			await symlink(other, join(src, "other-link"));
			assert.equal(await isWorkerPathAllowedRealpath(root, "src/new.ts", ["src/**"]), true);
			assert.equal(await isWorkerPathAllowedRealpath(root, "src/outside-link/escaped.ts", ["src/**"]), false);
			assert.equal(await isWorkerPathAllowedRealpath(root, "src/other-link/inside-project.ts", ["src/**"]), false);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

test("worker role uses a stable reduced tool matrix while commander tools are unchanged", () => {
	const tools = ["read", "bash", "edit", "workbench_run_recipe", "workbench_run_gate", "workbench_delegate_worker"];
	assert.deepEqual(computeRoleActiveTools(tools, WORKER_ROLE), ["read", "edit", "workbench_run_recipe"]);
	assert.deepEqual(computeRoleActiveTools(tools, undefined), tools);
});

test("task-kind parsing is closed, omission-compatible, and malformed env is least privilege", () => {
	assert.deepEqual(resolveWorkerTaskKind(undefined), { ok: true, taskKind: "implementation" });
	assert.deepEqual(resolveWorkerTaskKind("implementation"), { ok: true, taskKind: "implementation" });
	assert.deepEqual(resolveWorkerTaskKind("diagnosis"), { ok: true, taskKind: "diagnosis" });
	for (const bad of ["mechanical", "", "Diagnosis", null, 1, {}, []]) {
		const resolved = resolveWorkerTaskKind(bad);
		assert.equal(resolved.ok, false, `${JSON.stringify(bad)} must fail closed`);
	}
	assert.equal(parseWorkerTaskKindEnvironment(undefined), "implementation");
	assert.equal(parseWorkerTaskKindEnvironment("diagnosis"), "diagnosis");
	assert.equal(parseWorkerTaskKindEnvironment("mechanical"), "invalid");
});

test("diagnosis and invalid workers have a read-only advertised matrix", () => {
	const tools = ["read", "grep", "edit", "write", "workbench_run_recipe", "workbench_delegate_worker"];
	assert.deepEqual(computeRoleActiveTools(tools, WORKER_ROLE, "implementation"), ["read", "grep", "edit", "write", "workbench_run_recipe"]);
	assert.deepEqual(computeRoleActiveTools(tools, WORKER_ROLE, "diagnosis"), ["read", "grep", "workbench_run_recipe"]);
	assert.deepEqual(computeRoleActiveTools(tools, WORKER_ROLE, "invalid"), ["read", "grep", "workbench_run_recipe"]);
	assert.deepEqual(computeRoleActiveTools(tools, undefined, "diagnosis"), tools, "commander tools are unaffected");
});

test("worker-role filtering still hides recursion/final-gate tools from the strict Sol DEV allowlist (P7)", () => {
	const workerTools = computeRoleActiveTools(STRICT_SOL_DEV_ALLOWLIST, WORKER_ROLE);
	assert.ok(!workerTools.includes("workbench_delegate_worker"), "workers can never recursively delegate");
	assert.ok(!workerTools.includes("workbench_run_gate"), "workers can never run final gates");
	assert.ok(!workerTools.includes("workbench_commit_reviewed"), "workers can never create reviewed commits");
	assert.ok(workerTools.includes("read"));
	assert.ok(workerTools.includes("workbench_run_recipe"));
});

test("worker role blocks recursion, free bash, final gates, and out-of-scope writes", () => {
	const context = { role: WORKER_ROLE, projectRoot: "/repo", allowedPaths: ["src/**", "tests/new.test.ts"] };
	assert.match(workerRoleToolCallBlockReason(context, "workbench_delegate_worker", {}) ?? "", /recursively/);
	assert.match(workerRoleToolCallBlockReason(context, "bash", { command: "npm test" }) ?? "", /declared workbench recipes/);
	assert.match(workerRoleToolCallBlockReason(context, "workbench_run_gate", {}) ?? "", /Sol commander/);
	assert.match(workerRoleToolCallBlockReason(context, "workbench_commit_reviewed", {}) ?? "", /Sol commander/);
	assert.equal(workerRoleToolCallBlockReason(context, "edit", { path: "src/main.ts" }), undefined);
	assert.equal(workerRoleToolCallBlockReason(context, "write", { path: "tests/new.test.ts" }), undefined);
	assert.match(workerRoleToolCallBlockReason(context, "edit", { path: "README.md" }) ?? "", /outside the parent-approved scope/);
	assert.match(workerRoleToolCallBlockReason(context, "write", {}) ?? "", /non-empty path/);
	assert.equal(workerRoleToolCallBlockReason(context, "workbench_run_recipe", { recipe: "unit-test" }), undefined);
	assert.equal(workerRoleToolCallBlockReason({ role: undefined }, "bash", {}), undefined, "commander process is unaffected");
});

test("diagnosis and malformed task kinds block edit/write before path evaluation", () => {
	for (const taskKind of ["diagnosis", "invalid"] as const) {
		const context = { role: WORKER_ROLE, taskKind, projectRoot: "/repo", allowedPaths: ["src/**"] };
		assert.match(workerRoleToolCallBlockReason(context, "edit", { path: "src/main.ts" }) ?? "", /read-only|invalid task-kind/);
		assert.match(workerRoleToolCallBlockReason(context, "write", { path: "src/new.ts" }) ?? "", /read-only|invalid task-kind/);
		assert.equal(workerRoleToolCallBlockReason(context, "read", { path: "src/main.ts" }), undefined);
	}
});

test("worker recipes are read-only by declaration", () => {
	assert.equal(workerRecipeBlockReason(WORKER_ROLE, "unit-test", []), undefined);
	assert.match(workerRecipeBlockReason(WORKER_ROLE, "format", ["src/"]) ?? "", /declares writes: src\//);
	assert.equal(workerRecipeBlockReason(undefined, "format", ["src/"]), undefined, "commander recipes are unchanged");
});

// ---------------------------------------------------------------------------
// P7 slice 3: shared recipe mutation policy (direct execution + gate checks)
// ---------------------------------------------------------------------------

test("strict Sol runs only mutation none/artifacts recipes; mutation source is denied", () => {
	const sol = { role: undefined, provider: "openai-codex", model: "gpt-5.6-sol" };
	assert.equal(recipeMutationBlockReason(sol, "unit-test", "none"), undefined);
	assert.equal(recipeMutationBlockReason(sol, "build", "artifacts"), undefined);
	assert.match(recipeMutationBlockReason(sol, "format", "source") ?? "", /Worker-first write authority denies recipe "format"/);
	assert.match(recipeMutationBlockReason(sol, "format", "source") ?? "", /mutation: source/);
	assert.match(recipeMutationBlockReason(sol, "format", "source") ?? "", /workbench_delegate_worker/);
});

test("delegated workers run only mutation none recipes", () => {
	const worker = { role: WORKER_ROLE, provider: WORKER_PROVIDER, model: WORKER_MODEL_ID };
	assert.equal(recipeMutationBlockReason(worker, "unit-test", "none"), undefined);
	assert.match(recipeMutationBlockReason(worker, "build", "artifacts") ?? "", /workers run only mutation: none/);
	assert.match(recipeMutationBlockReason(worker, "format", "source") ?? "", /workers run only mutation: none/);
});

test("other controllers and fact-less callers retain prior behavior", () => {
	const other = { role: undefined, provider: "anthropic", model: "claude-sonnet" };
	assert.equal(recipeMutationBlockReason(other, "format", "source"), undefined);
	assert.equal(recipeMutationBlockReason(other, "build", "artifacts"), undefined);
	assert.equal(recipeMutationBlockReason(undefined, "format", "source"), undefined);
	assert.equal(recipeMutationBlockReason({}, "format", "source"), undefined);
});

test("the worker env contract wins over Sol-looking model facts for the mutation decision", () => {
	const impersonating = { role: WORKER_ROLE, provider: "openai-codex", model: "gpt-5.6-sol" };
	assert.equal(recipeMutationBlockReason(impersonating, "unit-test", "none"), undefined);
	assert.match(recipeMutationBlockReason(impersonating, "build", "artifacts") ?? "", /workers run only mutation: none/);
	assert.match(recipeMutationBlockReason(impersonating, "fmt", "source") ?? "", /workers run only mutation: none/);
});

test("missing or malformed worker path contracts fail closed", () => {
	assert.deepEqual(parseWorkerAllowedPaths(undefined), []);
	assert.deepEqual(parseWorkerAllowedPaths("not json"), []);
	assert.deepEqual(parseWorkerAllowedPaths("{}"), []);
	assert.deepEqual(parseWorkerAllowedPaths('["src/**", 1, "", " README.md "]'), ["src/**", "README.md"]);
	assert.match(
		workerRoleToolCallBlockReason({ role: WORKER_ROLE, projectRoot: "/repo", allowedPaths: [] }, "edit", { path: "src/a.ts" }) ?? "",
		/no valid parent-approved path contract/,
	);
});

test("formatted worker task carries the complete bounded contract in the user message", () => {
	const contract: WorkerTaskContract = {
		task: "Implement the parser",
		allowedPaths: ["src/**", "tests/parser.test.ts"],
		acceptanceCriteria: ["Reject invalid input", "Keep valid input compatible"],
		verification: ["Run unit-test recipe"],
	};
	const text = formatWorkerTask(contract);
	assert.match(text, /Delegated implementation task:/);
	assert.match(text, /- src\/\*\*/);
	assert.match(text, /- Reject invalid input/);
	assert.match(text, /Requested write-free recipe verification:/);
	assert.ok(!text.includes("final PASS"));
});

test("formatted diagnosis task makes inspection-only authority explicit", () => {
	const text = formatWorkerTask({
		taskKind: "diagnosis",
		task: "Identify the parser failure cause",
		allowedPaths: ["src/**", "tests/parser.test.ts"],
		acceptanceCriteria: ["Report evidence and uncertainty"],
		verification: ["Run the read-only unit-test recipe"],
	});
	assert.match(text, /Delegated diagnosis task \(strictly read-only\)/);
	assert.match(text, /inspection scope only; never write authority/);
	assert.match(text, /Diagnostic objectives \(evidence for Sol; never acceptance\)/);
	assert.throws(
		() => formatWorkerTask({
			taskKind: "mechanical" as never,
			task: "bad",
			allowedPaths: ["src/**"],
			acceptanceCriteria: ["bad"],
			verification: [],
		}),
		/task_kind must be one of/,
	);
});

// ---------------------------------------------------------------------------
// Phase 3: budget-profile contract validation (worker token-budget repair)
// ---------------------------------------------------------------------------

test("budget-profile validation resolves omitted to extended and accepts both active profiles", () => {
	assert.deepEqual(resolveWorkerBudgetProfile(undefined), { ok: true, profile: "extended" });
	assert.deepEqual(resolveWorkerBudgetProfile("standard"), { ok: true, profile: "standard" });
	assert.deepEqual(resolveWorkerBudgetProfile("extended"), { ok: true, profile: "extended" });
	const retired = resolveWorkerBudgetProfile("low");
	assert.equal(retired.ok, false, "retired low fails closed at the public contract boundary");
	if (!retired.ok) assert.match(retired.error, /"standard" \| "extended"/);
});

test("budget-profile validation fails closed on unknown, empty, wrong types and case variants", () => {
	// Unknown/empty/case-variant strings fail closed with the bounded error.
	for (const bad of ["", "low", "LOW", "Standard", "EXTENDED", "ultra", " low", "standard ", "low\n", "low\u0000"]) {
		const r = resolveWorkerBudgetProfile(bad);
		assert.equal(r.ok, false, `string ${JSON.stringify(bad)} must fail closed`);
		if (!r.ok) assert.match(r.error, /budget_profile must be one of "standard" \| "extended"/);
	}
	// Wrong types fail closed: null, numbers, booleans, objects, arrays.
	for (const bad of [null, 0, 1, 3.5, true, false, {}, { profile: "low" }, [], ["low"]]) {
		const r = resolveWorkerBudgetProfile(bad);
		assert.equal(r.ok, false, `${JSON.stringify(bad)} must fail closed`);
		if (!r.ok) assert.match(r.error, /budget_profile must be one of "standard" \| "extended"/);
	}
	// The error stays bounded even for pathological values (never the full
	// value embedded, never an unbounded message).
	const r = resolveWorkerBudgetProfile("x".repeat(10_000));
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.ok(r.error.length < 200, "error message stays bounded");
		assert.ok(!r.error.includes("x".repeat(10_000)), "never the full pathological value");
	}
});

test("formatted worker task names the resolved spend profile deterministically (Phase 5)", () => {
	const base: WorkerTaskContract = {
		task: "Implement the parser",
		allowedPaths: ["src/**"],
		acceptanceCriteria: ["Unit tests cover the new option"],
		verification: [],
	};
	// Omitted and retired input resolve deterministically to the safe extended default.
	const extendedText = formatWorkerTask(base);
	assert.match(extendedText, /Worker spend-budget profile: extended/);
	assert.match(formatWorkerTask({ ...base, budgetProfile: "low" }), /Worker spend-budget profile: extended/);
	// Both active profiles remain explicit, including the smaller standard slice.
	const standardText = formatWorkerTask({ ...base, budgetProfile: "standard" });
	assert.match(standardText, /Worker spend-budget profile: standard/);
	const explicitExtendedText = formatWorkerTask({ ...base, budgetProfile: "extended" });
	assert.match(explicitExtendedText, /Worker spend-budget profile: extended/);
	// The profile line states the profile bounds spend only — it never
	// expands the parent-approved path/scope authority (informational
	// wording; the runner/child env contract enforces the profile and
	// thresholds are unchanged).
	for (const text of [standardText, extendedText, explicitExtendedText]) {
		assert.match(text, /bounds cumulative spend only/);
		assert.match(text, /never expands parent-approved path\/scope authority/);
	}
	// The rest of the contract still travels unchanged.
	assert.match(standardText, /- src\/\*\*/);
	assert.match(standardText, /- Unit tests cover the new option/);
});

test("the complete-slice task contract travels fully and stays acceptance-free", () => {
	const contract: WorkerTaskContract = {
		task: "Implement the parser slice with tests and docs",
		allowedPaths: ["src/parser/**", "tests/parser.test.ts", "docs/parser.md"],
		acceptanceCriteria: ["Unit tests cover the new option", "Docs describe the new option"],
		verification: ["recipe:unit-test", "recipe:docs-check"],
	};
	const text = formatWorkerTask(contract);
	// Source, tests, and docs paths plus observable criteria and requested
	// verification all travel in the worker user message.
	for (const path of contract.allowedPaths) assert.ok(text.includes(path), `allowed path missing: ${path}`);
	for (const criterion of contract.acceptanceCriteria) assert.ok(text.includes(criterion), `criterion missing: ${criterion}`);
	for (const step of contract.verification) assert.ok(text.includes(step), `verification step missing: ${step}`);
	// The contract is what the worker implements; acceptance stays with Sol.
	assert.ok(!text.includes("acceptance evidence"), "the task text never claims acceptance evidence");
	assert.ok(!text.includes("final PASS"), "the task text never grants a final verdict");
});

test("delegate-tool metadata is concise while retaining the hard authority boundaries", () => {
	const meta = WORKBENCH_TOOL_METADATA.workbench_delegate_worker;
	const text = [meta.description, meta.promptSnippet, ...meta.promptGuidelines].join("\n");
	assert.ok(Buffer.byteLength(text, "utf8") < 2_500, "static delegate metadata stays context-efficient");
	assert.match(text, /GPT-5\.6 Luna xhigh/);
	assert.match(text, /Implementation may write only approved paths/);
	assert.match(text, /diagnosis is strictly read-only/);
	assert.match(text, /fresh no-session process/);
	assert.match(text, /cannot delegate, use free-form bash, or run final Gates/);
	assert.match(text, /ambiguous authority fails closed/);
	assert.match(text, /Sol retains architecture, semantic review, final verification, Gates and verdict authority/);
});

test("delegate-tool metadata exposes canonical recipe, size and repair contracts", () => {
	const meta = WORKBENCH_TOOL_METADATA.workbench_delegate_worker;
	const text = [meta.description, meta.promptSnippet, ...meta.promptGuidelines].join("\n");
	const schema = WORKBENCH_TOOL_PARAMETERS.workbench_delegate_worker as unknown as {
		properties: Record<string, { description?: string; items?: { pattern?: string } }>;
	};
	assert.match(text, /recipe:<declared-name>/);
	assert.match(text, /12 KiB/);
	assert.match(text, /64 KiB/);
	assert.match(text, /PENDING_REVIEW implementation with an immutable Sol REPAIR decision/);
	assert.match(text, /not the old session or report/);
	assert.match(schema.properties.verification?.description ?? "", /mutation:none/);
	assert.equal(schema.properties.verification?.items?.pattern, "^recipe:[^\\r\\n\\u0000-\\u001f\\u007f]{1,200}$");
	assert.match(schema.properties.extended_reason?.description ?? "", /12 KiB ordinary soft limit/);
	assert.match(schema.properties.repair_of?.description ?? "", /PENDING_REVIEW implementation/);
	assert.match(schema.properties.repair_of?.description ?? "", /semantic REPAIR decision/);
	assert.match(schema.properties.repair_of?.description ?? "", /never the old session or Gate authority/);
});

test("worker-delegation documentation defines fixed Sol/Luna boundaries and strict public v2 delegation authority", async () => {
	const doc = await readFile(new URL("../docs/worker-delegation.md", import.meta.url), "utf8");
	// Risk rubric with low/medium/high tiers.
	assert.match(doc, /## Risk rubric/);
	assert.match(doc, /\| Low \|/);
	assert.match(doc, /\| Medium \|/);
	assert.match(doc, /\| High \|/);
	// Routine implementation is worker-owned; the lease is an explicit Sol
	// direct-write exception rather than the normal path.
	assert.match(doc, /Low \| One contained change with a clear contract \| One bounded Luna implementation plus focused tests/);
	assert.match(doc, /One coherent bounded Luna implementation/);
	assert.match(doc, /Ordinary work does not become high risk merely because it changes source/);
	assert.match(doc, /A partial result is repaired through one new\s+bounded Luna call only when recovery is actually needed/);
	assert.match(doc, /High-risk\s+classification must name the concrete permission/);
	// Caller/worker responsibilities are spelled out.
	assert.match(doc, /### Responsibility split/);
	assert.match(doc, /\| Owned by Sol \| Owned by Luna \(inside the approved contract\) \|/);
	// Bounded continuation and one writing worker per worktree.
	assert.match(doc, /## Bounded worker continuation/);
	assert.match(doc, /brand-new `--no-session` worker and cannot recurse/);
	assert.match(doc, /not a mandatory ceremony after\s+a complete delivery/);
	assert.match(doc, /## One writing worker per worktree/);
	assert.match(doc, /at most one worker writes to a worktree at any time/);
	// Current worker-first write authority and the single public v2 transaction.
	assert.match(doc, /## Fixed Sol -> Luna write authority \(current; legacy id P7\)/);
	assert.match(doc, /fixed 16-tool\s+read\/control\/delegation\/local-commit surface/);
	assert.match(doc, /`workbench_commit_reviewed`/);
	assert.match(doc, /never pushes, amends, resets, cleans, stashes, switches branches/);
	assert.match(doc, /routine source,\s+test, and documentation edits are delegated to Luna/);
	assert.match(doc, /Any direct Sol `edit`\/`write` requires a \*\*temporary write lease exception\*\*/);
	assert.match(doc, /`WF:LOCKED` otherwise/);
	assert.match(doc, /## Recommended development workflow/);
	assert.match(doc, /Give Luna one bounded contract for the coherent source, test, and\s+documentation slice/);
	assert.match(doc, /Inspect the provisional scope\/integrity packet returned with every non-zero\s+implementation/);
	assert.match(doc, /explicitly\s+ACCEPT the unchanged packet hash/);
	assert.match(doc, /If the complete unchanged packet is wrong,\s+publish hash-bound REPAIR and follow only the exact `repair_of` action shown\s+by status; `repair_of` cannot replace that negative semantic decision/);
	assert.match(doc, /run one final recipe or\s+gate set proportionate to task or release risk/);
	assert.match(doc, /## Delegation transaction and review lifecycle \(P7\)/);
	assert.match(doc, /\.pi\/workbench\/delegations\/<id>\/v2\/transaction\.json/);
	assert.match(doc, /`PREPARED`[\s\S]*BEFORE the child is[\s\S]*`RUNNING`/);
	assert.match(doc, /`COMMITTING`/);
	assert.match(doc, /\.pi\/workbench\/delegations\/<id>\/v2\/generations\/g########\//);
	assert.match(doc, /exactly eight records/);
	for (const record of [
		"after.json",
		"before.json",
		"identity.json",
		"review.json",
		"scope.json",
		"usage.json",
		"worker-report.md",
		"worker-summary.json",
	]) {
		assert.ok(doc.includes("`" + record + "`"), `missing documented v2 generation record ${record}`);
	}
	assert.match(doc, /plus `commit-marker\.json`/);
	assert.match(doc, /full-byte content-hash\/marker proof/);
	assert.match(doc, /implementation: PREPARED → RUNNING → COMMITTING → PENDING_REVIEW → REVIEWED/);
	assert.match(doc, /diagnosis:\s+PREPARED → RUNNING → COMMITTING → FINISHED/);
	// Stage-1 task-kind compatibility and the task-specific postconditions are
	// explicit; superficial child success or prose cannot bypass them.
	assert.match(doc, /omission preserves compatibility by resolving to\s+`implementation`/);
	assert.match(doc, /Stage 1 enables only `implementation` and `diagnosis`/);
	assert.match(doc, /`mechanical` \(or any unknown value\) fails closed/);
	assert.match(doc, /implementation can reach `PENDING_REVIEW` only with a nonempty actual\s+delta, complete scope facts with no out-of-scope changes/);
	assert.match(doc, /diagnosis can reach\s+`FINISHED` only with zero actual delta, zero successful\s+write attempts, zero denied write attempts, and a complete report/);
	assert.match(doc, /Both\s+successful paths also require provider success, exit code 0, a complete\s+report, complete terminal facts, and the exact pinned\/observed worker\s+identity/);
	assert.match(doc, /Provider success, exit code 0, or reassuring worker prose cannot\s+bypass any other postcondition/);
	assert.match(doc, /failure\s+becomes `FAILED`; incomplete terminal or generation facts become\s+`RECOVERY_REQUIRED`/);
	assert.match(doc, /`v2\/execution-owner\.json` while the owning Pi process is executing/);
	assert.match(doc, /transaction timestamp plus both transaction and journal file mtimes to predate\s+the current OS boot/);
	assert.match(doc, /any write evidence,\s+`COMMITTING`, corrupt data, or ambiguous inventory remains blocking/);
	// V2 review authority separates mechanical presentation from explicit
	// hash-bound Sol acceptance and rebuilds the mirror only from durable FINAL.
	assert.match(doc, /\.pi\/workbench\/delegations\/<id>\/v2\/review\.json/);
	assert.match(doc, /segmented\s+provisional PASS, incomplete coverage, or any\s+FAIL[\s\S]*never grants authority/);
	assert.match(doc, /Every\s+non-zero delta additionally requires an explicit Sol decision on a previously\s+presented complete packet/);
	assert.match(doc, /only complete scope `PASS`, complete presentation,\s+and exact ACCEPT hash atomically publish[\s\S]*`REVIEWED`/);
	assert.match(doc, /persists exactly one provisional, globally bounded scope\/integrity packet/);
	assert.match(doc, /later call must pair `semantic_decision=ACCEPT` with its exact\s+`expected_bound_diff_hash`/);
	assert.match(doc, /PENDING_REVIEW → REVIEWED → \(versioned binding conflicts\) → STALE/);
	assert.match(doc, /`changeset-relevance-v2` projection over the closed relevance set/);
	assert.match(doc, /W is the\s+attributed worker delta, D is the explicit dependency closure/);
	assert.match(doc, /S is the relevant control set \(fixed workbench configuration,\s+applicable `AGENTS\.md`, and managed policy\/schema paths\)/);
	assert.match(doc, /Baseline unrelated dirty paths \(B\) and\s+recognized workbench artifacts are deliberately excluded/);
	assert.match(doc, /Git HEAD change,\s+W\/D\/S drift, or a new unknown-origin dirty path \(U\) fails closed/);
	assert.match(doc, /Historical\s+untagged v2 and v1 reviews retain their complete full-diff binding/);
	assert.match(doc, /compatibility field names remain[\s\S]*new tagged v2 refreshes the W\/D\/S relevance binding/);
	assert.match(doc, /Historical untagged v2\/v1 refreshes the complete full-diff\s+binding/);
	assert.doesNotMatch(doc, /refreshes against the real git diff, so\s+any change after REVIEWED turns the delegation STALE/);
	assert.match(doc, /append failure is returned as a persistence failure; a later tool call first\s+reconciles the strict durable FINAL artifact/);
	// Strict repair provenance and legacy compatibility allow a v1 read only
	// for a true v2 not-found result; invalid v2 authority remains blocking.
	assert.match(doc, /committed implementation `PENDING_REVIEW` is referenceable only with its\s+strict current-binding Sol `REPAIR` sidecar/);
	assert.match(doc, /lineaged `FAILED`, narrowly\s+proven before-write `ABORTED`, or strictly recoverable\s+`RECOVERY_REQUIRED` record may be retried only by its exact latest id/);
	assert.match(doc, /Semantic-repair descendants additionally inherit the exact cumulative W\/D\s+paths, exact-file `allowed_paths`, root plan presence\/hash, root decision\s+hash, and latest continuation-decision hash/);
	assert.match(doc, /Only a strict\s+v2 `not_found` result permits the historical\s+read-only fallback/);
	assert.match(doc, /Corrupt, pending, unsupported, storage-failed, or otherwise invalid v2 never\s+falls back/);
	assert.match(doc, /v1 `manifest\.json`\/ledger\/review readers remain historical read-only\s+compatibility/);
	assert.match(doc, /New public delegations never write v1/);
	assert.match(doc, /Rollback may stop using v2 but must not delete or rewrite v2\s+authority/);
	assert.match(doc, /unknown higher schema version always fails closed/);
	// Human documentation is not a progress mirror or execution authority.
	assert.match(doc, /not a progress\s+mirror and records no run ids or verification status/);
	assert.match(doc, /Current committed\s+transaction\/run records and current test output determine observed state/);
	assert.match(doc, /worker report remains bounded presentation, never acceptance authority/);
	assert.doesNotMatch(doc, /remain `NOT_RUN` until Sol runs and records them/);
	// VERIFY remains hard-blocking; delegation recovery is narrowly limited to
	// an exact strict finalized-v2 successor transition.
	assert.match(doc, /pending or stale review blocks VERIFY \(`\/q-mode-verify`\s+refuses/);
	assert.match(doc, /only ordinary successor exception is exact latest\s+`STALE` plus strict committed v2 FINAL\/PASS carrying explicit Sol semantic\s+acceptance/);
	assert.match(doc, /immutable old review is preserved, the authority is\s+revalidated immediately before worker launch/);
	assert.match(doc, /exact semantic-repair continuation may\s+consume a current `PENDING_REVIEW` Sol `REPAIR` decision or the strictly\s+retryable latest lineaged failure\/abort\/recovery/);
	assert.match(doc, /Every other\s+`PENDING_REVIEW`, corrupt, unpublished, recovery-required, non-final, v1,\s+and untagged authority remains blocked/);
});

test("security documentation distinguishes new-v2 relevance from legacy full-diff review gating", async () => {
	const doc = await readFile(new URL("../docs/security.md", import.meta.url), "utf8");
	assert.match(doc, /New tagged v2\s+uses a W\/D\/S relevance binding/);
	assert.match(doc, /baseline unrelated dirty paths and recognized\s+workbench artifacts do not stale it/);
	assert.match(doc, /Git HEAD, W\/D\/S, or a new\s+unknown-origin path fails closed/);
	assert.match(doc, /Historical untagged v2\/v1 retains the\s+complete full-diff binding/);
	assert.doesNotMatch(doc, /any diff\s+change after REVIEWED turns the delegation STALE \(a diff returning/);
});

// ---------------------------------------------------------------------------
// Phase 4A: repair-provenance contract validation (worker repair slices)
// ---------------------------------------------------------------------------

const VALID_REPAIR_ID = "20250101-120000-abcd";

test("repair-of validation accepts omitted and exact delegation ids only", () => {
	assert.deepEqual(resolveWorkerRepairOf(undefined), { ok: true, repairOf: undefined });
	assert.deepEqual(resolveWorkerRepairOf(VALID_REPAIR_ID), { ok: true, repairOf: VALID_REPAIR_ID });
	// The 4-character suffix is alphanumeric in either case.
	assert.deepEqual(resolveWorkerRepairOf("20250101-120000-ABCD"), { ok: true, repairOf: "20250101-120000-ABCD" });
	assert.deepEqual(resolveWorkerRepairOf("20250101-120000-9aZ0"), { ok: true, repairOf: "20250101-120000-9aZ0" });
});

test("repair-of validation fails closed on malformed strings and wrong types", () => {
	// Whitespace-padded, wrong-length, wrong-separator, traversal-shaped,
	// non-ASCII, and case-pattern violations all fail closed — only the
	// exact 20-character id shape (8 digits-6 digits-4 alphanumerics) is
	// accepted.
	const malformed = [
		"",
		" 20250101-120000-abcd",
		"20250101-120000-abcd ",
		"20250101-120000-abcd\n",
		"20250101-120000-abcd/",
		"../20250101-120000-abcd",
		"20250101/120000/abcd",
		"20250101-120000-ab c",
		"2025010-120000-abcd", // 19 characters
		"20250101-120000-abcdE", // 21 characters
		"2025O1O1-12OOOO-abcd", // letters in digit positions
		"ABCDEFGH-120000-abcd", // letters in the date part
		"２０２５０１０１-１２００００-ａｂｃｄ", // full-width non-ASCII
		"20250101-120000-абвг", // non-ASCII suffix
	];
	for (const bad of malformed) {
		const r = resolveWorkerRepairOf(bad);
		assert.equal(r.ok, false, `string ${JSON.stringify(bad)} must fail closed`);
		if (!r.ok) assert.match(r.error, /repair_of must be a valid 20-character delegation id/);
	}
	// Wrong types fail closed too.
	for (const bad of [null, 0, 42, 3.5, true, false, {}, { repairOf: VALID_REPAIR_ID }, [], [VALID_REPAIR_ID]]) {
		const r = resolveWorkerRepairOf(bad);
		assert.equal(r.ok, false, `${JSON.stringify(bad)} must fail closed`);
		if (!r.ok) assert.match(r.error, /repair_of must be a valid 20-character delegation id/);
	}
	// The error stays bounded even for pathological values: never the full
	// value, and never an unbounded message (raw and escaped preview caps).
	for (const pathological of ["x".repeat(10_000), "\u0000".repeat(10_000)]) {
		const r = resolveWorkerRepairOf(pathological);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(r.error.length < 200, "error message stays bounded");
			assert.ok(!r.error.includes(pathological), "never the full pathological value");
		}
	}
});

test("formatted worker task carries the repair provenance pointer line only when present (Phase 4A)", () => {
	const base: WorkerTaskContract = {
		task: "Repair the parser slice",
		allowedPaths: ["src/parser/**", "tests/parser.test.ts"],
		acceptanceCriteria: ["Unit tests cover the repaired option"],
		verification: ["recipe:unit-test"],
	};
	// Omitted: no provenance line at all; the rest of the contract travels
	// unchanged.
	const without = formatWorkerTask(base);
	assert.ok(!without.includes("Repair provenance"), "no provenance line when repairOf is omitted");
	assert.match(without, /Worker spend-budget profile: extended/);
	assert.match(without, /- src\/parser\/\*\*/);
	assert.match(without, /- Unit tests cover the repaired option/);
	assert.match(without, /Requested write-free recipe verification:/);
	// Present: the exact deterministic line precedes the spend-profile line.
	const withRepair = formatWorkerTask({ ...base, repairOf: VALID_REPAIR_ID });
	const repairLine = `Repair provenance: ${VALID_REPAIR_ID} — fresh worker; immutable machine-fact capsule only; no prior session/report inherited.`;
	assert.ok(withRepair.includes(repairLine), "exact provenance line is present");
	const repairIndex = withRepair.indexOf("Repair provenance:");
	const profileIndex = withRepair.indexOf("Worker spend-budget profile:");
	assert.ok(repairIndex !== -1 && repairIndex < profileIndex, "provenance line precedes the spend-profile line");
	// Informational only: paths, criteria, verification, and the budget
	// profile line all remain unchanged.
	for (const path of base.allowedPaths) assert.ok(withRepair.includes(path), `allowed path missing: ${path}`);
	for (const criterion of base.acceptanceCriteria) assert.ok(withRepair.includes(criterion), `criterion missing: ${criterion}`);
	for (const step of base.verification) assert.ok(withRepair.includes(step), `verification step missing: ${step}`);
	assert.match(withRepair, /Worker spend-budget profile: extended/);
	// Adding repairOf changes nothing but the inserted line.
	assert.equal(
		withRepair,
		without.replace("Worker spend-budget profile:", `${repairLine}\nWorker spend-budget profile:`),
		"the only difference is the provenance line",
	);
	// Combined with an explicit budget profile, both lines coexist with the
	// provenance pointer first and the profile rendering unchanged.
	const combined = formatWorkerTask({ ...base, repairOf: VALID_REPAIR_ID, budgetProfile: "standard" });
	assert.ok(combined.indexOf("Repair provenance:") < combined.indexOf("Worker spend-budget profile: standard"));
	assert.match(combined, /Worker spend-budget profile: standard — bounds cumulative spend only/);
});

test("formatted repair task carries only a bounded structured authority capsule", () => {
	const capsule: WorkerRepairCapsule = {
		schema: WORKER_REPAIR_CAPSULE_SCHEMA,
		repair_of: VALID_REPAIR_ID,
		authority_kind: "v2_committed",
		authority_status: "FAILED",
		contract_hash: "a".repeat(64),
		generation_content_hash: "b".repeat(64),
		journal_hash: null,
		failure: { exit_code: 1, reason_codes: ["WORKER_FAILED"], successful_write_count: 1, denied_write_count: 0 },
		changed_paths: ["src/parser/index.ts"],
		changed_paths_omitted: 0,
		failed_runs: [{ recipe: "unit-test", run_id: "20250101-120100-run1", outcome: "PROCESS_FAILED" }],
		plan_ref: {
			plan_id: "repair-plan", version: "1", plan_path: "docs/plan.md", plan_sha256: "c".repeat(64), candidate: "CURRENT",
		},
	};
	const text = formatWorkerTask({
		task: "Repair the parser",
		allowedPaths: ["src/parser/**"],
		acceptanceCriteria: ["The parser handles the case."],
		verification: ["recipe:unit-test"],
		repairOf: VALID_REPAIR_ID,
		repairCapsule: capsule,
	});
	assert.match(text, /Repair authority facts \(bounded machine facts only; never prior prose or session state\):/);
	assert.match(text, /"changed_paths":\["src\/parser\/index\.ts"\]/);
	assert.match(text, /"run_id":"20250101-120100-run1"/);
	assert.doesNotMatch(text, /worker-report|transcript|error_message/);
	assert.throws(() => formatWorkerTask({
		task: "Repair",
		allowedPaths: ["src/**"],
		acceptanceCriteria: ["Repair is bounded."],
		verification: [],
		repairOf: VALID_REPAIR_ID,
		repairCapsule: { ...capsule, repair_of: "20250101-120000-wxyz" },
	}), /conflicts with repair provenance/);
});
