import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildDelegateWorkerResult, MAX_WORKER_REPORT_BYTES, parsedReportToHandoffSummary, parseWorkerReport, type BuildDelegateWorkerResultInput } from "../extensions/workbench-runtime/worker/handoff.ts";
import {
	assertWorkerSucceeded,
	formatWorkerCacheSummary,
	runDeepseekWorker,
	workerCacheHitRatio,
	WORKER_DIAGNOSIS_SYSTEM_PROMPT,
	WORKER_SYSTEM_PROMPT,
	type PiInvocation,
	type WorkerRunResult,
} from "../extensions/workbench-runtime/worker/runner.ts";
import {
	WORKER_CONTRACT_HASH_ENV,
	WORKER_DELEGATION_ID_ENV,
	WORKER_TASK_KIND_ENV,
	type WorkerTaskContract,
} from "../extensions/workbench-runtime/core/worker-policy.ts";
import {
	WORKER_SPEND_DEFAULT_PROFILE,
	WORKER_SPEND_PROFILE_ENV,
} from "../extensions/workbench-runtime/core/worker-spend.ts";
import {
	EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION,
	WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_ENTRY_TYPE,
	WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA,
} from "../extensions/workbench-runtime/core/worker-write-journal-runtime.ts";

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

function journalTelemetryEvent(data: Readonly<Record<string, unknown>>): string {
	return JSON.stringify({
		type: "entry_appended",
		entry: {
			type: "custom",
			customType: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_ENTRY_TYPE,
			data,
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
		// Phase 2 cumulative spend facts: every assistant event increments the
		// spend state exactly once (turns + 1, normalized total/output added).
		assert.equal(result.spendProfile, WORKER_SPEND_DEFAULT_PROFILE, "omitted profile resolves deterministically to standard");
		assert.deepEqual(result.spendState, { turns: 2, totalTokens: 70, outputTokens: 10 });
		assert.equal(result.spendBand, "ok");
		assert.deepEqual(result.spendReasons, []);
		assert.deepEqual(result.spendSoftReached, { turns: false, totalTokens: false, outputTokens: false });
		assert.deepEqual(result.spendHardExceeded, { turns: false, totalTokens: false, outputTokens: false });
		assert.strictEqual(result.writeJournalObservation, EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION);
	});
});

test("runner observes exact worker journal begin and complete entries without retaining identifiers or content", async () => {
	const begin = journalTelemetryEvent({
		schema: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA,
		phase: "begin",
		tool: "edit",
		outcome: "none",
		code: "none",
		revision: 1,
		poisoned: 0,
	});
	const complete = journalTelemetryEvent({
		schema: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA,
		phase: "complete",
		tool: "edit",
		outcome: "succeeded",
		code: "none",
		revision: 2,
		poisoned: 0,
	});
	const final = assistantEvent();
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${begin}\n${complete}\n${final}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.deepEqual(result.writeJournalObservation, {
			state: "complete", tool: "edit", outcome: "succeeded", code: "none", revision: 2,
		});
		assert.deepEqual(Object.keys(result.writeJournalObservation).sort(), ["code", "outcome", "revision", "state", "tool"]);
		assert.equal(Object.isFrozen(result.writeJournalObservation), true);
	});
});

test("runner makes explicit journal failures and malformed matching entries sticky failed observations", async () => {
	const failure = journalTelemetryEvent({
		schema: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA,
		phase: "failure",
		tool: "write",
		outcome: "none",
		code: "journal_read_failed",
		revision: 0,
		poisoned: 1,
	});
	const laterValid = journalTelemetryEvent({
		schema: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA,
		phase: "begin",
		tool: "write",
		outcome: "none",
		code: "none",
		revision: 1,
		poisoned: 0,
	});
	const final = assistantEvent();
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${failure}\n${laterValid}\n${final}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.deepEqual(result.writeJournalObservation, {
			state: "failed", tool: "write", outcome: "none", code: "journal_read_failed", revision: 0,
		});
	});

	const malformed = journalTelemetryEvent({
		schema: WORKER_WRITE_JOURNAL_RUNTIME_TELEMETRY_SCHEMA,
		phase: "begin",
		tool: "edit",
		outcome: "none",
		code: "none",
		revision: 1,
		poisoned: 0,
		privatePath: "PRIVATE_WORKER_PATH",
	});
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${malformed}\n${final}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.deepEqual(result.writeJournalObservation, {
			state: "failed", tool: "none", outcome: "none", code: "invalid", revision: 0,
		});
		assert.equal(JSON.stringify(result.writeJournalObservation).includes("PRIVATE"), false);
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

