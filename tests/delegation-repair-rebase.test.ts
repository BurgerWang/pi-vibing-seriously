import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
	collectTerminalRepairRebaseAuthorityV1,
} from "../extensions/workbench-runtime/core/delegation-repair-rebase.ts";
import { bindDelegationRepairLineageV1 } from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import type { DelegationCommittedGenerationV2 } from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import { collectWorkspaceGuard } from "../extensions/workbench-runtime/core/workspace-guard.ts";
import { spawnExec, withTempDir } from "./helpers.ts";

const ID = "20260827-010203-rb01";

async function initialize(root: string): Promise<void> {
	assert.equal((await spawnExec("git", ["init", "-q"], { cwd: root })).code, 0);
	await writeFile(join(root, "README.md"), "base\n", "utf8");
	assert.equal((await spawnExec("git", ["add", "README.md"], { cwd: root })).code, 0);
	assert.equal((await spawnExec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"], { cwd: root })).code, 0);
	await mkdir(join(root, "src"), { recursive: true });
}

function committed(
	guard: unknown,
	carriedPaths: readonly string[],
	allowedPaths: readonly string[] = ["src/**"],
): DelegationCommittedGenerationV2 {
	const lineage = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: "20260827-010100-root",
		repair_of: "20260827-010100-root",
		root_decision_hash: "d".repeat(64),
		continuation_decision_delegation_id: "20260827-010100-root",
		continuation_decision_hash: "d".repeat(64),
		parent_lineage_hash: null,
		depth: 1,
		carried_paths: [...carriedPaths],
	});
	assert.ok(lineage);
	return {
		state: {
			delegation_id: ID,
			status: "FAILED",
			contract_hash: "a".repeat(64),
			allowed_paths: [...allowedPaths],
			repair_lineage: lineage,
		},
		records: { "after.json": { workspace_guard: guard } },
		proof: { content_hash: "c".repeat(64) },
	} as unknown as DelegationCommittedGenerationV2;
}

test("terminal repair rebase admits Git-visibility drift wholly inside the immutable lineage", async () => {
	await withTempDir(async (root) => {
		await initialize(root);
		await writeFile(join(root, "src", "visible.ts"), "visible\n", "utf8");
		await writeFile(join(root, "src", "later-ignored.ts"), "ignored later\n", "utf8");
		const sealed = await collectWorkspaceGuard({ project_root: root, exec: spawnExec });
		assert.equal(sealed.ok, true);
		if (!sealed.ok) return;
		await writeFile(join(root, ".git", "info", "exclude"), "src/later-ignored.ts\n", "utf8");

		const result = await collectTerminalRepairRebaseAuthorityV1({
			projectRoot: root,
			committed: committed(sealed.guard, ["src/later-ignored.ts", "src/visible.ts"]),
			exec: spawnExec,
		});
		assert.equal(result.ok, true, result.ok ? "" : result.code);
		if (!result.ok) return;
		assert.deepEqual(result.value.relevant_paths, ["src/visible.ts"]);
		assert.match(result.value.rebase_hash, /^[0-9a-f]{64}$/u);

		const replay = await collectTerminalRepairRebaseAuthorityV1({
			projectRoot: root,
			committed: committed(sealed.guard, ["src/later-ignored.ts", "src/visible.ts"]),
			exec: spawnExec,
		});
		assert.equal(replay.ok, true);
		if (replay.ok) assert.equal(replay.value.rebase_hash, result.value.rebase_hash, "unchanged snapshot is idempotent");
	});
});

test("terminal repair rebase rejects clean, out-of-lineage and changed-HEAD workspaces", async () => {
	await withTempDir(async (root) => {
		await initialize(root);
		await writeFile(join(root, "src", "carried.ts"), "carried\n", "utf8");
		const sealed = await collectWorkspaceGuard({ project_root: root, exec: spawnExec });
		assert.equal(sealed.ok, true);
		if (!sealed.ok) return;
		const authority = committed(sealed.guard, ["src/carried.ts"]);

		await writeFile(join(root, "src", "outside.ts"), "outside\n", "utf8");
		const outside = await collectTerminalRepairRebaseAuthorityV1({ projectRoot: root, committed: authority, exec: spawnExec });
		assert.deepEqual(outside, { ok: false, code: "path_outside_lineage", path: "src/outside.ts" });

		assert.equal((await spawnExec("git", ["add", "src/carried.ts", "src/outside.ts"], { cwd: root })).code, 0);
		assert.equal((await spawnExec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "advance"], { cwd: root })).code, 0);
		await writeFile(join(root, "src", "carried.ts"), "changed after head\n", "utf8");
		const head = await collectTerminalRepairRebaseAuthorityV1({ projectRoot: root, committed: authority, exec: spawnExec });
		assert.deepEqual(head, { ok: false, code: "head_changed" });
	});

	await withTempDir(async (root) => {
		await initialize(root);
		await writeFile(join(root, "src", "discarded.ts"), "discarded\n", "utf8");
		const sealed = await collectWorkspaceGuard({ project_root: root, exec: spawnExec });
		assert.equal(sealed.ok, true);
		if (!sealed.ok) return;
		await writeFile(join(root, ".git", "info", "exclude"), "src/discarded.ts\n", "utf8");
		const clean = await collectTerminalRepairRebaseAuthorityV1({
			projectRoot: root,
			committed: committed(sealed.guard, ["src/discarded.ts"]),
			exec: spawnExec,
		});
		assert.deepEqual(clean, { ok: false, code: "clean_workspace" });
	});
});

test("terminal repair rebase rejects unmerged status even on a carried path", async () => {
	await withTempDir(async (root) => {
		await initialize(root);
		await writeFile(join(root, "src", "conflict.ts"), "conflict\n", "utf8");
		const sealed = await collectWorkspaceGuard({ project_root: root, exec: spawnExec });
		assert.equal(sealed.ok, true);
		if (!sealed.ok || sealed.guard.git_head === null) return;
		const conflictExec = async (command: string, args: string[]) => {
			assert.equal(command, "git");
			if (args[0] === "rev-parse") return { stdout: `${sealed.guard.git_head}\n`, stderr: "", code: 0, killed: false };
			return { stdout: "UU src/conflict.ts\0", stderr: "", code: 0, killed: false };
		};
		const result = await collectTerminalRepairRebaseAuthorityV1({
			projectRoot: root,
			committed: committed(sealed.guard, ["src/conflict.ts"]),
			exec: conflictExec,
		});
		assert.deepEqual(result, { ok: false, code: "unmerged_path", path: "src/conflict.ts" });
	});
});

test("terminal repair rebase validates carried paths against immutable subtree semantics", async () => {
	await withTempDir(async (root) => {
		await initialize(root);
		await writeFile(join(root, "src", "child.ts"), "child\n", "utf8");
		const sealed = await collectWorkspaceGuard({ project_root: root, exec: spawnExec });
		assert.equal(sealed.ok, true);
		if (!sealed.ok) return;

		const subtree = await collectTerminalRepairRebaseAuthorityV1({
			projectRoot: root,
			committed: committed(sealed.guard, ["src/child.ts"], ["src/**"]),
			exec: spawnExec,
		});
		assert.equal(subtree.ok, true, subtree.ok ? "" : subtree.code);

		const exactParent = await collectTerminalRepairRebaseAuthorityV1({
			projectRoot: root,
			committed: committed(sealed.guard, ["src/child.ts"], ["src"]),
			exec: spawnExec,
		});
		assert.deepEqual(exactParent, {
			ok: false,
			code: "lineage_outside_allowed_scope",
			path: "src/child.ts",
		});
	});
});
