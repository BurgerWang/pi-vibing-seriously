import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import * as ts from "typescript";

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import {
	collectAfterFacts,
	collectGitFacts,
	createDelegationLedger,
	finishDelegationLedger,
	makeDelegationId,
	type LedgerWorkerFacts,
} from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import { DELEGATION_STATE_ENTRY_TYPE, serializeDelegationState } from "../extensions/workbench-runtime/core/delegation-state.ts";
import {
	COMMANDER_HISTORY_MAX_BYTES,
	COMMANDER_TURN_MAX_BYTES,
	COMPARE_RESULT_MAX_BYTES,
	COMPARE_RESULT_MAX_LINES,
	DEFAULT_RESULT_MAX_BYTES,
	DEFAULT_RESULT_MAX_LINES,
	DETAILS_MAX_BYTES,
	DIFF_REVIEW_RESULT_MAX_BYTES,
	DIFF_REVIEW_RESULT_MAX_LINES,
	ERROR_RESULT_MAX_BYTES,
	HISTORY_MAX_TOOL_BUNDLES,
	MAX_TOOL_CALLS_PER_TURN,
	NATIVE_READ_MAX_BYTES,
	NATIVE_READ_MAX_FILE_LINES,
	NATIVE_READ_MAX_TOTAL_LINES,
	RUN_LOG_RESULT_MAX_BYTES,
	RUN_LOG_RESULT_MAX_LINES,
	STREAM_UPDATE_MAX_BYTES,
	WORKER_HISTORY_MAX_BYTES,
	WORKER_TURN_MAX_BYTES,
	clampWholeResultText,
} from "../extensions/workbench-runtime/core/output-policy.ts";
import { WORKBENCH_TOOL_METADATA } from "../extensions/workbench-runtime/core/tool-catalog.ts";
import { spawnExec, withTempDir } from "./helpers.ts";

const encoder = new TextEncoder();

function bytes(text: string): number {
	return encoder.encode(text).length;
}

function lines(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

function hasLoneSurrogate(text: string): boolean {
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return true;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return true;
		}
	}
	return false;
}

test("R0 hard caps are compile-time constants with the approved values", () => {
	assert.deepEqual(
		{
			nativeRead: [NATIVE_READ_MAX_BYTES, NATIVE_READ_MAX_FILE_LINES, NATIVE_READ_MAX_TOTAL_LINES],
			defaultResult: [DEFAULT_RESULT_MAX_BYTES, DEFAULT_RESULT_MAX_LINES],
			runLog: [RUN_LOG_RESULT_MAX_BYTES, RUN_LOG_RESULT_MAX_LINES],
			diffReview: [DIFF_REVIEW_RESULT_MAX_BYTES, DIFF_REVIEW_RESULT_MAX_LINES],
			compare: [COMPARE_RESULT_MAX_BYTES, COMPARE_RESULT_MAX_LINES],
			error: ERROR_RESULT_MAX_BYTES,
			commander: [COMMANDER_TURN_MAX_BYTES, COMMANDER_HISTORY_MAX_BYTES],
			worker: [WORKER_TURN_MAX_BYTES, WORKER_HISTORY_MAX_BYTES],
			details: DETAILS_MAX_BYTES,
			streamUpdate: STREAM_UPDATE_MAX_BYTES,
			calls: MAX_TOOL_CALLS_PER_TURN,
			bundles: HISTORY_MAX_TOOL_BUNDLES,
		},
		{
			nativeRead: [12_288, 240, 252],
			defaultResult: [16_384, 240],
			runLog: [32_768, 400],
			diffReview: [32_768, 400],
			compare: [32_768, 400],
			error: 8_192,
			commander: [65_536, 98_304],
			worker: [49_152, 65_536],
			details: 8_192,
			streamUpdate: 4_096,
			calls: 16,
			bundles: 128,
		},
	);
});

test("R0 clamp preserves an exact byte and line boundary", () => {
	const exact = `${"x".repeat(59)}\n${"y".repeat(60)}`;
	assert.equal(bytes(exact), 120);
	assert.equal(lines(exact), 2);
	const result = clampWholeResultText(exact, { maxBytes: 120, maxLines: 2 });
	assert.equal(result.text, exact);
	assert.equal(result.truncated, false);
	assert.equal(result.failed, false);
});