test("diagnosis system prompt is read-only and keeps acceptance with Sol", () => {
	assert.match(WORKER_DIAGNOSIS_SYSTEM_PROMPT, /strictly read-only diagnosis/);
	assert.match(WORKER_DIAGNOSIS_SYSTEM_PROMPT, /Do not edit, write, create, delete, rename/);
	assert.match(WORKER_DIAGNOSIS_SYSTEM_PROMPT, /configuration, state, ledger, receipt, or artifact/);
	assert.match(WORKER_DIAGNOSIS_SYSTEM_PROMPT, /inspection scope only and never write authority/);
	assert.match(WORKER_DIAGNOSIS_SYSTEM_PROMPT, /mutation is exactly none/);
	assert.match(WORKER_DIAGNOSIS_SYSTEM_PROMPT, /never run a recipe with mutation other than none/);
	assert.match(WORKER_DIAGNOSIS_SYSTEM_PROMPT, /must not claim final PASS or acceptance/);
	assert.match(WORKER_DIAGNOSIS_SYSTEM_PROMPT, /only Sol maps evidence to criteria/);
	assert.match(WORKER_DIAGNOSIS_SYSTEM_PROMPT, /## Files Changed\n- None\./);
});

test("worker system prompt pins the three mandatory execution disciplines (early checkpoint, stopping hygiene, short report)", () => {
	// Discipline 1 — EARLY CHECKPOINT: after relevant-file inspection and
	// before the first write, privately compare planned changed paths /
	// acceptance criteria / verification against the exact contract and the
	// remaining spend; stop/report rather than expand; a known-root-cause
	// repair must not reopen broad diagnosis.
	assert.match(WORKER_SYSTEM_PROMPT, /EARLY CHECKPOINT/);
	assert.match(WORKER_SYSTEM_PROMPT, /after inspecting the relevant files and before the first write/);
	assert.match(WORKER_SYSTEM_PROMPT, /privately compare/);
	assert.match(WORKER_SYSTEM_PROMPT, /planned changed paths, acceptance criteria, and verification/);
	assert.match(WORKER_SYSTEM_PROMPT, /the exact contract and the remaining spend/);
	assert.match(WORKER_SYSTEM_PROMPT, /if the plan does not fit, stop and report to Sol rather than expand/);
	assert.match(WORKER_SYSTEM_PROMPT, /known root cause must not reopen broad diagnosis/);
	// Discipline 2 — STOPPING HYGIENE: before the final response, re-read
	// every changed path; no accidental out-of-scope writes, no stubs/TODO
	// placeholders, no accidental generated artifacts; requested checks
	// reported truthfully; hygiene never triggers unrelated cleanup.
	assert.match(WORKER_SYSTEM_PROMPT, /STOPPING HYGIENE/);
	assert.match(WORKER_SYSTEM_PROMPT, /before your final response, re-read every changed path/);
	assert.match(WORKER_SYSTEM_PROMPT, /no accidental out-of-scope writes/);
	assert.match(WORKER_SYSTEM_PROMPT, /no stubs or TODO placeholders/);
	assert.match(WORKER_SYSTEM_PROMPT, /no accidental generated artifacts/);
	assert.match(WORKER_SYSTEM_PROMPT, /every requested check is reported truthfully/);
	assert.match(WORKER_SYSTEM_PROMPT, /hygiene must not trigger unrelated cleanup/);
	// Discipline 3 — SHORT REPORT: exactly the four final headings; the
	// four-bullet / 240-char cap applies ONLY to Completed, Verification,
	// and Remaining Risks — Files Changed is explicitly exempt and must
	// list EVERY actually changed project-relative path, one exact path per
	// single-line bullet, with no prose (mechanically bounded by the
	// ledger's existing 500 changed-path fail-closed limit; `- None.` when nothing changed);
	// Verification reports only the command and its observed outcome, never
	// logs; no task/criteria repetition.
	assert.match(WORKER_SYSTEM_PROMPT, /SHORT REPORT/);
	assert.match(WORKER_SYSTEM_PROMPT, /keep exactly the four final headings/);
	// The four-bullet / 240-char cap is scoped to the three prose sections.
	assert.match(WORKER_SYSTEM_PROMPT, /Completed, Verification, and Remaining Risks each take at most 4 single-line bullets of at most 240 characters/);
	// Files Changed is explicitly exempt from the cap and must list every
	// actually changed path truthfully, one per single-line bullet.
	assert.match(WORKER_SYSTEM_PROMPT, /Files Changed is exempt from that cap/);
	assert.match(WORKER_SYSTEM_PROMPT, /EVERY actually changed project-relative path/);
	assert.match(WORKER_SYSTEM_PROMPT, /one exact project-relative path per single-line bullet/);
	assert.match(WORKER_SYSTEM_PROMPT, /with no prose/);
	assert.match(WORKER_SYSTEM_PROMPT, /ledger's existing 500 changed-path fail-closed limit/);
	assert.match(WORKER_SYSTEM_PROMPT, /reports only the command and its observed outcome, never logs/);
	assert.match(WORKER_SYSTEM_PROMPT, /never repeat the task or acceptance criteria/);
	assert.match(WORKER_SYSTEM_PROMPT, /- None\./);
	// Negative guard: a global four-bullet cap ("at most 4 single-line
	// bullets per section") would re-impose the Files Changed cap and must
	// fail this test.
	assert.ok(
		!/at most 4 single-line bullets per section/.test(WORKER_SYSTEM_PROMPT),
		"the four-bullet cap must be scoped to Completed/Verification/Remaining Risks, never Files Changed",
	);
	// Structure: the three disciplines appear in fixed order before the final
	// headings block, and the never-acceptance/final-gate rules survive
	// unchanged beside them.
	const indexOf = (needle: string) => WORKER_SYSTEM_PROMPT.indexOf(needle);
	assert.ok(indexOf("EARLY CHECKPOINT") >= 0);
	assert.ok(indexOf("EARLY CHECKPOINT") < indexOf("STOPPING HYGIENE"), "EARLY CHECKPOINT precedes STOPPING HYGIENE");
	assert.ok(indexOf("STOPPING HYGIENE") < indexOf("SHORT REPORT"), "STOPPING HYGIENE precedes SHORT REPORT");
	assert.ok(indexOf("SHORT REPORT") < indexOf("Finish with exactly these sections:"), "SHORT REPORT precedes the final headings block");
	assert.match(WORKER_SYSTEM_PROMPT, /Never run final validation gates/);
	assert.match(WORKER_SYSTEM_PROMPT, /do not claim final PASS or acceptance/);
	assert.match(WORKER_SYSTEM_PROMPT, /## Completed\n## Files Changed\n## Verification\n## Remaining Risks/);
});

test("runner pins max model selector and passes a non-recursive worker role contract", async () => {
	const script = `
const facts = JSON.stringify({ argv: process.argv.slice(2), role: process.env.WORKBENCH_AGENT_ROLE, depth: process.env.WORKBENCH_WORKER_DEPTH, paths: JSON.parse(process.env.WORKBENCH_WORKER_ALLOWED_PATHS || "[]"), taskKind: process.env.${WORKER_TASK_KIND_ENV} || null, inheritedModel: process.env.PI_MODEL || null, spendProfile: process.env.${WORKER_SPEND_PROFILE_ENV} || null });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "deepseek", model: "deepseek-v4-flash", content: [{ type: "text", text: facts }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
`;
	await withFakeWorker(script, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		const facts = JSON.parse(result.output) as { argv: string[]; role: string; depth: string; paths: string[]; taskKind: string | null; inheritedModel: string | null; spendProfile: string | null };
		const modelFlag = facts.argv.indexOf("--model");
		assert.ok(modelFlag >= 0);
		assert.equal(facts.argv[modelFlag + 1], "deepseek/deepseek-v4-flash:max");
		assert.ok(facts.argv.includes("--no-session"), "every worker invocation is ephemeral and cannot resume prior context");
		assert.equal(facts.role, "worker");
		assert.equal(facts.depth, "1");
		assert.deepEqual(facts.paths, CONTRACT.allowedPaths);
		assert.equal(facts.taskKind, "implementation", "omitted task kind is explicitly carried as the compatibility default");
		const toolsFlag = facts.argv.indexOf("--tools");
		assert.ok(facts.argv[toolsFlag + 1]?.split(",").includes("edit"));
		assert.ok(facts.argv[toolsFlag + 1]?.split(",").includes("write"));
		assert.equal(facts.inheritedModel, null, "parent PI_MODEL must not masquerade as the child model");
		assert.equal(facts.spendProfile, "standard", "the runner always writes a valid spend profile into the fixed child env contract");
		assert.equal(result.spendProfile, "standard");
	});
});

test("runner passes an exact validated delegation-v2 runtime identity to the child", async () => {
	const delegationId = "20260820-150000-r1T2";
	const contractHash = "a".repeat(64);
	const script = `
const facts = JSON.stringify({ delegationId: process.env.${WORKER_DELEGATION_ID_ENV} || null, contractHash: process.env.${WORKER_CONTRACT_HASH_ENV} || null });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "deepseek", model: "deepseek-v4-flash", content: [{ type: "text", text: facts }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
`;
	await withFakeWorker(script, async (invocation, dir) => {
		const result = await runDeepseekWorker({
			projectRoot: dir,
			contract: CONTRACT,
			timeoutMs: 2_000,
			invocation,
			runtimeIdentity: { delegationId, contractHash },
		});
		assertWorkerSucceeded(result);
		assert.deepEqual(JSON.parse(result.output), { delegationId, contractHash });
	});
});

test("legacy runner calls strip hostile inherited runtime identity values", async () => {
	const previousDelegation = process.env[WORKER_DELEGATION_ID_ENV];
	const previousContract = process.env[WORKER_CONTRACT_HASH_ENV];
	process.env[WORKER_DELEGATION_ID_ENV] = "HOSTILE_INHERITED_DELEGATION";
	process.env[WORKER_CONTRACT_HASH_ENV] = "HOSTILE_INHERITED_CONTRACT";
	try {
		const script = `
const facts = JSON.stringify({ delegationId: process.env.${WORKER_DELEGATION_ID_ENV} || null, contractHash: process.env.${WORKER_CONTRACT_HASH_ENV} || null });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "deepseek", model: "deepseek-v4-flash", content: [{ type: "text", text: facts }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
`;
		await withFakeWorker(script, async (invocation, dir) => {
			const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
			assertWorkerSucceeded(result);
			assert.deepEqual(JSON.parse(result.output), { delegationId: null, contractHash: null });
		});
	} finally {
		if (previousDelegation === undefined) delete process.env[WORKER_DELEGATION_ID_ENV];
		else process.env[WORKER_DELEGATION_ID_ENV] = previousDelegation;
		if (previousContract === undefined) delete process.env[WORKER_CONTRACT_HASH_ENV];
		else process.env[WORKER_CONTRACT_HASH_ENV] = previousContract;
	}
});

test("malformed runtime identity is rejected before child spawn without echoing raw values", async () => {
	const secret = "PRIVATE_RUNTIME_IDENTITY_MUST_NOT_LEAK";
	const cases = [
		{ delegationId: secret, contractHash: "a".repeat(64) },
		{ delegationId: "20260820-150000-r1T2", contractHash: secret },
		{ delegationId: "20260820-150000-r1T2", contractHash: "a".repeat(64), extra: secret },
	];
	for (const runtimeIdentity of cases) {
		await assert.rejects(
			runDeepseekWorker({
				projectRoot: "/tmp",
				contract: CONTRACT,
				timeoutMs: 2_000,
				invocation: { command: "must-not-spawn", argsPrefix: [] },
				runtimeIdentity: runtimeIdentity as never,
			}),
			(error: Error) => error.message === "Worker runtime identity is invalid" && !error.message.includes(secret),
		);
	}
});

test("diagnosis runner selects the read-only prompt, argv tool matrix, and child env", async () => {
	const script = `
import { readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const promptFlag = argv.indexOf("--append-system-prompt");
const facts = JSON.stringify({ argv, taskKind: process.env.${WORKER_TASK_KIND_ENV} || null, prompt: readFileSync(argv[promptFlag + 1], "utf8") });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "deepseek", model: "deepseek-v4-flash", content: [{ type: "text", text: facts }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
`;
	await withFakeWorker(script, async (invocation, dir) => {
		const result = await runDeepseekWorker({
			projectRoot: dir,
			contract: { ...CONTRACT, taskKind: "diagnosis" },
			timeoutMs: 2_000,
			invocation,
		});
		assertWorkerSucceeded(result);
		const facts = JSON.parse(result.output) as { argv: string[]; taskKind: string | null; prompt: string };
		assert.equal(facts.taskKind, "diagnosis");
		const toolsFlag = facts.argv.indexOf("--tools");
		const tools = facts.argv[toolsFlag + 1]?.split(",") ?? [];
		assert.ok(tools.includes("read"));
		assert.ok(tools.includes("workbench_run_recipe"));
		assert.ok(!tools.includes("edit"));
		assert.ok(!tools.includes("write"));
		assert.equal(facts.prompt, WORKER_DIAGNOSIS_SYSTEM_PROMPT);
	});
});

test("diagnosis counts structured edit/write attempts by stable id and fails malformed ids closed", async () => {
	const first = assistantEvent({
		content: [
			{ type: "toolCall", id: "call-edit", name: "edit", arguments: { secret: "never inspect" } },
			{ type: "toolCall", id: "call-write", name: "write", arguments: {} },
			{ type: "toolCall", id: "call-read", name: "read", arguments: {} },
			{ type: "toolCall", name: "edit", arguments: {} },
			{ type: "toolCall", id: " whitespace ", name: "edit", arguments: {} },
			{ type: "text", text: "edit write in prose must not count" },
		],
		stopReason: "toolUse",
	});
	const second = assistantEvent({
		content: [
			{ type: "toolCall", id: "call-edit", name: "edit", arguments: {} },
			{ type: "toolCall", id: "", name: "write", arguments: {} },
			{ type: "toolCall", id: 7, name: "write", arguments: {} },
			{ type: "text", text: "## Completed\nDiagnosis reported." },
		],
	});
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${first}\n${second}\n`)});`, async (invocation, dir) => {
		const diagnosis = await runDeepseekWorker({
			projectRoot: dir,
			contract: { ...CONTRACT, taskKind: "diagnosis" },
			timeoutMs: 2_000,
			invocation,
		});
		assert.equal(diagnosis.deniedWriteCount, 4, "two valid ids plus fixed malformed edit/write sentinels");
	});
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${first}\n${second}\n`)});`, async (invocation, dir) => {
		const implementation = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assert.equal(implementation.deniedWriteCount, 0, "implementation does not classify its allowed write calls as denied");
	});
});

