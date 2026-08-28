import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import { publishDelegationInactiveBlockerClosureV2 } from "../extensions/workbench-runtime/core/delegation-authority-closure.ts";
import { normalizeDelegationBoundedTaskContractV2 } from "../extensions/workbench-runtime/core/delegation-transaction-artifacts.ts";
import {
	persistAbortedDelegationTransaction,
	persistPreparedDelegationTransaction,
} from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import type { DelegationCommittedGenerationV2 } from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import { bindDelegationRepairLineageV1 } from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import {
	readStrictRetryableRawRepairEvidenceV1,
	RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2,
} from "../extensions/workbench-runtime/core/delegation-execution-owner.ts";
import type {
	ExactRepairCommandAuthorityV1,
	ExactRepairToolArgumentsV1,
} from "../extensions/workbench-runtime/core/exact-repair-authority.ts";
import {
	classifyExactRepairSuccessorV1,
	readExactRepairSuccessorV1,
} from "../extensions/workbench-runtime/core/exact-repair-successor.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { collectWorkspaceGuard } from "../extensions/workbench-runtime/core/workspace-guard.ts";
import { spawnExec, withTempDir } from "./helpers.ts";

const PARENT_ID = "20260827-020100-prnt";
const SUCCESSOR_ID = "20260827-020101-next";
const SECOND_ID = "20260827-020102-more";
const PROOF_HASH = "a".repeat(64);
const DECISION_HASH = "b".repeat(64);

function reboundContract(allowedPaths: readonly string[] = ["src/**"]) {
	const normalized = normalizeDelegationBoundedTaskContractV2({
		task_kind: "implementation",
		task: "Continue the exact rejected implementation.",
		allowed_paths: [...allowedPaths],
		acceptance_criteria: ["The rejected behavior is corrected."],
		verification: [],
		timeout_seconds: 600,
		budget_profile: "extended",
		repair_of: PARENT_ID,
	});
	assert.equal(normalized.ok, true);
	return normalized.value;
}

function authority(allowedPaths: readonly string[] = ["src/**"]): ExactRepairCommandAuthorityV1 {
	const contract = reboundContract(allowedPaths);
	const lineage = bindDelegationRepairLineageV1({
		schema_version: 1,
		kind: "semantic-repair-lineage-v1",
		root_delegation_id: PARENT_ID,
		repair_of: PARENT_ID,
		root_decision_hash: DECISION_HASH,
		continuation_decision_delegation_id: PARENT_ID,
		continuation_decision_hash: DECISION_HASH,
		parent_lineage_hash: null,
		depth: 1,
		carried_paths: ["src/dependency.ts", "src/generated.ts", "src/worker.ts"],
	});
	assert.ok(lineage);
	const { contract_hash: _contractHash, budget_profile: _budgetProfile, ...rest } = contract;
	const arguments_: ExactRepairToolArgumentsV1 = { ...rest, budget_profile: "extended" };
	const projection = {
		schema_version: 1 as const,
		kind: "exact-repair-command-execution-v1" as const,
		repair_of: PARENT_ID,
		committed_proof_content_hash: PROOF_HASH,
		arguments: arguments_,
		successor_lineage: lineage,
		authority_kind: "terminal-negative-repair" as const,
		semantic_decision_hash: DECISION_HASH,
		expected_bound_diff_hash: "c".repeat(64),
	};
	const idempotencyKey = canonicalHash(projection);
	return {
		...projection,
		idempotency_key: idempotencyKey,
		tool_call_id: `q-repair-${idempotencyKey}`,
	};
}

function parent(allowedPaths: readonly string[] = ["src/**"]): DelegationCommittedGenerationV2 {
	const proof = { content_hash: PROOF_HASH };
	return {
		state: {
			delegation_id: PARENT_ID,
			status: "INTERRUPTED",
			allowed_paths: [...allowedPaths],
			committed_proof: proof,
		},
		proof,
	} as unknown as DelegationCommittedGenerationV2;
}

const closureReader = async () => ({
	ok: true as const,
	unresolvedTipId: PARENT_ID,
	rootCount: 1,
	lineageCount: 0,
});