test("R0 clamp is Unicode/code-point safe and removes lone surrogates", () => {
	const input = `${"汉🙂".repeat(80)}\ud800TAIL`;
	const result = clampWholeResultText(input, { maxBytes: 180, maxLines: 10 });
	assert.equal(result.truncated, true);
	assert.ok(bytes(result.text) <= 180);
	assert.equal(hasLoneSurrogate(result.text), false);
	assert.ok(!result.text.endsWith("\ud800"));
	assert.ok(result.text.includes("[workbench-output truncated"));
});

test("R0 clamp enforces the line cap and counts its marker inside both caps", () => {
	const result = clampWholeResultText(Array.from({ length: 30 }, (_, index) => `line-${index}`).join("\n"), {
		maxBytes: 160,
		maxLines: 5,
	});
	assert.equal(result.truncated, true);
	assert.ok(bytes(result.text) <= 160, `bytes=${bytes(result.text)}`);
	assert.ok(lines(result.text) <= 5, `lines=${lines(result.text)}`);
	assert.match(result.text.split("\n").at(-1) ?? "", /^\[workbench-output truncated /);
	assert.equal(result.shownBytes, bytes(result.text));
	assert.equal(result.shownLines, lines(result.text));
});

test("R0 clamp fails closed to a fixed bounded error", () => {
	const hostile = { toString(): string { throw new Error("must not escape"); } };
	const result = clampWholeResultText(hostile, { maxBytes: 96, maxLines: 1 });
	assert.equal(result.failed, true);
	assert.equal(result.truncated, true);
	assert.match(result.text, /^workbench output control failure/);
	assert.ok(bytes(result.text) <= 96);
	assert.ok(lines(result.text) <= 1);
	assert.doesNotMatch(result.text, /must not escape/);
});

test("R0 clamp defaults only omitted caps and never amplifies invalid or explicit lower caps", () => {
	const omitted = clampWholeResultText("kept");
	assert.equal(omitted.text, "kept", "omitted options use policy defaults");

	for (const maxBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
		const result = clampWholeResultText("must not escape", { maxBytes, maxLines: 10 });
		assert.equal(result.text, "", `invalid/lower maxBytes=${String(maxBytes)} fails closed to zero output`);
		assert.equal(result.shownBytes, 0);
	}
	for (const maxLines of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
		const result = clampWholeResultText("must not escape", { maxBytes: 100, maxLines });
		assert.equal(result.text, "", `invalid/lower maxLines=${String(maxLines)} fails closed to zero output`);
		assert.equal(result.shownLines, 0);
	}

	for (const maxBytes of [1, 2, 7, 31]) {
		const result = clampWholeResultText("🙂".repeat(100), { maxBytes, maxLines: 1 });
		assert.ok(bytes(result.text) <= maxBytes, `caller byte cap ${maxBytes} was not enlarged`);
		assert.ok(lines(result.text) <= 1);
	}

	const throwingCaps = Object.defineProperty({ maxLines: 10 }, "maxBytes", {
		get(): never {
			throw new Error("hostile cap getter");
		},
	}) as { maxBytes: number; maxLines: number };
	assert.equal(clampWholeResultText("must not escape", throwingCaps).text, "", "throwing cap getter fails closed");
});

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	details: Record<string, unknown>;
}

interface RegisteredTool {
	name: string;
	executionMode?: string;
	execute?: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<ToolResult>;
}

interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

type TestExec = (command: string, args: string[], options?: { cwd?: string; timeout?: number; signal?: AbortSignal }) => Promise<ExecResult>;

interface RuntimeStub {
	tools: Map<string, RegisteredTool>;
	events: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	entries: Array<{ type: string; customType: string; data: unknown }>;
	activeTools: string[];
}