test("runner rejects malformed task kinds before spawning", async () => {
	await assert.rejects(
		runDeepseekWorker({
			projectRoot: "/tmp",
			contract: { ...CONTRACT, taskKind: "mechanical" as never },
			timeoutMs: 2_000,
			invocation: { command: "must-not-spawn", argsPrefix: [] },
		}),
		/task_kind must be one of/,
	);
});

test("runner passes an explicit spend profile to the child env and records it on the result", async () => {
	const script = `
const facts = JSON.stringify({ spendProfile: process.env.${WORKER_SPEND_PROFILE_ENV} || null });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "deepseek", model: "deepseek-v4-flash", content: [{ type: "text", text: facts }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
`;
	await withFakeWorker(script, async (invocation, dir) => {
		const result = await runDeepseekWorker({
			projectRoot: dir,
			contract: CONTRACT,
			timeoutMs: 2_000,
			invocation,
			spendProfile: "extended",
		});
		assertWorkerSucceeded(result);
		const facts = JSON.parse(result.output) as { spendProfile: string | null };
		assert.equal(facts.spendProfile, "extended", "the explicit profile travels through the fixed child env contract");
		assert.equal(result.spendProfile, "extended");
	});
});

test("the contract budget profile and the runner spendProfile option are one resolved low profile — env, result, and task text all agree", async () => {
	const script = `
const facts = JSON.stringify({ spendProfile: process.env.${WORKER_SPEND_PROFILE_ENV} || null, argv: process.argv.slice(2) });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "deepseek", model: "deepseek-v4-flash", content: [{ type: "text", text: facts }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
`;
	await withFakeWorker(script, async (invocation, dir) => {
		// Production invariant: the index handler resolves the budget profile
		// ONCE and passes that same value into both the contract (ledger and
		// task-text source) and the runner option (enforcement source) — the
		// two can never disagree. This test pins that consistency on an
		// explicit `low` profile.
		const result = await runDeepseekWorker({
			projectRoot: dir,
			contract: { ...CONTRACT, budgetProfile: "low" },
			timeoutMs: 2_000,
			invocation,
			spendProfile: "low",
		});
		assertWorkerSucceeded(result);
		const facts = JSON.parse(result.output) as { spendProfile: string | null; argv: string[] };
		// The task text (the final child argv element) names the SAME resolved
		// profile: Phase 5 adds one deterministic informational line that
		// bounds cumulative spend only and never expands the parent-approved
		// path/scope authority — enforcement stays in the runner and the
		// fixed child env contract.
		const taskText = facts.argv[facts.argv.length - 1] ?? "";
		const taskProfile = /Worker spend-budget profile: (low|standard|extended)/.exec(taskText)?.[1];
		assert.equal(taskProfile, "low", "task text names the resolved low profile");
		assert.match(taskText, /bounds cumulative spend only/, "profile wording bounds cumulative spend only");
		assert.match(taskText, /never expands parent-approved path\/scope authority/, "profile wording never expands parent-approved path/scope authority");
		assert.equal(facts.spendProfile, taskProfile, "child env profile equals the task-text profile");
		assert.equal(result.spendProfile, taskProfile, "result profile equals the task-text profile");
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
		reportText: "## Completed\nImplemented.",
		reportTextOversized: false,
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
		spendProfile: "standard",
		spendState: { turns: 1, totalTokens: 35, outputTokens: 5 },
		spendBand: "ok",
		spendReasons: [],
		spendSoftReached: { turns: false, totalTokens: false, outputTokens: false },
		spendHardExceeded: { turns: false, totalTokens: false, outputTokens: false },
		writeJournalObservation: EMPTY_WORKER_WRITE_JOURNAL_RUNTIME_OBSERVATION,
		...overrides,
		deniedWriteCount: overrides.deniedWriteCount ?? 0,
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

/**
 * Standard bounded-handoff input for the presentation tests. The parsed
 * summary comes from a report whose PREAMBLE prose is never an item — the
 * parent summary must never embed it.
 */
const HANDOFF_REPORT = [
	"PREAMBLE: internal implementation notes that must never be embedded inline.",
	"## Completed",
	"Implemented the slice",
	"## Files Changed",
	"- `src/main.ts` — core change",
	"## Verification",
	"- ran the unit-test recipe",
	"## Remaining Risks",
	"none",
].join("\n");

function handoffInput(overrides: Partial<BuildDelegateWorkerResultInput> = {}): BuildDelegateWorkerResultInput {
	return {
		delegationId: "20260601-120000-abcd",
		provider: "deepseek",
		model: "deepseek-v4-flash",
		status: "success",
		turns: 1,
		exitCode: 0,
		stopReason: "stop",
		changedPaths: ["src/main.ts"],
		usage: {
			input: 10,
			output: 5,
			cacheRead: 20,
			cacheWrite: 0,
			totalTokens: 35,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
		},
		cacheHitRatio: 2 / 3,
		budget: {
			maxContextTokens: 0,
			maxContextRatio: 0,
			softBudgetReached: false,
			hardBudgetExceeded: false,
			compactionCount: 0,
			compactionReasons: [],
		},
		reportPath: ".pi/workbench/delegations/20260601-120000-abcd/worker-report.md",
		summary: parsedReportToHandoffSummary(parseWorkerReport(HANDOFF_REPORT)),
		reviewStatus: "PENDING_REVIEW",
		...overrides,
	};
}

test("delegated worker presentation exposes usage and cache hit ratio (bounded handoff, no report text)", () => {
	const result = buildDelegateWorkerResult(handoffInput());
	const text = result.content[0]?.text ?? "";
	assert.match(text, /uncached input 10/);
	assert.match(text, /cache read 20/);
	assert.match(text, /hit ratio 67%/);
	assert.equal(result.usage.input, 10, "top-level tool usage preserved");
	assert.equal(result.usage.cacheRead, 20);
	const detailsUsage = result.details.usage as { input: number; cacheRead: number };
	assert.equal(detailsUsage.input, 10, "aggregated usage in structured details");
	assert.equal(detailsUsage.cacheRead, 20);
	assert.equal(result.details.cache_hit_ratio, 2 / 3);
	assert.equal(result.details.delegation_id, "20260601-120000-abcd");
	assert.equal(result.details.report_path, ".pi/workbench/delegations/20260601-120000-abcd/worker-report.md");
	assert.ok(text.includes("workbench_review_worker_diff"), "Sol must inspect the actual diff");
	assert.ok(!text.includes("PREAMBLE"), "report prose is never embedded in the parent summary");
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
	const result = buildDelegateWorkerResult(handoffInput({ usage, cacheHitRatio: null }));
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
		// Phase 2: malformed usage contributes zero tokens to the cumulative
		// spend state (never NaN) but the turn still counts exactly once.
		assert.deepEqual(result.spendState, { turns: 1, totalTokens: 5, outputTokens: 0 });
		assert.equal(result.spendBand, "ok");
		assert.deepEqual(result.spendReasons, []);
		assert.deepEqual(result.spendHardExceeded, { turns: false, totalTokens: false, outputTokens: false });
	});
});

test("runner spend: cacheRead counts through the spend policy when totalTokens is missing", async () => {
	// No totalTokens: the per-message total falls back to the non-negative
	// input + output + cacheRead + cacheWrite sum — cacheRead is real spend.
	const noTotal = assistantEvent({
		usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${noTotal}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.deepEqual(result.spendState, { turns: 1, totalTokens: 35, outputTokens: 5 }, "cacheRead counts in the fallback sum");
	});
});

// ---------------------------------------------------------------------------
// Phase 2: cumulative spend accumulation, exact soft/hard boundaries, and
// fail-closed hard stops (worker token-budget repair)
// ---------------------------------------------------------------------------

test("runner spend: exact soft boundaries never fail (turns/total/output)", async () => {
	// Standard soft turns = 24 exactly: band soft, still succeeds.
	const turnsSoft = Array.from({ length: 24 }, () => assistantEvent()).join("\n");
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${turnsSoft}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.equal(result.spendBand, "soft");
		assert.deepEqual(result.spendReasons, ["turns"]);
		assert.deepEqual(result.spendSoftReached, { turns: true, totalTokens: false, outputTokens: false });
		assert.deepEqual(result.spendHardExceeded, { turns: false, totalTokens: false, outputTokens: false });
	});
	// Standard soft total = 3,000,000 exactly (5 x 600,000, per-message below
	// the 800k context soft threshold so context safety stays quiet).
	const totalSoft = Array.from({ length: 5 }, () => assistantEvent({ usage: usageWith(600_000) })).join("\n");
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${totalSoft}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.equal(result.spendBand, "soft");
		assert.deepEqual(result.spendReasons, ["total_tokens"]);
		assert.equal(result.spendHardExceeded.totalTokens, false);
	});
	// Standard soft output = 120,000 exactly (4 x 30,000 output).
	const outputSoft = Array.from({ length: 4 }, () => assistantEvent({ usage: usageWith(30_030, { output: 30_000 }) })).join("\n");
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${outputSoft}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.equal(result.spendBand, "soft");
		assert.deepEqual(result.spendReasons, ["output_tokens"]);
		assert.equal(result.spendHardExceeded.outputTokens, false);
	});
});