async function preparedSuccessor(
	root: string,
	id: string,
	commandAuthority: ExactRepairCommandAuthorityV1,
	options: { contractHash?: string; allowedPaths?: readonly string[]; carriedPaths?: readonly string[] } = {},
): Promise<void> {
	let lineage = commandAuthority.successor_lineage;
	if (options.carriedPaths !== undefined) {
		const { lineage_hash: _lineageHash, ...lineageInput } = lineage;
		const rebound = bindDelegationRepairLineageV1({
			...lineageInput,
			carried_paths: [...options.carriedPaths],
		});
		assert.ok(rebound);
		lineage = rebound;
	}
	const expected = reboundContract(options.allowedPaths ?? commandAuthority.arguments.allowed_paths);
	const persisted = await persistPreparedDelegationTransaction(root, {
		delegation_id: id,
		task_kind: "implementation",
		contract_hash: options.contractHash ?? expected.contract_hash,
		allowed_paths: [...(options.allowedPaths ?? commandAuthority.arguments.allowed_paths)],
		worker_identity: {
			provider: WORKER_PROVIDER,
			model: WORKER_MODEL_ID,
			worker_id: `worker:${id}`,
		},
		generation: 1,
		now: "2026-08-27T02:01:03.000Z",
		repair_lineage: lineage,
	});
	assert.equal(persisted.ok, true, persisted.ok ? "" : persisted.error.code);
}

test("successor scan returns the one durable transaction with exact contract and lineage identity", async () => {
	await withTempDir(async (root) => {
		const commandAuthority = authority();
		await preparedSuccessor(root, SUCCESSOR_ID, commandAuthority);
		const result = await readExactRepairSuccessorV1({
			projectRoot: root,
			parent: parent(),
			authority: commandAuthority,
			readRepairClosure: closureReader,
		});
		assert.equal(result.ok, true, result.ok ? "" : result.code);
		if (!result.ok) return;
		assert.equal(result.kind, "existing");
		if (result.kind === "existing") {
			assert.equal(result.value.delegation_id, SUCCESSOR_ID);
			assert.equal(result.value.status, "PREPARED");
			assert.equal(result.value.committed_proof_content_hash, null);
		}
	});
});

test("zero-delta lineaged FAILED successor stays exact-repair pending without a terminal-negative sidecar", async () => {
	let terminalReads = 0;
	const candidate = {
		delegation_id: SUCCESSOR_ID,
		status: "FAILED",
		task_kind: "implementation",
		revision: 3,
		committed_proof: { revision: 2, content_hash: PROOF_HASH },
		repair_lineage: { depth: 2 },
		terminal_outcome: {
			terminal_facts_complete: true,
			scope_complete: true,
			changed_paths: [],
			delta_hash: "f".repeat(64),
			change_set_status: "ATTRIBUTED",
		},
	} as unknown as DelegationCommittedGenerationV2["state"];
	const committed = {
		state: structuredClone(candidate),
		proof: structuredClone(candidate.committed_proof),
		records: {},
	} as unknown as DelegationCommittedGenerationV2;
	const result = await classifyExactRepairSuccessorV1("/project", candidate, {
		readCommittedGeneration: (async () => ({ ok: true, value: committed })) as never,
		readReview: (async () => { throw new Error("must not read ordinary review"); }) as never,
		readTerminalNegativeRepair: (async () => {
			terminalReads += 1;
			return { ok: false, error: { code: "invalid_record" } };
		}) as never,
		recoverExactRepairAuthority: (() => ({ ok: true, value: authority() })) as never,
	});
	assert.deepEqual(result, {
		ok: true,
		committed_proof_content_hash: PROOF_HASH,
		disposition: "EXACT_REPAIR_PENDING",
	});
	assert.equal(terminalReads, 0);
});

