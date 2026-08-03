import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { WORKBENCH_TOOL_METADATA } from "../extensions/workbench-runtime/core/tool-catalog.ts";
import {
	commanderBlockReason,
	computeRoleActiveTools,
	formatWorkerTask,
	isWorkerPathAllowed,
	parseWorkerAllowedPaths,
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

test("worker-delegation documentation defines the risk rubric, Commander-led high-risk responsibilities, fresh continuation, and one writing worker per worktree", async () => {
	const doc = await readFile(new URL("../docs/worker-delegation.md", import.meta.url), "utf8");
	// Risk rubric with low/medium/high tiers.
	assert.match(doc, /## Risk rubric/);
	assert.match(doc, /\| Low \|/);
	assert.match(doc, /\| Medium \|/);
	assert.match(doc, /\| High \|/);
	assert.match(doc, /Commander-led: Sol owns the decision and implements or repairs directly by default/);
	assert.match(doc, /explicitly designed bounded support slices/);
	assert.match(doc, /never the DEV default/);
	// Commander-led responsibilities are spelled out.
	assert.match(doc, /### Responsibility split/);
	assert.match(doc, /\| Owned by Sol \(never delegated\) \| Owned by the Worker \(inside the approved contract\) \|/);
	// Fresh continuation and one writing worker per worktree.
	assert.match(doc, /## Fresh-worker continuation/);
	assert.match(doc, /brand-new `--no-session` worker/);
	assert.match(doc, /## One writing worker per worktree/);
	assert.match(doc, /at most one worker writes to a worktree at any time/);
});