test("runner spend: hard turns boundary at exactly 36 terminates fail-closed; 35 stays soft", async () => {
	const thirtyFive = Array.from({ length: 35 }, () => assistantEvent()).join("\n");
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${thirtyFive}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.equal(result.spendBand, "soft");
		assert.deepEqual(result.spendReasons, ["turns"]);
	});
	const thirtySix = Array.from({ length: 36 }, () => assistantEvent()).join("\n");
	await withFakeWorker(
		`process.stdout.write(${JSON.stringify(`${thirtySix}\n`)}); setInterval(() => {}, 1000);`,
		async (invocation, dir) => {
			const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
			assert.equal(result.exitCode, 1, "child terminated by the runner at the exact hard turns boundary");
			assert.equal(result.spendBand, "hard");
			assert.deepEqual(result.spendReasons, ["turns"]);
			assert.equal(result.spendHardExceeded.turns, true);
			assert.match(result.errorMessage ?? "", /turns 36\/36/);
			assert.throws(() => assertWorkerSucceeded(result), /Worker cumulative spend hard budget reached \(profile standard\): turns 36\/36/);
		},
	);
});

test("runner spend: hard total boundary at exactly 5,000,000; one below stays soft", async () => {
	// 9 x 500,000 + 499,999 = 4,999,999: at/above the soft total (3,000,000),
	// one below the hard total — soft, no failure.
	const below = [...Array.from({ length: 9 }, () => 500_000), 499_999].map((t) => assistantEvent({ usage: usageWith(t) })).join("\n");
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${below}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.equal(result.spendBand, "soft");
		assert.deepEqual(result.spendReasons, ["total_tokens"]);
		assert.equal(result.spendHardExceeded.totalTokens, false);
	});
	// 10 x 500,000 = 5,000,000 exactly: hard total reached (`>=` semantics).
	const exact = Array.from({ length: 10 }, () => assistantEvent({ usage: usageWith(500_000) })).join("\n");
	await withFakeWorker(
		`process.stdout.write(${JSON.stringify(`${exact}\n`)}); setInterval(() => {}, 1000);`,
		async (invocation, dir) => {
			const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
			assert.equal(result.exitCode, 1, "child terminated by the runner at the exact hard total boundary");
			assert.equal(result.spendBand, "hard");
			assert.deepEqual(result.spendReasons, ["total_tokens"]);
			assert.equal(result.spendHardExceeded.totalTokens, true);
			assert.match(result.errorMessage ?? "", /total_tokens 5000000\/5000000/);
			assert.throws(() => assertWorkerSucceeded(result), /total_tokens 5000000\/5000000/);
		},
	);
});