function makeRuntimeStub(exec: TestExec = async () => ({ code: 1, stdout: "", stderr: "", killed: false })): RuntimeStub & ExtensionAPI {
	const stub: RuntimeStub & ExtensionAPI = {
		tools: new Map<string, RegisteredTool>(),
		events: new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>(),
		entries: [] as Array<{ type: string; customType: string; data: unknown }>,
		activeTools: [] as string[],
		registerCommand: () => {},
		registerTool: (definition: RegisteredTool) => stub.tools.set(definition.name, definition),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const handlers = stub.events.get(event) ?? [];
			handlers.push(handler);
			stub.events.set(event, handlers);
		},
		appendEntry: (customType: string, data: unknown) => stub.entries.push({ type: "custom", customType, data }),
		sendMessage: () => {},
		sendUserMessage: () => {},
		setActiveTools: (names: string[]) => {
			stub.activeTools = [...names];
		},
		getActiveTools: () => [...stub.activeTools],
		getAllTools: () => [...stub.tools.values()],
		getThinkingLevel: () => "high",
		exec,
	} as unknown as RuntimeStub & ExtensionAPI;
	return stub;
}

function trustedContext(root: string, entries: unknown[] = []): ExtensionCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: root,
		isProjectTrusted: () => true,
		sessionManager: {
			getEntries: () => entries,
			getSessionFile: () => `${root}/session.jsonl`,
			getSessionId: () => "context-output-r0-test",
		} as unknown as ExtensionContext["sessionManager"],
		model: undefined,
		thinkingLevel: undefined,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => false,
		} as unknown as ExtensionContext["ui"],
		signal: undefined,
	} as unknown as ExtensionCommandContext;
}

function registeredTool(stub: RuntimeStub, name: string): Required<Pick<RegisteredTool, "execute">> & RegisteredTool {
	const tool = stub.tools.get(name);
	assert.ok(tool?.execute, `${name} registered with execute`);
	return tool as Required<Pick<RegisteredTool, "execute">> & RegisteredTool;
}

function toolText(result: ToolResult): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

function assertToolTextWithin(result: ToolResult, maxBytes: number, maxLines: number, label: string): string {
	const text = toolText(result);
	assert.ok(bytes(text) <= maxBytes, `${label}: bytes=${bytes(text)} cap=${maxBytes}`);
	assert.ok(lines(text) <= maxLines, `${label}: lines=${lines(text)} cap=${maxLines}`);
	return text;
}

test("R3 keeps only delegations and reviews sequential while read-only tools may batch", () => {
	const stub = makeRuntimeStub();
	workbenchRuntime(stub);
	for (const name of [
		"workbench_read_run",
		"workbench_read_gate",
		"workbench_list_gates",
		"workbench_compare_runs",
	]) {
		assert.equal(stub.tools.get(name)?.executionMode, undefined, `${name} is batch-authorizable read-only work`);
	}
	assert.equal(stub.tools.get("workbench_delegate_worker")?.executionMode, "sequential", "delegation stays sequential");
	assert.equal(stub.tools.get("workbench_review_worker_diff")?.executionMode, "sequential", "review stays sequential");
});

test("R3 batching guideline names only the authorized read-only batch surface", () => {
	const guideline = WORKBENCH_TOOL_METADATA.workbench_read_run.promptGuidelines.find((item) => item.includes("known-independent read-only"));
	assert.ok(guideline, "read-run carries the final batching guideline");
	assert.equal(
		guideline,
		"Batch 2+ known-independent read-only calls only when every call is read, grep, find, ls, workbench_project_inspect, workbench_read_run, workbench_read_gate, workbench_list_gates, or workbench_compare_runs and the runtime turn budget authorizes every call; dependent calls, writes, delegations, reviews, and final recipe/gate execution stay sequential.",
	);
	for (const name of [
		"read",
		"grep",
		"find",
		"ls",
		"workbench_project_inspect",
		"workbench_read_run",
		"workbench_read_gate",
		"workbench_list_gates",
		"workbench_compare_runs",
	]) {
		assert.ok(guideline.includes(name), `${name} is explicitly authorized for independent read-only batching`);
	}
	assert.match(guideline, /delegations, reviews, and final recipe\/gate execution stay sequential/);
	assert.ok(!guideline.includes("workbench_review_worker_diff"), "review is not presented as batch-authorized");
});

