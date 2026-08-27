import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { DelegateWorkerExecuteV1 } from "../extensions/workbench-runtime/core/delegate-tool-controller.ts";
import type { ExactRepairCommandAuthorityV1 } from "../extensions/workbench-runtime/core/exact-repair-authority.ts";
import { registerExactRepairToolV1 } from "../extensions/workbench-runtime/core/exact-repair-tool-controller.ts";

const PARENT = "20260827-192913-w7xf";
const CHILD = "20260827-193000-fix1";

function context(): ExtensionContext {
	return {
		cwd: "/project",
		model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" },
		isProjectTrusted: () => true,
		signal: undefined,
	} as unknown as ExtensionContext;
}

function authority(): ExactRepairCommandAuthorityV1 {
	return {
		schema_version: 1,
		kind: "exact-repair-command-execution-v1",
		repair_of: PARENT,
		committed_proof_content_hash: "c".repeat(64),
		authority_kind: "semantic-repair",
		semantic_decision_hash: "d".repeat(64),
		arguments: {
			task_kind: "implementation",
			task: "Immutable authority task",
			allowed_paths: ["src/exact.ts"],
			acceptance_criteria: ["Immutable authority criterion"],
			verification: [],
			timeout_seconds: 600,
			budget_profile: "standard",
			repair_of: PARENT,
		},
		successor_lineage: { depth: 1 },
		idempotency_key: "e".repeat(64),
		tool_call_id: `q-repair-${"e".repeat(64)}`,
	} as unknown as ExactRepairCommandAuthorityV1;
}

function successor() {
	return {
		delegation_id: CHILD,
		status: "PENDING_REVIEW" as const,
		contract_hash: "a".repeat(64),
		transaction_hash: "b".repeat(64),
		committed_proof_content_hash: "c".repeat(64),
		disposition: "REVIEW_PENDING" as const,
	};
}

function harness() {
	let registered: { name: string; parameters: unknown; execute: (...args: any[]) => Promise<any> } | undefined;
	let successorReads = 0;
	let executions = 0;
	let executedAuthority: ExactRepairCommandAuthorityV1 | undefined;
	const exact = authority();
	const executeExactRepair = (async (received: ExactRepairCommandAuthorityV1) => {
		executions += 1;
		executedAuthority = received;
		return { content: [{ type: "text", text: "delegate result" }], details: { ok: true } };
	}) as never;
	const handle = registerExactRepairToolV1({
		pi: { registerTool: (tool: any) => { registered = tool; } },
		execution: {
			execute: (async () => { throw new Error("broad delegate execute must not be used"); }) as DelegateWorkerExecuteV1,
			executeExactRepair,
		},
		serviceDependencies: {
			readCommittedGeneration: (async () => ({
				ok: true,
				value: { state: { delegation_id: PARENT, status: "PENDING_REVIEW" }, proof: { content_hash: "c".repeat(64) } },
			})) as never,
			readReview: (async () => ({ ok: true, value: { review: true } })) as never,
			recoverAuthority: (() => ({ ok: true, value: exact })) as never,
			readSuccessor: (async () => {
				successorReads += 1;
				return successorReads === 1
					? { ok: true, kind: "none" }
					: { ok: true, kind: "existing", value: successor() };
			}) as never,
			collectCurrentBinding: async () => ({ status: "fresh", hash: "9".repeat(64) }),
		},
		trustedOrError: () => undefined,
		projectRootFor: async () => "/project",
		getMode: () => "DEV",
		runtimeCurrentOrError: () => undefined,
		reconcileProjectAuthority: async () => {},
	});
	assert.ok(registered);
	return {
		registered: registered!,
		handle,
		facts: () => ({ successorReads, executions, executedAuthority }),
	};
}

test("model-callable exact repair accepts only an id and starts one immutable successor", async () => {
	const testHarness = harness();
	assert.equal(testHarness.registered.name, "workbench_repair_delegation");
	assert.deepEqual((testHarness.registered.parameters as { required?: string[] }).required, ["delegation_id"]);
	assert.deepEqual(Object.keys((testHarness.registered.parameters as { properties: object }).properties), ["delegation_id"]);

	const result = await testHarness.registered.execute(
		"repair-call",
		{ delegation_id: PARENT },
		undefined,
		undefined,
		context(),
	);
	assert.equal(result.details.status, "SUCCESSOR_RECORDED");
	assert.equal(result.details.delegation_id, CHILD);
	assert.equal(result.details.next_action, `call workbench_review_worker_diff with delegation_id=${CHILD}`);
	assert.equal(testHarness.facts().executions, 1);
	assert.equal(testHarness.facts().executedAuthority?.arguments.task, "Immutable authority task");
});

test("legacy delegate repair_of is a safe alias that ignores every caller contract field", async () => {
	const testHarness = harness();
	const result = await testHarness.handle.executeDelegateAlias(
		"legacy-call",
		{
			task: "MALICIOUS REPLACEMENT",
			allowed_paths: ["/**"],
			acceptance_criteria: ["MALICIOUS REPLACEMENT"],
			verification: [],
			timeout_seconds: 3600,
			budget_profile: "extended",
			repair_of: PARENT,
			task_kind: "diagnosis",
		},
		undefined,
		undefined,
		context(),
	);
	const details = result.details as Record<string, unknown>;
	assert.equal(details.compatibility_alias, "workbench_delegate_worker.repair_of");
	assert.equal(details.caller_contract_ignored, true);
	assert.equal(testHarness.facts().executions, 1);
	assert.deepEqual(testHarness.facts().executedAuthority?.arguments.allowed_paths, ["src/exact.ts"]);
	assert.equal(testHarness.facts().executedAuthority?.arguments.task_kind, "implementation");
});

test("exact repair replay returns the same successor without a second worker", async () => {
	const testHarness = harness();
	await testHarness.registered.execute("first", { delegation_id: PARENT }, undefined, undefined, context());
	const replay = await testHarness.registered.execute("second", { delegation_id: PARENT }, undefined, undefined, context());
	assert.equal(replay.details.delegation_id, CHILD);
	assert.equal(replay.details.replayed, true);
	assert.equal(testHarness.facts().executions, 1);
});