test("runner spend: hard output boundary at exactly 200,000; one below stays soft", async () => {
	// 2 x 99,999 output = 199,998: at/above soft output (120,000), one below
	// the hard output (200,000) — soft, no failure.
	const below = [99_999, 99_999].map((o) => assistantEvent({ usage: usageWith(100_030, { output: o }) })).join("\n");
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${below}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.equal(result.spendBand, "soft");
		assert.deepEqual(result.spendReasons, ["output_tokens"]);
		assert.equal(result.spendHardExceeded.outputTokens, false);
	});
	// 2 x 100,000 output = 200,000 exactly: hard output reached.
	const exact = [100_000, 100_000].map((o) => assistantEvent({ usage: usageWith(100_030, { output: o }) })).join("\n");
	await withFakeWorker(
		`process.stdout.write(${JSON.stringify(`${exact}\n`)}); setInterval(() => {}, 1000);`,
		async (invocation, dir) => {
			const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
			assert.equal(result.exitCode, 1, "child terminated by the runner at the exact hard output boundary");
			assert.equal(result.spendBand, "hard");
			assert.deepEqual(result.spendReasons, ["output_tokens"]);
			assert.equal(result.spendHardExceeded.outputTokens, true);
			assert.match(result.errorMessage ?? "", /output_tokens 200000\/200000/);
			assert.throws(() => assertWorkerSucceeded(result), /output_tokens 200000\/200000/);
		},
	);
});