test("registered read-run bounds huge invalid ids, logs/all output, and thrown runtime errors at one final boundary", async () => {
	const stub = makeRuntimeStub();
	workbenchRuntime(stub);
	const readRun = registeredTool(stub, "workbench_read_run");
	const hugeInvalidId = "x".repeat(100_000);
	const invalid = await readRun.execute("call-invalid", { run_id: hugeInvalidId }, undefined, undefined, trustedContext(process.cwd()));
	const invalidText = assertToolTextWithin(invalid, RUN_LOG_RESULT_MAX_BYTES, RUN_LOG_RESULT_MAX_LINES, "invalid run id");
	assert.match(invalidText, /\[workbench-output truncated /);

	const throwingContext = {
		isProjectTrusted: () => true,
		get cwd(): never {
			throw new Error("runtime-path-failure-" + "z".repeat(100_000));
		},
	} as unknown as ExtensionContext;
	const failed = await readRun.execute("call-failure", { run_id: "20260812-120000-R0e1" }, undefined, undefined, throwingContext);
	const failedText = assertToolTextWithin(failed, RUN_LOG_RESULT_MAX_BYTES, RUN_LOG_RESULT_MAX_LINES, "caught runtime error");
	assert.match(failedText, /\[workbench-output truncated /);

	await withTempDir(async (root) => {
		const runId = "20260812-120000-R0l1";
		const runDir = join(root, CONFIG_DIR_NAME, "workbench", "runs", runId);
		await mkdir(runDir, { recursive: true });
		const manifest = {
			schema_version: 1,
			run_id: runId,
			recipe: "context-output-fixture",
			profile: "generic",
			started_at: "2026-08-12T12:00:00.000Z",
			finished_at: "2026-08-12T12:00:01.000Z",
			duration_ms: 1_000,
			cwd: root,
			argv: ["fixture"],
			exit_code: 0,
			timed_out: false,
			cancelled: false,
			git_commit: null,
			git_dirty: false,
			artifact_paths: [],
			stdout_truncated: false,
			stderr_truncated: false,
			mode: "DEV",
			expected_exit_codes: [0],
			declared_writes: [],
			environment_names: [],
			validation_components: [],
			cache_request_mode: "no-cache",
		};
		const hugeLog = Array.from({ length: 2_500 }, (_, index) => `line-${index}-${"界🙂".repeat(80)}`).join("\n");
		await Promise.all([
			writeFile(join(runDir, "manifest.json"), JSON.stringify(manifest), "utf8"),
			writeFile(join(runDir, "stdout.log"), hugeLog, "utf8"),
			writeFile(join(runDir, "stderr.log"), hugeLog, "utf8"),
		]);
		const logs = await readRun.execute(
			"call-logs",
			{ run_id: runId, include: "all", max_lines: 2_000, max_bytes: 512_000 },
			undefined,
			undefined,
			trustedContext(root),
		);
		const logText = assertToolTextWithin(logs, RUN_LOG_RESULT_MAX_BYTES, RUN_LOG_RESULT_MAX_LINES, "logs/all result");
		assert.match(logText, /\[workbench-run-log-page v1\]/, "the run-log page is itself the bounded protocol result");
		assert.match(logText, /full_log_inlined=false/);
		assert.match(logText, /previous_cursor="wbcur1\./, "omitted earlier bytes have a continuation cursor");
	});
});

const REVIEW_NOW = "2026-08-12T12:00:00.000Z";

async function git(repo: string, args: string[]): Promise<void> {
	const result = await spawnExec("git", args, { cwd: repo });
	assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

function reviewWorkerFacts(): LedgerWorkerFacts {
	return {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		status: "success",
		exitCode: 0,
		turns: 1,
		stopReason: "done",
		errorMessage: null,
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		cacheHitRatio: null,
		budget: {
			maxContextTokens: 400_000,
			maxContextRatio: 0.4,
			softBudgetReached: false,
			hardBudgetExceeded: false,
			compactionCount: 0,
			compactionReasons: [],
		},
		reportSummary: "done",
	};
}

async function fireSessionStart(stub: RuntimeStub, root: string, entries: unknown[]): Promise<void> {
	const handlers = stub.events.get("session_start") ?? [];
	assert.ok(handlers.length > 0, "session_start registered");
	for (const handler of handlers) {
		await handler({ reason: "reload" }, trustedContext(root, entries));
	}
}

test("registered diff-review bounds both a real successful review and a huge returned error", async () => {
	await withTempDir(async (root) => {
		await git(root, ["init", "-q"]);
		await git(root, ["config", "user.email", "test@example.com"]);
		await git(root, ["config", "user.name", "Workbench Test"]);
		await git(root, ["config", "commit.gpgsign", "false"]);
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "main.ts"), "export const value = 1;\n", "utf8");
		await git(root, ["add", "-A"]);
		await git(root, ["commit", "-q", "-m", "baseline"]);

		const before = await collectGitFacts(root, spawnExec);
		const delegationId = makeDelegationId(new Date(REVIEW_NOW));
		const created = await createDelegationLedger(
			root,
			delegationId,
			{ task: "large bounded review", allowedPaths: ["src/**"], acceptanceCriteria: [], verification: [], timeoutSeconds: 1_800 },
			before,
			REVIEW_NOW,
		);
		assert.ok(created.ok, created.ok ? "" : created.error);
		const largeDiff = Array.from({ length: 1_500 }, (_, index) => `export const value_${index} = "${"x".repeat(120)}";`).join("\n");
		await writeFile(join(root, "src", "main.ts"), `${largeDiff}\n`, "utf8");
		const after = await collectAfterFacts(root, before, spawnExec);
		const finished = await finishDelegationLedger(root, delegationId, {
			after,
			worker: reviewWorkerFacts(),
			secrets: [],
			now: REVIEW_NOW,
		});
		assert.ok(finished.ok, finished.ok ? "" : finished.error);

		const stub = makeRuntimeStub(spawnExec);
		workbenchRuntime(stub);
		const entries = [{
			type: "custom",
			customType: DELEGATION_STATE_ENTRY_TYPE,
			data: serializeDelegationState({
				latestId: delegationId,
				status: "PENDING_REVIEW",
				currentDiffHash: after.diffHash,
				reviewedDiffHash: undefined,
				blockedWriteAttempts: 0,
				updatedAt: REVIEW_NOW,
			}),
		}];
		await fireSessionStart(stub, root, entries);
		const review = registeredTool(stub, "workbench_review_worker_diff");

		const hugeMismatch = await review.execute(
			"call-review-error",
			{ delegation_id: "z".repeat(100_000), max_lines: 2_000, max_bytes: 512_000 },
			undefined,
			undefined,
			trustedContext(root),
		);
		const errorText = assertToolTextWithin(hugeMismatch, DIFF_REVIEW_RESULT_MAX_BYTES, DIFF_REVIEW_RESULT_MAX_LINES, "review error");
		assert.match(errorText, /\[workbench-output truncated /);

		const success = await review.execute(
			"call-review-success",
			{ delegation_id: delegationId, max_lines: 2_000, max_bytes: 512_000 },
			undefined,
			undefined,
			trustedContext(root),
		);
		assertToolTextWithin(success, DIFF_REVIEW_RESULT_MAX_BYTES, DIFF_REVIEW_RESULT_MAX_LINES, "review success");
		assert.equal(success.details.ok, true);
	});
});

function registeredExecuteCalls(source: string, metadataName: string): Set<string> {
	const file = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const calls = new Set<string>();
	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "registerTool") {
			const definition = node.arguments[0];
			if (definition && ts.isObjectLiteralExpression(definition)) {
				const matches = definition.properties.some((property) =>
					ts.isSpreadAssignment(property) && property.expression.getText(file).endsWith(`.${metadataName}`),
				);
				if (matches) {
					const execute = definition.properties.find((property) =>
						ts.isMethodDeclaration(property) && property.name.getText(file) === "execute",
					);
					if (execute && ts.isMethodDeclaration(execute) && execute.body) {
						const collect = (child: ts.Node): void => {
							if (ts.isCallExpression(child)) calls.add(child.expression.getText(file));
							ts.forEachChild(child, collect);
						};
						ts.forEachChild(execute.body, collect);
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
	return calls;
}

test("R0 wires whole-result clamps at read-run and diff-review final text boundaries", async () => {
	const source = await readFile(new URL("../extensions/workbench-runtime/index.ts", import.meta.url), "utf8");
	for (const metadataName of ["workbench_read_run", "workbench_review_worker_diff"]) {
		assert.ok(
			registeredExecuteCalls(source, metadataName).has("clampWholeResultText"),
			`${metadataName} execute must call clampWholeResultText`,
		);
	}
});
