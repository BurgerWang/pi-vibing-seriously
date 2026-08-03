import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertWorkerSucceeded,
	runDeepseekWorker,
	type PiInvocation,
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
		assert.deepEqual(progress, [1, 2]);
	});
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