test("runner spend: multi-dimension hard stop lists reasons in the fixed order", async () => {
	// 35 turns of 138,889 tokens each, then one final message that pushes
	// turns to 36, cumulative total to exactly 5,000,000 and cumulative
	// output to 200,175 — all three dimensions hard at the same message.
	// Every per-message total stays below 800,000 so context safety stays
	// quiet (per-message context never reaches the 80%/90% thresholds).
	const small = Array.from({ length: 35 }, () => assistantEvent({ usage: usageWith(138_889) })).join("\n");
	const final = assistantEvent({ usage: usageWith(138_885, { output: 200_000 }) });
	await withFakeWorker(
		`process.stdout.write(${JSON.stringify(`${small}\n${final}\n`)}); setInterval(() => {}, 1000);`,
		async (invocation, dir) => {
			const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
			assert.equal(result.spendBand, "hard");
			assert.deepEqual(result.spendReasons, ["turns", "total_tokens", "output_tokens"], "fixed reason order — never alphabetical");
			assert.deepEqual(result.spendHardExceeded, { turns: true, totalTokens: true, outputTokens: true });
			assert.match(
				result.errorMessage ?? "",
				/turns 36\/36, total_tokens 5000000\/5000000, output_tokens 200175\/200000/,
			);
			assert.throws(() => assertWorkerSucceeded(result), /turns 36\/36, total_tokens 5000000\/5000000, output_tokens 200175\/200000/);
		},
	);
});

test("runner spend: hard stop fails closed even when the child would exit 0", async () => {
	// The child emits 10 x 500,000 = exactly the hard total (5,000,000) and
	// exits 0 on its own (natural completion). Per-message totals stay below
	// 800,000 so the hard CONTEXT budget never fires. The runner may tear the
	// child down first or observe the natural exit — either way the recorded
	// spend facts are hard and assertWorkerSucceeded fails closed with the
	// deterministic hard-stop message, outranking the ordinary exit text.
	const hard = Array.from({ length: 10 }, () => assistantEvent({ usage: usageWith(500_000) })).join("\n");
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${hard}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assert.equal(result.spendBand, "hard");
		assert.deepEqual(result.spendReasons, ["total_tokens"]);
		assert.equal(result.spendHardExceeded.totalTokens, true);
		assert.throws(() => assertWorkerSucceeded(result), /total_tokens 5000000\/5000000/);
	});
});

