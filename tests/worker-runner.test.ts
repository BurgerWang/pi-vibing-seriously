import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildDelegateWorkerResult } from "../extensions/workbench-runtime/index.ts";
import {
	assertWorkerSucceeded,
	formatWorkerCacheSummary,
	runDeepseekWorker,
	workerCacheHitRatio,
	WORKER_SYSTEM_PROMPT,
	type PiInvocation,
	type WorkerRunResult,
} from "../extensions/workbench-runtime/worker/runner.ts";
import type { WorkerTaskContract } from "../extensions/workbench-runtime/core/worker-policy.ts";

const CONTRACT: WorkerTaskContract = {
	task: "Implement one bounded change",
	allowedPaths: ["src/**"],
	acceptanceCriteria: ["The change is complete"],
	verification: ["Run the declared unit-test recipe"],
};

async function withFakeWorker(source: string, fn: (invocation: PiInvocation, dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "worker-runner-test-"));
	try {
		const script = join(dir, "fake-worker.mjs");
		await writeFile(script, source, "utf8");
		await fn({ command: process.execPath, argsPrefix: [script] }, dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function assistantEvent(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			provider: "deepseek",
			model: "deepseek-v4-flash",
			content: [{ type: "text", text: "## Completed\nImplemented." }],
			stopReason: "stop",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 20,
				cacheWrite: 0,
				totalTokens: 35,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
			},
			...overrides,
		},
	});
}

test("runner consumes JSON events, pins model identity, and aggregates usage", async () => {
	const first = assistantEvent({ content: [{ type: "text", text: "working" }], stopReason: "toolUse" });
	const final = assistantEvent();
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${first}\nnot-json\n${final}\n`)});`, async (invocation, dir) => {
		const progress: number[] = [];
		const result = await runDeepseekWorker({
			projectRoot: dir,
			contract: CONTRACT,
			timeoutMs: 2_000,
			invocation,
			onProgress: (update) => progress.push(update.turns),
		});
		assertWorkerSucceeded(result);
		assert.equal(result.exitCode, 0);
		assert.equal(result.provider, "deepseek");
		assert.equal(result.model, "deepseek-v4-flash");
		assert.equal(result.turns, 2);
		assert.match(result.output, /Implemented/);
		assert.equal(result.usage.input, 20);
		assert.equal(result.usage.cacheRead, 40);
		assert.equal(result.usage.cost.total, 0.62);
		assert.equal(result.cacheHitRatio, 2 / 3, "aggregated cache ratio cacheRead/(input+cacheRead) over both turns");
		assert.deepEqual(progress, [1, 2]);
	});
});