test("non-empty lineaged FAILED successor still fails closed on a corrupt terminal-negative sidecar", async () => {
	const candidate = {
		delegation_id: SUCCESSOR_ID,
		status: "FAILED",
		task_kind: "implementation",
		revision: 3,
		allowed_paths: ["src/**"],
		committed_proof: { revision: 2, content_hash: PROOF_HASH },
		review: null,
		repair_lineage: { depth: 2 },
		terminal_outcome: {
			terminal_facts_complete: true,
			scope_complete: true,
			changed_paths: ["src/repaired.ts"],
			delta_hash: "f".repeat(64),
			change_set_status: "ATTRIBUTED",
		},
	} as unknown as DelegationCommittedGenerationV2["state"];
	const committed = {
		state: structuredClone(candidate),
		proof: structuredClone(candidate.committed_proof),
		records: {},
	} as unknown as DelegationCommittedGenerationV2;
	const result = await classifyExactRepairSuccessorV1("/project", candidate, {
		readCommittedGeneration: (async () => ({ ok: true, value: committed })) as never,
		readReview: (async () => { throw new Error("must not read ordinary review"); }) as never,
		readTerminalNegativeRepair: (async () => ({ ok: false, error: { code: "invalid_record" } })) as never,
		recoverExactRepairAuthority: (() => { throw new Error("corrupt sidecar must not fall back to lineage"); }) as never,
	});
	assert.deepEqual(result, { ok: false, code: "AUTHORITY_INVALID" });
});

test("successor replay keeps carried review dependencies separate from worker write capability", async () => {
	await withTempDir(async (root) => {
		const allowedPaths = ["src/worker.ts"];
		const commandAuthority = authority(allowedPaths);
		await preparedSuccessor(root, SUCCESSOR_ID, commandAuthority);
		const result = await readExactRepairSuccessorV1({
			projectRoot: root,
			parent: parent(allowedPaths),
			authority: commandAuthority,
			readRepairClosure: closureReader,
		});
		assert.equal(result.ok, true, result.ok ? "" : result.code);
		if (result.ok) assert.equal(result.kind, "existing");
	});
});

test("successor scan rejects a sibling whose carried paths or immutable contract differ", async () => {
	await withTempDir(async (root) => {
		const commandAuthority = authority();
		await preparedSuccessor(root, SUCCESSOR_ID, commandAuthority, {
			carriedPaths: ["src/dependency.ts", "src/other.ts", "src/worker.ts"],
		});
		const result = await readExactRepairSuccessorV1({
			projectRoot: root,
			parent: parent(),
			authority: commandAuthority,
			readRepairClosure: closureReader,
		});
		assert.deepEqual(result, { ok: false, code: "IDEMPOTENCY_CONFLICT", delegation_id: SUCCESSOR_ID });
	});

	await withTempDir(async (root) => {
		const commandAuthority = authority();
		await preparedSuccessor(root, SUCCESSOR_ID, commandAuthority, {
			allowedPaths: ["src/worker.ts"],
		});
		const result = await readExactRepairSuccessorV1({
			projectRoot: root,
			parent: parent(),
			authority: commandAuthority,
			readRepairClosure: closureReader,
		});
		assert.deepEqual(result, { ok: false, code: "IDEMPOTENCY_CONFLICT", delegation_id: SUCCESSOR_ID });
	});
});

test("successor scan treats multiple exact successors as a durable idempotency conflict", async () => {
	await withTempDir(async (root) => {
		const commandAuthority = authority();
		await preparedSuccessor(root, SUCCESSOR_ID, commandAuthority);
		await preparedSuccessor(root, SECOND_ID, commandAuthority);
		assert.deepEqual(await readExactRepairSuccessorV1({
			projectRoot: root,
			parent: parent(),
			authority: commandAuthority,
			readRepairClosure: closureReader,
		}), { ok: false, code: "IDEMPOTENCY_CONFLICT" });
	});
});

