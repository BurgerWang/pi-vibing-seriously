import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

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