test("worker system prompt grants local implementation ownership inside the approved contract and reserves final authority to Sol", () => {
	// Worker-owned: routine local implementation decisions inside the contract.
	assert.match(WORKER_SYSTEM_PROMPT, /You own routine local implementation decisions inside the approved contract/);
	assert.match(WORKER_SYSTEM_PROMPT, /concrete design choices, naming, file structure within the approved scope/);
	assert.match(WORKER_SYSTEM_PROMPT, /how the slice is implemented, tested, and documented/);
	// Sol-owned: requirements, cross-cutting architecture, scope, actual-diff
	// review, final verification/gates, and the verdict.
	assert.match(WORKER_SYSTEM_PROMPT, /The GPT-5\.6 Sol parent owns requirements, cross-cutting architecture, scope, review of the actual diff, final verification and gates, and the final verdict/);
	assert.match(WORKER_SYSTEM_PROMPT, /never acceptance evidence/);
	// Complete-slice duties: investigation, production source changes, tests,
	// docs, write-free recipe checks, and in-scope repair — not a narrow edit.
	assert.match(WORKER_SYSTEM_PROMPT, /Implement the complete delegated slice, not a narrow code edit/);
	assert.match(WORKER_SYSTEM_PROMPT, /Before changing code, inspect the relevant files/);
	assert.match(WORKER_SYSTEM_PROMPT, /Make the production source changes, add the tests and docs/);
	assert.match(WORKER_SYSTEM_PROMPT, /requested write-free declared workbench recipes when available/);
	assert.match(WORKER_SYSTEM_PROMPT, /repair in-scope defects you find/);
	assert.match(WORKER_SYSTEM_PROMPT, /not stubs or TODO shells/);
	// Unchanged hard guards: bounded scope, no recursion, no final gates, no
	// free-form bash.
	assert.match(WORKER_SYSTEM_PROMPT, /Implement only the delegated task and only within the parent-approved paths/);
	assert.match(WORKER_SYSTEM_PROMPT, /Never delegate another worker/);
	assert.match(WORKER_SYSTEM_PROMPT, /Never run final validation gates/);
	assert.match(WORKER_SYSTEM_PROMPT, /Free-form bash is unavailable/);
	// Exact final report sections preserved, and the no-acceptance rule is an
	// explicit prohibition in the prompt — not a banned substring: the prompt
	// itself must state that the worker never claims final PASS/acceptance.
	assert.match(WORKER_SYSTEM_PROMPT, /Finish with exactly these sections:/);
	assert.match(WORKER_SYSTEM_PROMPT, /## Completed\n## Files Changed\n## Verification\n## Remaining Risks/);
	assert.match(WORKER_SYSTEM_PROMPT, /do not claim final PASS or acceptance/, "the prompt must explicitly prohibit claiming final PASS or acceptance");
	assert.match(WORKER_SYSTEM_PROMPT, /report only commands and observed results/);
	assert.match(WORKER_SYSTEM_PROMPT, /Never label an acceptance criterion satisfied, met, passed, accepted, or complete/);
	assert.match(WORKER_SYSTEM_PROMPT, /only Sol maps evidence to criteria/);
	// Stop-and-report boundary: when completion needs an unapproved
	// architecture, security/policy, destructive, or out-of-scope decision,
	// the worker stops and reports instead of guessing or expanding scope.
	assert.match(WORKER_SYSTEM_PROMPT, /unapproved architecture, security\/policy, destructive, or out-of-scope decision/);
	assert.match(WORKER_SYSTEM_PROMPT, /stop and report/);
	assert.match(WORKER_SYSTEM_PROMPT, /instead of guessing or expanding scope/);
});

test("runner pins max model selector and passes a non-recursive worker role contract", async () => {
	const script = `
const facts = JSON.stringify({ argv: process.argv.slice(2), role: process.env.WORKBENCH_AGENT_ROLE, depth: process.env.WORKBENCH_WORKER_DEPTH, paths: JSON.parse(process.env.WORKBENCH_WORKER_ALLOWED_PATHS || "[]"), inheritedModel: process.env.PI_MODEL || null });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "deepseek", model: "deepseek-v4-flash", content: [{ type: "text", text: facts }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
`;
	await withFakeWorker(script, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		const facts = JSON.parse(result.output) as { argv: string[]; role: string; depth: string; paths: string[]; inheritedModel: string | null };
		const modelFlag = facts.argv.indexOf("--model");
		assert.ok(modelFlag >= 0);
		assert.equal(facts.argv[modelFlag + 1], "deepseek/deepseek-v4-flash:max");
		assert.ok(facts.argv.includes("--no-session"), "every worker invocation is ephemeral and cannot resume prior context");
		assert.equal(facts.role, "worker");
		assert.equal(facts.depth, "1");
		assert.deepEqual(facts.paths, CONTRACT.allowedPaths);
		assert.equal(facts.inheritedModel, null, "parent PI_MODEL must not masquerade as the child model");
	});
});

test("runner rejects an oversized task contract before spawning", async () => {
	await assert.rejects(
		runDeepseekWorker({
			projectRoot: process.cwd(),
			contract: { ...CONTRACT, task: "x".repeat(70 * 1024) },
			timeoutMs: 2_000,
			invocation: { command: "/definitely/not/spawned", argsPrefix: [] },
		}),
		/exceeds 65536 bytes/,
	);
});

