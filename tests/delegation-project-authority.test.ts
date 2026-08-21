import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import {
	projectDelegationDispositionV2,
	readLatestProjectDelegationTransactionV2,
} from "../extensions/workbench-runtime/core/delegation-project-authority.ts";
import {
	persistAbortedDelegationTransaction,
	persistPreparedDelegationTransaction,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import type { DelegationTransactionRecord } from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { withTempDir } from "./helpers.ts";

const HASH = "a".repeat(64);

function at(second: number): string {
	return `2026-08-20T10:00:${String(second).padStart(2, "0")}.000Z`;
}

async function prepared(root: string, id: string, second: number): Promise<DelegationTransactionRecord> {
	const result = await persistPreparedDelegationTransaction(root, {
		delegation_id: id,
		task_kind: "implementation",
		contract_hash: HASH,
		allowed_paths: ["src/**"],
		worker_identity: {
			provider: WORKER_PROVIDER,
			model: WORKER_MODEL_ID,
			worker_id: `worker:${id}`,
		},
		generation: 1,
		now: at(second),
	});
	if (!result.ok) throw new Error(result.error.code);
	return result.value;
}

test("project authority discovery returns null when no delegation root exists", async () => {
	await withTempDir(async (root) => {
		assert.deepEqual(await readLatestProjectDelegationTransactionV2(root), { ok: true, value: null });
	});
});

test("project authority discovers the newest v2 transaction and ignores newer v1-only directories", async () => {
	await withTempDir(async (root) => {
		const older = "20260820-100000-old1";
		const sameSecondOlder = "20260820-100001-a001";
		const sameSecondNewer = "20260820-100001-z999";
		await prepared(root, older, 0);
		await prepared(root, sameSecondOlder, 1);
		await prepared(root, sameSecondNewer, 2);
		await mkdir(join(root, CONFIG_DIR_NAME, "workbench", "delegations", "20260820-100002-v1ok"), { recursive: true });

		const latest = await readLatestProjectDelegationTransactionV2(root);
		assert.equal(latest.ok, true);
		if (latest.ok) assert.equal(latest.value?.delegation_id, sameSecondNewer);
	});
});

test("project authority fails closed on a corrupt newest v2 transaction", async () => {
	await withTempDir(async (root) => {
		await prepared(root, "20260820-100000-good", 0);
		const corruptId = "20260820-100001-bad1";
		const corrupt = join(root, CONFIG_DIR_NAME, "workbench", "delegations", corruptId, "v2", "transaction.json");
		await mkdir(join(corrupt, ".."), { recursive: true });
		await writeFile(corrupt, "{\"schema_version\":2", "utf8");

		const latest = await readLatestProjectDelegationTransactionV2(root);
		assert.equal(latest.ok, false);
		if (!latest.ok) {
			assert.equal(latest.error.code, "invalid_project_authority");
			assert.equal(latest.error.delegation_id, corruptId);
			assert.equal(latest.error.cause, "invalid_record");
		}
	});
});

test("project authority rejects a valid-id symlink and classifies durable blocking state", async () => {
	await withTempDir(async (root) => {
		const safe = await prepared(root, "20260820-100000-safe", 0);
		const rootDir = join(root, CONFIG_DIR_NAME, "workbench", "delegations");
		await symlink(join(rootDir, safe.delegation_id), join(rootDir, "20260820-100001-link"));
		const latest = await readLatestProjectDelegationTransactionV2(root);
		assert.equal(latest.ok, false);
		if (!latest.ok) assert.equal(latest.error.delegation_id, "20260820-100001-link");

		assert.deepEqual(projectDelegationDispositionV2(safe), { blocking: true, terminal_verdict: null });
		const aborted = await persistAbortedDelegationTransaction(root, {
			delegation_id: safe.delegation_id,
			contract_hash: safe.contract_hash,
			worker_identity: safe.worker_identity,
			expected_generation: safe.generation,
			expected_revision: safe.revision,
			now: at(1),
			reason: "bounded test abort",
		});
		assert.equal(aborted.ok, true);
		if (aborted.ok) {
			assert.deepEqual(projectDelegationDispositionV2(aborted.value), { blocking: false, terminal_verdict: "FAIL" });
		}
	});
});