test("runner spend: low and extended profiles enforce their exact limits", async () => {
	// low hard turns = 12: the 12th turn terminates the child fail-closed.
	const lowTurns = Array.from({ length: 12 }, () => assistantEvent()).join("\n");
	await withFakeWorker(
		`process.stdout.write(${JSON.stringify(`${lowTurns}\n`)}); setInterval(() => {}, 1000);`,
		async (invocation, dir) => {
			const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation, spendProfile: "low" });
			assert.equal(result.spendProfile, "low");
			assert.equal(result.spendBand, "hard");
			assert.deepEqual(result.spendReasons, ["turns"]);
			assert.match(result.errorMessage ?? "", /profile low.*turns 12\/12/);
			assert.throws(() => assertWorkerSucceeded(result), /profile low.*turns 12\/12/);
		},
	);
	// low hard total = 1,250,000 exactly (2 x 625,000).
	const lowTotal = [625_000, 625_000].map((t) => assistantEvent({ usage: usageWith(t) })).join("\n");
	await withFakeWorker(
		`process.stdout.write(${JSON.stringify(`${lowTotal}\n`)}); setInterval(() => {}, 1000);`,
		async (invocation, dir) => {
			const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation, spendProfile: "low" });
			assert.equal(result.spendBand, "hard");
			assert.deepEqual(result.spendReasons, ["total_tokens"]);
			assert.match(result.errorMessage ?? "", /total_tokens 1250000\/1250000/);
		},
	);
	// extended hard turns = 64: the 64th turn terminates the child fail-closed.
	const extTurns = Array.from({ length: 64 }, () => assistantEvent()).join("\n");
	await withFakeWorker(
		`process.stdout.write(${JSON.stringify(`${extTurns}\n`)}); setInterval(() => {}, 1000);`,
		async (invocation, dir) => {
			const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation, spendProfile: "extended" });
			assert.equal(result.spendProfile, "extended");
			assert.equal(result.spendBand, "hard");
			assert.deepEqual(result.spendReasons, ["turns"]);
			assert.match(result.errorMessage ?? "", /turns 64\/64/);
			assert.throws(() => assertWorkerSucceeded(result), /profile extended.*turns 64\/64/);
		},
	);
});

test("delegated worker presentation exposes budget and compaction facts", () => {
	const built = buildDelegateWorkerResult(
		handoffInput({
			budget: {
				maxContextTokens: 812_345,
				maxContextRatio: 0.812345,
				softBudgetReached: true,
				hardBudgetExceeded: false,
				compactionCount: 0,
				compactionReasons: [],
			},
		}),
	);
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
	const built = buildDelegateWorkerResult(
		handoffInput({
			budget: {
				maxContextTokens: 900_000,
				maxContextRatio: 0.9,
				softBudgetReached: true,
				hardBudgetExceeded: true,
				compactionCount: 0,
				compactionReasons: [],
			},
		}),
	);
	assert.match(built.content[0]?.text ?? "", /worker budget : max context 900000 \/ 1000000 \(90%\)/);
	assert.equal(built.details.hard_budget_exceeded, true);
	assert.equal(built.details.compaction_count, 0);
});

/**
 * Phase 4: progress serialized content must be numeric-only — finite
 * normalized counters, the fixed ok|soft|hard band, and the pinned
 * provider/model identity; never worker text, report text, tool arguments,
 * reasons, patches, logs, or error prose. `forbiddenTexts` are the assistant
 * texts used by the test fixtures that must never appear in any tuple.
 */
function assertNumericOnlyProgress(updates: Array<Record<string, unknown>>, forbiddenTexts: string[]): void {
	const serialized = JSON.stringify(updates);
	for (const text of forbiddenTexts) {
		assert.ok(!serialized.includes(text), `progress must never carry assistant text: ${text.slice(0, 40)}`);
	}
	for (const token of ["lastText", "## Completed", "toolUse", "argument", "patch", "stderr", "reason", "error"]) {
		assert.ok(!serialized.includes(token), `progress must never carry ${token}`);
	}
	for (const update of updates) {
		const band = update.spendBand;
		assert.ok(band === "ok" || band === "soft" || band === "hard", `spendBand is only ok|soft|hard, got ${String(band)}`);
		for (const key of [
			"turns", "totalTokens", "outputTokens", "currentToolTextBytes", "collapsedToolResults", "turnReservedBytes",
		]) {
			const value = update[key];
			assert.ok(typeof value === "number" && Number.isFinite(value), `${key} is a finite number, got ${String(value)}`);
		}
	}
}

test("progress callbacks expose spend and output-control numeric facts plus provider/model — never lastText or worker text", async () => {
	const first = assistantEvent({ content: [{ type: "text", text: "working" }], stopReason: "toolUse" });
	const final = assistantEvent({ content: [{ type: "text", text: "## Completed\nfinal report body" }] });
	const updates: Array<Record<string, unknown>> = [];
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${first}\n${final}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({
			projectRoot: dir,
			contract: CONTRACT,
			timeoutMs: 2_000,
			invocation,
			onProgress: (progress) => updates.push({ ...progress }),
		});
		assertWorkerSucceeded(result);
		// Phase 4: the final progress tuple equals the final result spend facts.
		const last = updates[updates.length - 1]!;
		assert.deepEqual(
			{ turns: last.turns, totalTokens: last.totalTokens, outputTokens: last.outputTokens, spendBand: last.spendBand },
			{ turns: result.spendState.turns, totalTokens: result.spendState.totalTokens, outputTokens: result.spendState.outputTokens, spendBand: result.spendBand },
			"final progress counters match the final WorkerRunResult spend facts",
		);
	});
	assert.equal(updates.length, 2);
	for (const update of updates) {
		assert.equal(
			Object.keys(update).sort().join(","),
			"collapsedToolResults,currentToolTextBytes,model,outputTokens,provider,spendBand,totalTokens,turnReservedBytes,turns",
			"WorkerProgress exposes only fixed spend/output-control numbers and provider/model",
		);
		assert.ok(!("lastText" in update), "lastText is removed from progress");
	}
	// Exact cumulative values after each processed assistant message (each
	// event carries totalTokens 35 / output 5, so totals accumulate 35→70 and
	// 5→10; band stays ok under the standard profile).
	assert.deepEqual(updates[0], {
		turns: 1,
		totalTokens: 35,
		outputTokens: 5,
		spendBand: "ok",
		currentToolTextBytes: 0,
		collapsedToolResults: 0,
		turnReservedBytes: 0,
		provider: "deepseek",
		model: "deepseek-v4-flash",
	});
	assert.deepEqual(updates[1], {
		turns: 2,
		totalTokens: 70,
		outputTokens: 10,
		spendBand: "ok",
		currentToolTextBytes: 0,
		collapsedToolResults: 0,
		turnReservedBytes: 0,
		provider: "deepseek",
		model: "deepseek-v4-flash",
	});
	assertNumericOnlyProgress(updates, ["working", "final report body"]);
});