test("runner fails closed on model drift", async () => {
	const drift = assistantEvent({ provider: "openai-codex", model: "gpt-5.6-sol" });
	await withFakeWorker(`console.log(${JSON.stringify(drift)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assert.match(result.modelMismatch ?? "", /expected deepseek\/deepseek-v4-flash/);
		assert.throws(() => assertWorkerSucceeded(result), /Worker model drift/);
	});
});

test("runner preserves bounded stderr and non-zero exit failures", async () => {
	await withFakeWorker('process.stderr.write("provider unavailable\\n"); process.exit(7);', async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assert.equal(result.exitCode, 7);
		assert.match(result.stderr, /provider unavailable/);
		assert.throws(() => assertWorkerSucceeded(result), /exited with code 7/);
	});
});

test("worker cache summary formatter is deterministic and zero-denominator aware", () => {
	assert.equal(workerCacheHitRatio({ input: 20, cacheRead: 40 }), 2 / 3);
	assert.equal(workerCacheHitRatio({ input: 0, cacheRead: 0 }), null, "zero denominator yields null, never NaN/Infinity");
	assert.equal(workerCacheHitRatio({ input: 0, cacheRead: 5 }), 1);
	assert.equal(formatWorkerCacheSummary({ input: 20, cacheRead: 40 }), "uncached input 20 | cache read 40 | hit ratio 67%");
	assert.equal(formatWorkerCacheSummary({ input: 10, cacheRead: 90 }), "uncached input 10 | cache read 90 | hit ratio 90%");
	assert.equal(formatWorkerCacheSummary({ input: 99999, cacheRead: 1 }), "uncached input 99999 | cache read 1 | hit ratio 0%");
	assert.equal(formatWorkerCacheSummary({ input: 0, cacheRead: 0 }), "uncached input 0 | cache read 0 | hit ratio N/A");
});

test("runner reports null cacheHitRatio when the worker reports no input at all", async () => {
	const zero = assistantEvent({
		usage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	await withFakeWorker(`console.log(${JSON.stringify(zero)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.equal(result.cacheHitRatio, null);
		assert.equal(formatWorkerCacheSummary(result.usage), "uncached input 0 | cache read 0 | hit ratio N/A");
	});
});

test("runner timeout terminates the child and reports timeout honestly", async () => {
	await withFakeWorker("setInterval(() => {}, 1000);", async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 50, invocation });
		assert.equal(result.timedOut, true);
		assert.throws(() => assertWorkerSucceeded(result), /timed out/);
	});
});

test("runner propagates AbortSignal to the child", async () => {
	await withFakeWorker("setInterval(() => {}, 1000);", async (invocation, dir) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		const result = await runDeepseekWorker({
			projectRoot: dir,
			contract: CONTRACT,
			timeoutMs: 2_000,
			signal: controller.signal,
			invocation,
		});
		assert.equal(result.aborted, true);
		assert.throws(() => assertWorkerSucceeded(result), /aborted/);
	});
});

function workerResult(overrides: Partial<WorkerRunResult> = {}): WorkerRunResult {
	return {
		exitCode: 0,
		provider: "deepseek",
		model: "deepseek-v4-flash",
		turns: 1,
		stopReason: "stop",
		output: "## Completed\nImplemented.",
		stderr: "",
		aborted: false,
		timedOut: false,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 20,
			cacheWrite: 0,
			totalTokens: 35,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
		},
		cacheHitRatio: 2 / 3,
		maxContextTokens: 0,
		maxContextRatio: 0,
		softBudgetReached: false,
		hardBudgetExceeded: false,
		compactionCount: 0,
		compactionReasons: [],
		...overrides,
	};
}

/** Full usage object with a chosen totalTokens (positive wins in budget math). */
function usageWith(totalTokens: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		input: 10,
		output: 5,
		cacheRead: 20,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
		...overrides,
	};
}

test("delegated worker presentation exposes usage and cache hit ratio", () => {
	const result = buildDelegateWorkerResult(workerResult(), ["src/**"]);
	const text = result.content[0]?.text ?? "";
	assert.match(text, /uncached input 10/);
	assert.match(text, /cache read 20/);
	assert.match(text, /hit ratio 67%/);
	assert.equal(result.usage.input, 10, "top-level tool usage preserved");
	assert.equal(result.usage.cacheRead, 20);
	assert.equal(result.details.usage.input, 10, "aggregated usage in structured details");
	assert.equal(result.details.usage.cacheRead, 20);
	assert.equal(result.details.cache_hit_ratio, 2 / 3);
	assert.deepEqual(result.details.allowed_paths, ["src/**"]);
});

test("delegated worker zero-denominator usage renders N/A and null", () => {
	const usage = {
		input: 0,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 5,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const result = buildDelegateWorkerResult(workerResult({ usage, cacheHitRatio: null }), []);
	assert.match(result.content[0]?.text ?? "", /hit ratio N\/A/);
	assert.equal(result.details.cache_hit_ratio, null);
});

// ---------------------------------------------------------------------------
// Worker context-budget protection (runner side)
// ---------------------------------------------------------------------------

test("runner tracks max per-message context tokens/ratio and soft-budget reach", async () => {
	const first = assistantEvent({ usage: usageWith(400_000) });
	const soft = assistantEvent({ usage: usageWith(810_000) });
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${first}\n${soft}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result); // soft budget is a steer, not a failure
		assert.equal(result.maxContextTokens, 810_000, "max over per-message tokens");
		assert.equal(result.maxContextRatio, 0.81);
		assert.equal(result.softBudgetReached, true);
		assert.equal(result.hardBudgetExceeded, false);
		assert.equal(result.compactionCount, 0);
		assert.deepEqual(result.compactionReasons, []);
	});
});