test("a durably superseded no-write attempt is ignored so its parent can allocate one new exact successor", async () => {
	await withTempDir(async (root) => {
		assert.equal((await spawnExec("git", ["init", "-q"], { cwd: root })).code, 0);
		await writeFile(join(root, ".gitignore"), ".pi/\n", "utf8");
		await writeFile(join(root, "README.md"), "baseline\n", "utf8");
		assert.equal((await spawnExec("git", ["add", ".gitignore", "README.md"], { cwd: root })).code, 0);
		assert.equal((await spawnExec("git", ["-c", "user.name=Workbench Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "baseline"], { cwd: root })).code, 0);

		const commandAuthority = authority();
		await preparedSuccessor(root, SUCCESSOR_ID, commandAuthority);
		const aborted = await persistAbortedDelegationTransaction(root, {
			delegation_id: SUCCESSOR_ID,
			contract_hash: reboundContract().contract_hash,
			worker_identity: { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, worker_id: `worker:${SUCCESSOR_ID}` },
			expected_generation: 1,
			expected_revision: 0,
			now: "2026-08-27T02:01:04.000Z",
			reason: RETRYABLE_BEFORE_WRITE_ABORT_REASONS_V2.preparedCallbackFailed,
		});
		assert.equal(aborted.ok, true, aborted.ok ? "" : aborted.error.code);
		if (!aborted.ok) return;
		const emptyEvidence = await readStrictRetryableRawRepairEvidenceV1(root, aborted.value);
		assert.equal(emptyEvidence.ok, true, emptyEvidence.ok ? "" : emptyEvidence.code);
		assert.ok(Date.parse("2026-08-27T02:01:05.000Z") >= Date.parse(aborted.value.updated_at), aborted.value.updated_at);
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "worker.ts"), "rejected parent delta remains present\n", "utf8");
		const guard = await collectWorkspaceGuard({ project_root: root, exec: spawnExec });
		assert.equal(guard.ok, true, guard.ok ? "" : guard.error.code);
		if (!guard.ok) return;
		assert.notEqual(guard.guard.git_head, null);
		const closed = await publishDelegationInactiveBlockerClosureV2({
			project_root: root,
			transaction: aborted.value,
			workspace_guard: guard.guard,
			closed_by: { provider: "openai", model: "gpt-5.6-sol" },
			now: "2026-08-27T02:01:05.000Z",
		});
		assert.equal(closed.ok, true, closed.ok ? "" : closed.error.code);
		if (!closed.ok) return;
		assert.deepEqual(closed.value.relevant_paths, [], "the carried parent delta is not discarded by closing an empty child attempt");

		const none = await readExactRepairSuccessorV1({
			projectRoot: root,
			parent: parent(),
			authority: commandAuthority,
			readRepairClosure: closureReader,
		});
		assert.deepEqual(none, { ok: true, kind: "none" });

		await preparedSuccessor(root, SECOND_ID, commandAuthority);
		const replacement = await readExactRepairSuccessorV1({
			projectRoot: root,
			parent: parent(),
			authority: commandAuthority,
			readRepairClosure: closureReader,
		});
		assert.equal(replacement.ok, true, replacement.ok ? "" : replacement.code);
		if (replacement.ok && replacement.kind === "existing") assert.equal(replacement.value.delegation_id, SECOND_ID);
	});
});

test("successor scan fails closed on parent proof drift and absent on-disk root authority", async () => {
	await withTempDir(async (root) => {
		const commandAuthority = authority();
		await preparedSuccessor(root, SUCCESSOR_ID, commandAuthority);
		const changedParent = parent();
		changedParent.proof.content_hash = "d".repeat(64);
		assert.deepEqual(await readExactRepairSuccessorV1({
			projectRoot: root,
			parent: changedParent,
			authority: commandAuthority,
			readRepairClosure: closureReader,
		}), { ok: false, code: "AUTHORITY_INVALID" });
		const corruptIdempotency = {
			...structuredClone(commandAuthority),
			idempotency_key: "e".repeat(64),
		};
		assert.deepEqual(await readExactRepairSuccessorV1({
			projectRoot: root,
			parent: parent(),
			authority: corruptIdempotency,
			readRepairClosure: closureReader,
		}), { ok: false, code: "AUTHORITY_INVALID" });

		const withoutHegelClosure = await readExactRepairSuccessorV1({
			projectRoot: root,
			parent: parent(),
			authority: commandAuthority,
		});
		assert.equal(withoutHegelClosure.ok, false, "default closure cannot fabricate a terminal-negative root absent from disk");
		if (!withoutHegelClosure.ok) assert.equal(withoutHegelClosure.code, "AUTHORITY_INVALID");
	});
});
