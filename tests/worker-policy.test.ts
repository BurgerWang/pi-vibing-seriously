import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { WORKBENCH_TOOL_METADATA } from "../extensions/workbench-runtime/core/tool-catalog.ts";
import { STRICT_SOL_DEV_ALLOWLIST } from "../extensions/workbench-runtime/core/write-authority.ts";
import {
	commanderBlockReason,
	computeRoleActiveTools,
	formatWorkerTask,
	isWorkerPathAllowed,
	parseWorkerAllowedPaths,
	recipeMutationBlockReason,
	resolveWorkerBudgetProfile,
	workerRecipeBlockReason,
	workerRoleToolCallBlockReason,
	WORKER_ROLE,
	type WorkerTaskContract,
} from "../extensions/workbench-runtime/core/worker-policy.ts";
import { isWorkerPathAllowedRealpath } from "../extensions/workbench-runtime/worker/path-scope.ts";
import { withTempDir } from "./helpers.ts";

test("only GPT-5.6 Sol on an approved provider may command the worker", () => {
	assert.equal(commanderBlockReason("openai-codex", "gpt-5.6-sol"), undefined);
	assert.equal(commanderBlockReason("openai", "gpt-5.6-sol"), undefined);
	assert.match(commanderBlockReason("deepseek", "deepseek-v4-flash") ?? "", /requires commander/);
	assert.match(commanderBlockReason("openai-codex", "gpt-5.6-terra") ?? "", /active model/);
	assert.match(commanderBlockReason(undefined, undefined) ?? "", /\(none\)/);
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

test("worker-role filtering still hides recursion/final-gate tools from the strict Sol DEV allowlist (P7)", () => {
	const workerTools = computeRoleActiveTools(STRICT_SOL_DEV_ALLOWLIST, WORKER_ROLE);
	assert.ok(!workerTools.includes("workbench_delegate_worker"), "workers can never recursively delegate");
	assert.ok(!workerTools.includes("workbench_run_gate"), "workers can never run final gates");
	assert.ok(workerTools.includes("read"));
	assert.ok(workerTools.includes("workbench_run_recipe"));
});

test("worker role blocks recursion, free bash, final gates, and out-of-scope writes", () => {
	const context = { role: WORKER_ROLE, projectRoot: "/repo", allowedPaths: ["src/**", "tests/new.test.ts"] };
	assert.match(workerRoleToolCallBlockReason(context, "workbench_delegate_worker", {}) ?? "", /recursively/);
	assert.match(workerRoleToolCallBlockReason(context, "bash", { command: "npm test" }) ?? "", /declared workbench recipes/);
	assert.match(workerRoleToolCallBlockReason(context, "workbench_run_gate", {}) ?? "", /Sol commander/);
	assert.equal(workerRoleToolCallBlockReason(context, "edit", { path: "src/main.ts" }), undefined);
	assert.equal(workerRoleToolCallBlockReason(context, "write", { path: "tests/new.test.ts" }), undefined);
	assert.match(workerRoleToolCallBlockReason(context, "edit", { path: "README.md" }) ?? "", /outside the parent-approved scope/);
	assert.match(workerRoleToolCallBlockReason(context, "write", {}) ?? "", /non-empty path/);
	assert.equal(workerRoleToolCallBlockReason(context, "workbench_run_recipe", { recipe: "unit-test" }), undefined);
	assert.equal(workerRoleToolCallBlockReason({ role: undefined }, "bash", {}), undefined, "commander process is unaffected");
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
	const worker = { role: WORKER_ROLE, provider: "deepseek", model: "deepseek-v4-flash" };
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
	assert.match(text, /Requested verification:/);
	assert.ok(!text.includes("final PASS"));
});

// ---------------------------------------------------------------------------
// Phase 3: budget-profile contract validation (worker token-budget repair)
// ---------------------------------------------------------------------------

test("budget-profile validation resolves omitted to standard and accepts exactly the three literals", () => {
	assert.deepEqual(resolveWorkerBudgetProfile(undefined), { ok: true, profile: "standard" });
	assert.deepEqual(resolveWorkerBudgetProfile("low"), { ok: true, profile: "low" });
	assert.deepEqual(resolveWorkerBudgetProfile("standard"), { ok: true, profile: "standard" });
	assert.deepEqual(resolveWorkerBudgetProfile("extended"), { ok: true, profile: "extended" });
});

test("budget-profile validation fails closed on unknown, empty, wrong types and case variants", () => {
	// Unknown/empty/case-variant strings fail closed with the bounded error.
	for (const bad of ["", "LOW", "Standard", "EXTENDED", "ultra", " low", "standard ", "low\n", "low\u0000"]) {
		const r = resolveWorkerBudgetProfile(bad);
		assert.equal(r.ok, false, `string ${JSON.stringify(bad)} must fail closed`);
		if (!r.ok) assert.match(r.error, /budget_profile must be one of "low" \| "standard" \| "extended"/);
	}
	// Wrong types fail closed: null, numbers, booleans, objects, arrays.
	for (const bad of [null, 0, 1, 3.5, true, false, {}, { profile: "low" }, [], ["low"]]) {
		const r = resolveWorkerBudgetProfile(bad);
		assert.equal(r.ok, false, `${JSON.stringify(bad)} must fail closed`);
		if (!r.ok) assert.match(r.error, /budget_profile must be one of "low" \| "standard" \| "extended"/);
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
	// Omitted budgetProfile resolves deterministically to standard.
	const standardText = formatWorkerTask(base);
	assert.match(standardText, /Worker spend-budget profile: standard/);
	// Explicit low / extended profiles are named exactly when supplied.
	assert.match(formatWorkerTask({ ...base, budgetProfile: "low" }), /Worker spend-budget profile: low/);
	const extendedText = formatWorkerTask({ ...base, budgetProfile: "extended" });
	assert.match(extendedText, /Worker spend-budget profile: extended/);
	// The profile line states the profile bounds spend only — it never
	// expands the parent-approved path/scope authority (informational
	// wording; the runner/child env contract enforces the profile and
	// thresholds are unchanged).
	for (const text of [standardText, extendedText]) {
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
		verification: ["Run the unit-test recipe", "Run the docs-check recipe"],
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

test("delegate-tool metadata codifies the Sol/worker responsibility split and the vertical-slice default", () => {
	const meta = WORKBENCH_TOOL_METADATA.workbench_delegate_worker;
	const text = [meta.description, meta.promptSnippet, ...meta.promptGuidelines].join("\n");
	// Worker-owned: routine local implementation decisions inside the contract.
	assert.match(text, /routine local implementation decisions inside the approved contract/);
	// Sol-owned: requirements, cross-cutting architecture, scope, actual-diff
	// review, final verification/gates, and verdict.
	assert.match(text, /Sol owns requirements, cross-cutting architecture, scope, actual-diff review, final verification\/gates, and the verdict/);
	// DEV default: coherent source+tests+docs vertical slices for bounded
	// low/medium-risk implementation, with explicit paths and observable criteria.
	assert.match(text, /source\+tests\+docs vertical slices/);
	assert.match(text, /bounded low\/medium-risk implementation/);
	assert.match(text, /observable acceptance criteria/);
	assert.match(text, /minimum repository orientation/);
	assert.match(text, /avoid duplicating the worker's routine investigation/);
	// Worker prose is never acceptance; Sol independently inspects the diff.
	assert.match(text, /Worker prose is never acceptance evidence/);
	assert.match(text, /untrusted implementation report/);
	assert.match(text, /independently inspect the actual diff/);
});

test("delegate-tool metadata codifies profile choice and bounded-slicing granularity (Phase 5)", () => {
	const meta = WORKBENCH_TOOL_METADATA.workbench_delegate_worker;
	const text = [meta.description, meta.promptSnippet, ...meta.promptGuidelines].join("\n");
	// Profile choice: standard is the deterministic default; low is an
	// explicit tighter opt-in; extended is explicit Sol-approved only and
	// is never inferred or auto-promoted.
	assert.match(text, /standard is the deterministic default/);
	assert.match(text, /low is an explicit tighter opt-in/);
	assert.match(text, /extended is explicit Sol-approved only/);
	assert.match(text, /never inferred or auto-promoted/);
	// Granularity: one coherent source+tests+docs vertical slice with ample
	// headroom BELOW its soft thresholds; soft is a handoff reserve and
	// hard is failure — neither is a planning target.
	assert.match(text, /ample headroom BELOW/);
	assert.match(text, /soft is a handoff reserve/);
	assert.match(text, /hard is failure/);
	assert.match(text, /neither is a planning target/);
	// Unknown root cause: bounded diagnosis → Sol architecture/scope
	// decision → bounded implementation — never one open-ended worker task.
	assert.match(text, /bounded diagnosis/);
	assert.match(text, /Sol architecture\/scope decision/);
	assert.match(text, /bounded implementation/);
	assert.match(text, /never one open-ended worker task/);
});

test("worker-delegation documentation defines the risk rubric, worker-first high-risk delegation, fresh continuation, one writing worker, and the P7 ledger/review lifecycle", async () => {
	const doc = await readFile(new URL("../docs/worker-delegation.md", import.meta.url), "utf8");
	// Risk rubric with low/medium/high tiers.
	assert.match(doc, /## Risk rubric/);
	assert.match(doc, /\| Low \|/);
	assert.match(doc, /\| Medium \|/);
	assert.match(doc, /\| High \|/);
	// High-risk decisions are Commander-led: Sol owns the decision and never
	// delegates it; implementation/repair writes go to a fresh bounded worker
	// by default; only explicitly designed bounded support/implementation
	// scopes are delegated after the architecture is fixed; a temporary
	// commander direct write requires an explicit user-issued write lease.
	assert.match(doc, /Commander-led: Sol owns the decision and never delegates the decision itself/);
	assert.match(doc, /implementation\/repair writes go to a fresh bounded worker/);
	assert.match(doc, /explicitly designed bounded support\/implementation scopes are delegated after the architecture is fixed/);
	assert.match(doc, /Temporary commander direct writes require an explicit user-issued write lease/);
	assert.match(doc, /never the DEV default/);
	// Commander-led responsibilities are spelled out.
	assert.match(doc, /### Responsibility split/);
	assert.match(doc, /\| Owned by Sol \(never delegated\) \| Owned by the Worker \(inside the approved contract\) \|/);
	// Fresh continuation and one writing worker per worktree.
	assert.match(doc, /## Fresh-worker continuation/);
	assert.match(doc, /brand-new `--no-session` worker/);
	assert.match(doc, /## One writing worker per worktree/);
	assert.match(doc, /at most one worker writes to a worktree at any time/);
	// P7 worker-first write authority and the delegation ledger/review
	// lifecycle: every delegation is recorded and reviewed, and a pending or
	// stale review blocks both the next delegation and VERIFY.
	assert.match(doc, /## Worker-first write authority \(P7\)/);
	assert.match(doc, /## Delegation ledger and review lifecycle \(P7\)/);
	assert.match(doc, /PENDING_REVIEW → REVIEWED → \(current diff hash changes\) → STALE/);
	assert.match(doc, /a pending or stale review blocks BOTH the next delegation/);
	assert.match(doc, /and VERIFY \(`\/q-mode-verify`\s+refuses/);
});