test("runner boundary: 799,999 stays under the soft budget, 899,999 is soft only", async () => {
	const under = assistantEvent({ usage: usageWith(799_999) });
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${under}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.equal(result.softBudgetReached, false);
		assert.equal(result.hardBudgetExceeded, false);
	});
	const near = assistantEvent({ usage: usageWith(899_999) });
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${near}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.equal(result.softBudgetReached, true);
		assert.equal(result.hardBudgetExceeded, false);
		assert.equal(result.maxContextTokens, 899_999);
		assert.equal(result.maxContextRatio, 0.899999);
	});
});

test("runner terminates fail-closed at the 900,000-token hard budget", async () => {
	const hard = assistantEvent({ usage: usageWith(900_000) });
	// Stay alive after emitting the event so the runner's termination is what
	// tears the child down (deterministic close with a non-zero exit).
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${hard}\n`)}); setInterval(() => {}, 1000);`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assert.equal(result.hardBudgetExceeded, true);
		assert.equal(result.softBudgetReached, true, "passing the hard stop implies the soft threshold was reached");
		assert.equal(result.exitCode, 1, "child terminated by the runner");
		assert.match(result.errorMessage ?? "", /900000-token hard context budget/);
		assert.throws(() => assertWorkerSucceeded(result), /hard context budget/);
	});
});

test("runner rejects any result with a compaction attempt and counts reasons", async () => {
	const threshold = JSON.stringify({ type: "compaction_start", reason: "threshold" });
	const overflow = JSON.stringify({ type: "compaction_start", reason: "overflow" });
	const final = assistantEvent();
	await withFakeWorker(
		`process.stdout.write(${JSON.stringify(`${threshold}\n${overflow}\n${threshold}\n${final}\n`)});`,
		async (invocation, dir) => {
			const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
			assert.equal(result.compactionCount, 3);
			assert.deepEqual(result.compactionReasons, ["threshold", "overflow"], "distinct reasons in arrival order");
			assert.match(result.errorMessage ?? "", /attempted context compaction/);
			assert.throws(() => assertWorkerSucceeded(result), /attempted context compaction \(threshold, overflow\)/);
		},
	);
});

test("runner fails closed on a compaction attempt even when the child exits 0", async () => {
	const threshold = JSON.stringify({ type: "compaction_start", reason: "threshold" });
	const final = assistantEvent();
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${threshold}\n${final}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assert.equal(result.compactionCount, 1);
		assert.equal(result.hardBudgetExceeded, false);
		assert.throws(() => assertWorkerSucceeded(result), /attempted context compaction \(threshold\)/);
	});
});

test("runner budget tracking ignores malformed usage defensively", async () => {
	const bad = assistantEvent({
		usage: { input: -1, output: "x", cacheRead: Infinity, cacheWrite: 5, totalTokens: -3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${bad}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.equal(result.maxContextTokens, 5, "fallback sums only the non-negative components");
		assert.equal(result.maxContextRatio, 0.000005);
		assert.equal(result.softBudgetReached, false);
		assert.equal(result.hardBudgetExceeded, false);
	});
});

test("delegated worker presentation exposes budget and compaction facts", () => {
	const result = workerResult({
		maxContextTokens: 812_345,
		maxContextRatio: 0.812345,
		softBudgetReached: true,
		hardBudgetExceeded: false,
		compactionCount: 0,
		compactionReasons: [],
	});
	const built = buildDelegateWorkerResult(result, ["src/**"]);
	const text = built.content[0]?.text ?? "";
	assert.match(text, /worker budget : max context 812345 \/ 1000000 \(81\.2%\)/);
	assert.equal(built.details.max_context_tokens, 812_345);
	assert.equal(built.details.max_context_ratio, 0.812345);
	assert.equal(built.details.soft_budget_reached, true);
	assert.equal(built.details.hard_budget_exceeded, false);
	assert.equal(built.details.compaction_count, 0);
	assert.deepEqual(built.details.compaction_reasons, []);
});

test("delegated worker presentation reports a hard-budget stop factually", () => {
	const result = workerResult({
		maxContextTokens: 900_000,
		maxContextRatio: 0.9,
		softBudgetReached: true,
		hardBudgetExceeded: true,
		compactionCount: 0,
		compactionReasons: [],
	});
	const built = buildDelegateWorkerResult(result, []);
	assert.match(built.content[0]?.text ?? "", /worker budget : max context 900000 \/ 1000000 \(90%\)/);
	assert.equal(built.details.hard_budget_exceeded, true);
	assert.equal(built.details.compaction_count, 0);
});