test("progress counters stay finite and normalized under cacheRead fallback and malformed usage", async () => {
	// No totalTokens: the per-message total falls back to the non-negative
	// input + output + cacheRead + cacheWrite sum (35) — cacheRead counts.
	const cacheFallback = assistantEvent({
		usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	// Malformed counters: negative/Infinity/string values contribute zero
	// (fallback total = cacheWrite 5 only; output = 0) — never NaN.
	const malformed = assistantEvent({
		usage: { input: -1, output: "x", cacheRead: Infinity, cacheWrite: 5, totalTokens: -3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	const updates: Array<Record<string, unknown>> = [];
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${cacheFallback}\n${malformed}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({
			projectRoot: dir,
			contract: CONTRACT,
			timeoutMs: 2_000,
			invocation,
			onProgress: (progress) => updates.push({ ...progress }),
		});
		assertWorkerSucceeded(result);
		assert.deepEqual(result.spendState, { turns: 2, totalTokens: 40, outputTokens: 5 });
		assert.equal(result.spendBand, "ok");
	});
	assert.deepEqual(updates[0], {
		turns: 1,
		totalTokens: 35,
		outputTokens: 5,
		spendBand: "ok",
		currentToolTextBytes: 0,
		collapsedToolResults: 0,
		turnReservedBytes: 0,
		provider: "deepseek",
		model: "deepseek-v4-flash",
	});
	assert.deepEqual(updates[1], {
		turns: 2,
		totalTokens: 40,
		outputTokens: 5,
		spendBand: "ok",
		currentToolTextBytes: 0,
		collapsedToolResults: 0,
		turnReservedBytes: 0,
		provider: "deepseek",
		model: "deepseek-v4-flash",
	});
	assertNumericOnlyProgress(updates, []);
});

test("progress band transitions ok → soft at the exact soft boundary and matches the final spend facts", async () => {
	// Standard soft turns = 24 exactly: the 24th event's progress tuple is
	// the first with band soft; every tuple before it is ok.
	const events = Array.from({ length: 24 }, () => assistantEvent()).join("\n");
	const updates: Array<Record<string, unknown>> = [];
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${events}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({
			projectRoot: dir,
			contract: CONTRACT,
			timeoutMs: 2_000,
			invocation,
			onProgress: (progress) => updates.push({ ...progress }),
		});
		assertWorkerSucceeded(result); // soft is a steer, not a failure
		assert.equal(result.spendBand, "soft");
		assert.equal(updates.length, 24);
		assert.equal(updates[22]!.spendBand, "ok", "the 23rd tuple is still ok");
		assert.equal(updates[23]!.spendBand, "soft", "the 24th tuple is the soft transition");
		const last = updates[23]!;
		assert.deepEqual(
			{ turns: last.turns, totalTokens: last.totalTokens, outputTokens: last.outputTokens, spendBand: last.spendBand },
			{ turns: result.spendState.turns, totalTokens: result.spendState.totalTokens, outputTokens: result.spendState.outputTokens, spendBand: result.spendBand },
			"final soft progress tuple equals the final WorkerRunResult spend facts",
		);
	});
	assertNumericOnlyProgress(updates, []);
});

test("progress at the exact hard boundary matches the final spend facts (fail-closed outcome)", async () => {
	// Standard hard turns = 36 exactly: the runner terminates fail-closed on
	// the 36th event, and the LAST progress tuple still reports the exact
	// cumulative counters and the hard band of the final result.
	const events = Array.from({ length: 36 }, () => assistantEvent()).join("\n");
	const updates: Array<Record<string, unknown>> = [];
	await withFakeWorker(
		`process.stdout.write(${JSON.stringify(`${events}\n`)}); setInterval(() => {}, 1000);`,
		async (invocation, dir) => {
			const result = await runDeepseekWorker({
				projectRoot: dir,
				contract: CONTRACT,
				timeoutMs: 2_000,
				invocation,
				onProgress: (progress) => updates.push({ ...progress }),
			});
			assert.equal(result.spendBand, "hard");
			assert.deepEqual(result.spendReasons, ["turns"]);
			assert.throws(() => assertWorkerSucceeded(result), /turns 36\/36/);
			assert.equal(updates.length, 36);
			const last = updates[35]!;
			assert.deepEqual(
				{ turns: last.turns, totalTokens: last.totalTokens, outputTokens: last.outputTokens, spendBand: last.spendBand },
				{ turns: result.spendState.turns, totalTokens: result.spendState.totalTokens, outputTokens: result.spendState.outputTokens, spendBand: result.spendBand },
				"final hard-boundary progress tuple equals the final WorkerRunResult spend facts",
			);
			assert.equal(last.turns, 36);
			assert.equal(last.spendBand, "hard");
			assertNumericOnlyProgress(updates, []);
		},
	);
});

test("runner retains the complete final assistant text for the durable report artifact", async () => {
	const body = "## Completed\n" + "detailed implementation narrative\n".repeat(199) + "detailed implementation narrative";
	const final = assistantEvent({ content: [{ type: "text", text: body }] });
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${final}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.equal(result.reportText, body, "complete final assistant text retained for worker-report.md");
		assert.equal(result.reportTextOversized, false);
	});
});

test("runner retains the COMPLETE final assistant text (never pre-truncated) and flags oversize from raw bytes", async () => {
	const huge = assistantEvent({ content: [{ type: "text", text: "x".repeat(MAX_WORKER_REPORT_BYTES + 1000) }] });
	await withFakeWorker(`process.stdout.write(${JSON.stringify(`${huge}\n`)});`, async (invocation, dir) => {
		const result = await runDeepseekWorker({ projectRoot: dir, contract: CONTRACT, timeoutMs: 2_000, invocation });
		assertWorkerSucceeded(result);
		assert.equal(result.reportTextOversized, true, "oversized final text is flagged from the RAW bytes");
		assert.equal(
			result.reportText.length,
			MAX_WORKER_REPORT_BYTES + 1000,
			"the complete final text is retained in process memory — redaction first, cap + marker only in the ledger",
		);
	});
});
