/**
 * Commander Slice B2 (commander-token-optimization plan, P2 coverage-gated
 * segmented actual-diff review): WIRING tests for
 * `workbench_review_worker_diff` — integration-style, through the ACTUALLY
 * REGISTERED workbench runtime surface (the registered model tool), with
 * real git repos and the real spawnExec.
 *
 * The pure review/coverage unit tests live in tests/diff-review.test.ts and
 * tests/delegation-state.test.ts. This file proves the REGISTERED surface:
 *
 *   - the tool is callable repeatedly on the latest delegation
 *     (PENDING_REVIEW / STALE / REVIEWED): every call re-runs the real git
 *     facts/scope/hash; segmented include_paths calls merge displayed
 *     coverage across the same bound hash and the delegation becomes
 *     REVIEWED only on scope PASS + complete coverage;
 *   - details carry bounded coverage facts (displayed_count / remaining_count /
 *     next_include_paths / coverage_complete), the review_status and the
 *     durable project-relative review_record path; complete path arrays remain
 *     only in review.json at that path;
 *   - a hidden out-of-scope path always FAILs, and a scope FAIL invalidates
 *     a prior same-hash REVIEWED state fail-closed (demoted to
 *     PENDING_REVIEW, reviewed hash cleared — persisted);
 *   - a hash change after REVIEWED resets coverage and turns the delegation
 *     STALE; fresh complete coverage re-binds REVIEWED; a same-hash
 *     complete PASS rerender keeps the valid REVIEWED binding;
 *   - Phase 5 registered surface: one >32 KiB regular JSON renders as a
 *     durable compact patch entry (source "compact", additive structured
 *     facts, generator equality NOT_VERIFIED) when the registered tool is
 *     called with ONLY the existing {delegation_id} argument — the active
 *     tool set, registration order and parameter schema stay unchanged; the
 *     durable review.json patch_paths carries the honest compact stat without
 *     copying it into session details;
 *   - the delegation state persists as the existing custom entry
 *     (workbench-delegation-state) and the review writes only review.json
 *     plus that entry — no tool/order/schema change (registration order
 *     and the parameter schema stay byte-identical to the catalog).
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { before, test } from "node:test";

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import {
	collectAfterFacts,
	collectGitFacts,
	contentDigest,
	createDelegationLedger,
	finishDelegationLedger,
	makeDelegationId,
	MAX_DIGEST_BYTES,
	type LedgerWorkerFacts,
} from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import { DELEGATION_STATE_ENTRY_TYPE, serializeDelegationState } from "../extensions/workbench-runtime/core/delegation-state.ts";
import { WORKBENCH_TOOL_NAMES, WORKBENCH_TOOL_PARAMETERS } from "../extensions/workbench-runtime/core/tool-catalog.ts";
import { NATIVE_OVERRIDE_NAMES } from "../extensions/workbench-runtime/core/native-tool-policy.ts";
import { WORKER_ALLOWED_PATHS_ENV, WORKER_PROJECT_ROOT_ENV, WORKER_ROLE_ENV } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { WORKER_SPEND_PROFILE_ENV } from "../extensions/workbench-runtime/core/worker-spend.ts";
import { spawnExec, withTempDir } from "./helpers.ts";

const NOW = "2026-06-01T12:00:00.000Z";

// ------------------------------------------------------------------ stubs

interface StubAPI {
	commands: Map<string, unknown>;
	tools: Map<string, unknown>;
	events: Map<string, Array<(event: never, ctx: never) => unknown>>;
	entries: Array<{ type: string; customType: string; data?: unknown }>;
	messages: Array<{ customType: string; content: string; display: boolean; options?: unknown }>;
	activeTools: string[];
	appendEntryCalls: Array<{ customType: string; data: unknown }>;
}

/** Same stub ExtensionAPI surface as tests/run-result-wiring.test.ts, with the REAL spawnExec. */
function makeStub(): StubAPI & ExtensionAPI {
	const stub: StubAPI & ExtensionAPI = {
		commands: new Map(),
		tools: new Map(),
		events: new Map(),
		entries: [],
		messages: [],
		activeTools: [],
		appendEntryCalls: [],
		registerCommand: (name: string, def: unknown) => {
			stub.commands.set(name, def);
		},
		registerTool: (def: { name: string }) => {
			stub.tools.set(def.name, def);
		},
		on: (event: string, handler: (event: never, ctx: never) => unknown) => {
			const list = stub.events.get(event) ?? [];
			list.push(handler);
			stub.events.set(event, list);
		},
		appendEntry: (customType: string, data: unknown) => {
			stub.entries.push({ type: "custom", customType, data });
			stub.appendEntryCalls.push({ customType, data });
		},
		sendMessage: (message: { customType: string; content: string; display: boolean }, options?: unknown) => {
			stub.messages.push({ ...message, options });
		},
		sendUserMessage: () => {},
		setActiveTools: (tools: string[]) => {
			stub.activeTools = [...tools];
		},
		getActiveTools: () => stub.activeTools,
		getAllTools: () => [...stub.tools.values()] as never[],
		getThinkingLevel: () => "high" as never,
		exec: spawnExec,
	} as unknown as StubAPI & ExtensionAPI;
	return stub;
}

/** Trusted temp-project ctx for model-tool execution and session_start. */
function trustedCtx(root: string, entries: unknown[] = []): ExtensionCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: root,
		isProjectTrusted: () => true,
		sessionManager: {
			getEntries: () => entries,
			getSessionFile: () => `${root}/session.jsonl`,
			getSessionId: () => "diff-review-wiring-test",
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

interface ReviewTool {
	execute: (
		toolCallId: string,
		params: { delegation_id: string; include_paths?: string[]; max_lines?: number; max_bytes?: number },
		signal: unknown,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

interface ReviewDetails {
	ok: boolean;
	delegation_id: string;
	verdict: "PASS" | "FAIL";
	review_status: string;
	bound_diff_hash: string;
	recorded_after_hash: string;
	violation_count: number;
	drift_count: number;
	checked_count: number;
	displayed_count: number;
	remaining_count: number;
	coverage_complete: boolean;
	presentation_complete: boolean;
	semantic_review: "required" | "accepted" | "not_required";
	semantic_risk: "low" | "medium" | "high";
	review_record: string;
	next_include_paths: string[];
	patch_truncated: boolean;
}

interface DurableReviewRecord {
	delegation_id: string;
	violations: Array<{ path: string; reason: string }>;
	checked_paths: string[];
	displayed_paths: string[];
	remaining_paths: string[];
	coverage_complete: boolean;
	patch_paths: Array<{ path: string; source: string; bytes: number; truncated: boolean }>;
}

/** The structured details of a registered review tool result. */
function reviewDetails(result: { details: Record<string, unknown> }): ReviewDetails {
	return result.details as unknown as ReviewDetails;
}

/** Session details are a bounded DTO; complete review arrays live only in review.json. */
function assertNoFullReviewArrays(details: ReviewDetails): void {
	for (const field of ["violations", "drift_paths", "checked_paths", "displayed_paths", "remaining_paths", "patch", "patch_paths"]) {
		assert.equal(Object.prototype.hasOwnProperty.call(details, field), false, `${field} must not be copied into session details`);
	}
}

/** Read the durable full-fidelity review record named by the bounded DTO. */
async function durableReview(root: string, details: ReviewDetails): Promise<DurableReviewRecord> {
	return JSON.parse(await readFile(join(root, details.review_record), "utf8")) as DurableReviewRecord;
}

/** Text content of a tool result (the ACTUAL registered runtime output). */
function toolText(result: { content: Array<{ type: string; text: string }> }): string {
	return result.content.map((c) => c.text).join("\n");
}

interface PersistedDelegationState {
	latestId?: string;
	status: string;
	currentDiffHash?: string;
	reviewedDiffHash?: string;
	blockedWriteAttempts: number;
	updatedAt: string;
}

/** The LAST persisted workbench-delegation-state entry (state is authoritative). */
function lastDelegationStateEntry(stub: StubAPI & ExtensionAPI): PersistedDelegationState {
	const entry = stub.appendEntryCalls.filter((c) => c.customType === DELEGATION_STATE_ENTRY_TYPE).pop();
	assert.ok(entry, "a delegation state entry was persisted");
	return entry.data as PersistedDelegationState;
}

/** Fire the registered session_start handler with the given delegation-state entries. */
async function fireSessionStart(stub: StubAPI & ExtensionAPI, root: string, entries: unknown[]): Promise<void> {
	const handlers = stub.events.get("session_start") ?? [];
	assert.ok(handlers.length > 0, "session_start handler registered");
	for (const handler of handlers) {
		await handler({ reason: "reload" } as never, trustedCtx(root, entries) as never);
	}
}

async function fireRuntimeEvent(stub: StubAPI & ExtensionAPI, name: string, event: Record<string, unknown>, ctx: ExtensionContext): Promise<void> {
	for (const handler of stub.events.get(name) ?? []) await handler(event as never, ctx as never);
}

async function fireMessageEnd(stub: StubAPI & ExtensionAPI, message: Record<string, unknown>, ctx: ExtensionContext): Promise<Record<string, unknown>> {
	let current = message;
	for (const handler of stub.events.get("message_end") ?? []) {
		const patch = await handler({ type: "message_end", message: current } as never, ctx as never) as { message?: Record<string, unknown> } | undefined;
		if (patch?.message) current = patch.message;
	}
	return current;
}

async function fireToolCall(stub: StubAPI & ExtensionAPI, event: Record<string, unknown>, ctx: ExtensionContext): Promise<{ block?: boolean; reason?: string }> {
	let current: { block?: boolean; reason?: string } = {};
	for (const handler of stub.events.get("tool_call") ?? []) {
		const result = await handler(event as never, ctx as never) as { block?: boolean; reason?: string } | undefined;
		if (result) current = result;
		if (current.block) break;
	}
	return current;
}

async function fireToolResult(
	stub: StubAPI & ExtensionAPI,
	event: {
		type: "tool_result";
		toolCallId: string;
		toolName: string;
		input: Record<string, unknown>;
		content: Array<{ type: string; text: string }>;
		isError: boolean;
		details: Record<string, unknown>;
	},
): Promise<{
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	content: Array<{ type: string; text: string }>;
	isError: boolean;
	details: Record<string, unknown>;
}> {
	const current = { ...event, content: [...event.content] };
	for (const handler of stub.events.get("tool_result") ?? []) {
		const patch = await handler(current as never, undefined as never) as Partial<typeof event> | undefined;
		if (patch?.content !== undefined) current.content = patch.content;
		if (patch?.details !== undefined) current.details = patch.details;
		if (patch?.isError !== undefined) current.isError = patch.isError;
	}
	return current;
}

/**
 * Commander tests must never inherit a worker-role env from the harness
 * (the unit tests may run inside a delegated worker process). Clear it
 * before the suite, like the other wiring tests.
 */
before(() => {
	delete process.env[WORKER_ROLE_ENV];
	delete process.env[WORKER_PROJECT_ROOT_ENV];
	delete process.env[WORKER_ALLOWED_PATHS_ENV];
	delete process.env[WORKER_SPEND_PROFILE_ENV];
});

// --------------------------------------------------------------- fixtures

async function git(repo: string, args: string[]): Promise<void> {
	const result = await spawnExec("git", args, { cwd: repo });
	assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

async function commitAll(repo: string, message: string): Promise<void> {
	await git(repo, ["add", "-A"]);
	await git(repo, ["commit", "-q", "-m", message]);
}

function workerFacts(overrides: Partial<LedgerWorkerFacts> = {}): LedgerWorkerFacts {
	return {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		status: "success",
		exitCode: 0,
		turns: 3,
		stopReason: "done",
		errorMessage: null,
		usage: { input: 100, output: 50, cacheRead: 900, cacheWrite: 0, totalTokens: 1050, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		cacheHitRatio: null,
		budget: { maxContextTokens: 400_000, maxContextRatio: 0.4, softBudgetReached: false, hardBudgetExceeded: false, compactionCount: 0, compactionReasons: [] },
		reportSummary: "done",
		...overrides,
	};
}

/** Real git repo + a finished delegation whose worker changed the given paths. */
async function setupDelegation(
	dir: string,
	workerChanges: (dir: string) => Promise<void>,
	allowedPaths: string[] = ["src/**", "README.md"],
): Promise<{ id: string; afterHash: string }> {
	await git(dir, ["init", "-q"]);
	await git(dir, ["config", "user.email", "test@example.com"]);
	await git(dir, ["config", "user.name", "Workbench Test"]);
	await git(dir, ["config", "commit.gpgsign", "false"]);
	await mkdir(join(dir, "src"), { recursive: true });
	await writeFile(join(dir, "README.md"), "hello\n", "utf8");
	await writeFile(join(dir, "src", "main.ts"), "v1\n", "utf8");
	await commitAll(dir, "init");

	const before = await collectGitFacts(dir, spawnExec);
	const id = makeDelegationId(new Date());
	const created = await createDelegationLedger(
		dir,
		id,
		{ task: "t", allowedPaths, acceptanceCriteria: [], verification: [], timeoutSeconds: 1800 },
		before,
		NOW,
	);
	assert.ok(created.ok, created.ok ? "" : created.error);
	await workerChanges(dir);
	const after = await collectAfterFacts(dir, before, spawnExec);
	const finished = await finishDelegationLedger(dir, id, { after, worker: workerFacts(), secrets: [], now: NOW });
	assert.ok(finished.ok, finished.ok ? "" : finished.error);
	return { id, afterHash: after.diffHash };
}

/** A persisted PENDING_REVIEW delegation-state entry for the latest delegation. */
function pendingStateEntry(id: string, diffHash: string): unknown[] {
	return [
		{
			type: "custom",
			customType: DELEGATION_STATE_ENTRY_TYPE,
			data: serializeDelegationState({
				latestId: id,
				status: "PENDING_REVIEW",
				currentDiffHash: diffHash,
				reviewedDiffHash: undefined,
				blockedWriteAttempts: 0,
				updatedAt: NOW,
			}),
		},
	];
}

function reviewTool(stub: StubAPI & ExtensionAPI): ReviewTool {
	const tool = stub.tools.get("workbench_review_worker_diff") as unknown as ReviewTool | undefined;
	assert.ok(tool, "workbench_review_worker_diff registered");
	return tool;
}

// --------------------------------------------------------------------------
// Registered model-tool surface: coverage-gated lifecycle
// --------------------------------------------------------------------------

test("registered legacy review tool merges scope/integrity segments but keeps non-zero work PENDING for strict-v2 repair", async () => {
	await withTempDir(async (root) => {
		const { id, afterHash } = await setupDelegation(root, async (d) => {
			for (const name of ["a.ts", "b.ts", "c.ts"]) {
				await writeFile(join(d, "src", name), `// ${name}\n` + "x\n".repeat(8), "utf8");
			}
		});
		const stub = makeStub();
		workbenchRuntime(stub);
		// Registration surface is the exact fixed surface: the three native
		// overrides first (read → grep → find), then the catalog in order.
		assert.deepEqual([...stub.tools.keys()], [...NATIVE_OVERRIDE_NAMES, ...WORKBENCH_TOOL_NAMES], "registration order == NATIVE_OVERRIDE_NAMES + WORKBENCH_TOOL_NAMES");
		assert.deepEqual(
			(stub.tools.get("workbench_review_worker_diff") as { parameters: unknown }).parameters,
			WORKBENCH_TOOL_PARAMETERS.workbench_review_worker_diff,
			"review parameter schema byte-identical to the catalog",
		);
		await fireSessionStart(stub, root, pendingStateEntry(id, afterHash));
		const activeToolsBefore = [...stub.activeTools];
		const review = reviewTool(stub);

		// Segment 1: one explicitly selected path is present in the bounded
		// final content and therefore advances coverage by exactly one.
		const r1 = await review.execute("call-1", { delegation_id: id, include_paths: ["src/a.ts"], max_lines: 40 }, undefined, undefined, trustedCtx(root) as never);
		const d1 = reviewDetails(r1);
		assert.equal(d1.ok, true);
		assert.equal(d1.verdict, "PASS");
		assert.equal(d1.review_status, "PENDING_REVIEW", "no REVIEWED until coverage is complete");
		assert.equal(d1.coverage_complete, false);
		assert.equal(d1.violation_count, 0);
		assert.equal(d1.checked_count, 3);
		assert.equal(d1.displayed_count, 1);
		assert.equal(d1.remaining_count, 2);
		assert.deepEqual(d1.next_include_paths, ["src/b.ts", "src/c.ts"]);
		assert.equal(d1.bound_diff_hash, afterHash);
		assert.equal(d1.review_record, `${CONFIG_DIR_NAME}/workbench/delegations/${id}/review.json`);
		assertNoFullReviewArrays(d1);
		const disk1 = await durableReview(root, d1);
		assert.deepEqual(disk1.displayed_paths, ["src/a.ts"]);
		assert.deepEqual(disk1.remaining_paths, ["src/b.ts", "src/c.ts"]);
		const r1Text = toolText(r1);
		assert.ok(r1Text.split("\n").length <= 40, `review exceeded requested 40-line cap:\n${r1Text}`);
		assert.ok(Buffer.byteLength(r1Text, "utf8") <= 32_768, `fallback exceeded 32 KiB policy cap: ${Buffer.byteLength(r1Text, "utf8")}`);
		assert.ok(r1Text.includes(`full=${d1.review_record}`), r1Text);
		assert.ok(r1Text.includes("packet is not semantic acceptance or Gate authority"), r1Text);
		assert.match(r1Text, /(?:^|\n)--- src\/a\.ts /, "coverage advances only when the selected patch entry is in final content");

		// Segment 2: include_paths merges coverage on the same hash.
		const r2 = await review.execute("call-2", { delegation_id: id, include_paths: ["src/b.ts"], max_lines: 40 }, undefined, undefined, trustedCtx(root) as never);
		const d2 = reviewDetails(r2);
		assert.equal(d2.verdict, "PASS");
		assert.equal(d2.review_status, "PENDING_REVIEW");
		assert.equal(d2.violation_count, 0);
		assert.equal(d2.displayed_count, 2);
		assert.equal(d2.remaining_count, 1);
		assert.deepEqual(d2.next_include_paths, ["src/c.ts"]);
		assert.equal(d2.bound_diff_hash, afterHash, "every segment binds the complete current diff hash");
		assertNoFullReviewArrays(d2);
		const disk2 = await durableReview(root, d2);
		assert.deepEqual(disk2.displayed_paths, ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(disk2.remaining_paths, ["src/c.ts"]);

		// Segment 3: complete presentation remains PENDING because legacy-v1
		// evidence cannot be upgraded into the new durable semantic acceptance.
		const r3 = await review.execute("call-3", { delegation_id: id, include_paths: ["src/c.ts"], max_lines: 40 }, undefined, undefined, trustedCtx(root) as never);
		const d3 = reviewDetails(r3);
		assert.equal(d3.verdict, "PASS");
		assert.equal(d3.review_status, "PENDING_REVIEW");
		assert.equal(d3.coverage_complete, true);
		assert.equal(d3.presentation_complete, true);
		assert.equal(d3.semantic_review, "required");
		assert.equal(d3.violation_count, 0);
		assert.equal(d3.displayed_count, 3);
		assert.equal(d3.remaining_count, 0);
		assert.deepEqual(d3.next_include_paths, []);
		assertNoFullReviewArrays(d3);
		assert.equal(d3.review_record, `${CONFIG_DIR_NAME}/workbench/delegations/${id}/review.json`);
		const r3Text = toolText(r3);
		assert.ok(r3Text.split("\n").length <= 40, `review exceeded requested 40-line cap:\n${r3Text}`);
		assert.ok(Buffer.byteLength(r3Text, "utf8") <= 32_768, `fallback exceeded 32 KiB policy cap: ${Buffer.byteLength(r3Text, "utf8")}`);
		assert.ok(r3Text.includes(`full=${d3.review_record}`), r3Text);
		assert.ok(r3Text.includes("packet is not semantic acceptance or Gate authority"), r3Text);
		assert.match(r3Text, /(?:^|\n)--- src\/c\.ts /, "the final path is visibly presented before the legacy flow remains pending");

		// The legacy session mirror stays blocking and carries no accepted hash.
		const entry = lastDelegationStateEntry(stub);
		assert.equal(entry.latestId, id);
		assert.equal(entry.status, "PENDING_REVIEW");
		assert.equal(entry.reviewedDiffHash, undefined);
		assert.equal(entry.currentDiffHash, afterHash);
		assert.equal(entry.blockedWriteAttempts, 0);

		// The durable review.json exists at the declared project-relative path.
		const onDisk = await durableReview(root, d3);
		assert.equal(onDisk.delegation_id, id);
		assert.equal(onDisk.coverage_complete, true);
		assert.deepEqual(onDisk.displayed_paths, ["src/a.ts", "src/b.ts", "src/c.ts"]);

		// No tool/order change: registration, parameter schema and the active
		// tool set are untouched by the review calls.
		assert.deepEqual([...stub.tools.keys()], [...NATIVE_OVERRIDE_NAMES, ...WORKBENCH_TOOL_NAMES]);
		assert.deepEqual(stub.activeTools, activeToolsBefore, "review calls never change the active tool set");

		// Only the latest delegation is reviewable.
		const other = await review.execute("call-4", { delegation_id: "20260101-000000-zzzz" }, undefined, undefined, trustedCtx(root) as never);
		assert.match(toolText(other), /is not the latest delegation/);
	});
});

test("registered legacy review tool: a real 16-call turn uses each exact 4 KiB reservation and never upgrades complete coverage to semantic acceptance", async () => {
	await withTempDir(async (root) => {
		const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
		const { id, afterHash } = await setupDelegation(root, async (dir) => {
			for (const path of paths) await writeFile(join(dir, path), `${path}\n${(`${"v".repeat(600)}\n`).repeat(24)}`, "utf8");
		});
		const stub = makeStub();
		workbenchRuntime(stub);
		const ctx = trustedCtx(root) as ExtensionContext;
		await fireSessionStart(stub, root, pendingStateEntry(id, afterHash));
		await fireRuntimeEvent(stub, "model_select", {
			type: "model_select",
			model: { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" },
			previousModel: undefined,
			source: "set",
		}, ctx);
		await fireRuntimeEvent(stub, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 }, ctx);
		const selected = [
			{ path: paths[0]!, max_lines: 10, visible: false },
			...paths.map((path) => ({ path, max_lines: 40, visible: true })),
		].map((item, index) => ({
			id: `reserved-review-${index}`,
			name: "workbench_review_worker_diff",
			arguments: { delegation_id: id, include_paths: [item.path], max_lines: item.max_lines },
			visible: item.visible,
		}));
		const calls = [
			...selected,
			...Array.from({ length: 12 }, (_, index) => ({
				id: `reserved-review-filler-${index}`,
				name: "workbench_review_worker_diff",
				arguments: { delegation_id: id, include_paths: [paths[0]!] },
			})),
		];
		await fireMessageEnd(stub, {
			role: "assistant",
			content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments })),
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			stopReason: "toolUse",
			timestamp: 1,
		}, ctx);
		const tool = reviewTool(stub);
		for (let index = 0; index < selected.length; index += 1) {
			const call = selected[index]!;
			const guard = await fireToolCall(stub, {
				type: "tool_call", toolCallId: call.id, toolName: call.name, input: call.arguments,
			}, ctx);
			assert.equal(guard.block, undefined);
			const raw = await tool.execute(call.id, call.arguments, undefined, undefined, ctx);
			const rawText = toolText(raw);
			assert.ok(Buffer.byteLength(rawText, "utf8") <= 4_096, "the renderer consumes this call's exact planned minimum allocation");
			if (call.visible) assert.match(rawText, new RegExp(`(?:^|\\n)--- ${call.arguments.include_paths[0]!.replace(".", "\\.")} `));
			else assert.match(rawText, /presentation_page_unavailable/, "an allocation too small for any visible page fails explicitly");
			const final = await fireToolResult(stub, {
				type: "tool_result",
				toolCallId: call.id,
				toolName: call.name,
				input: call.arguments,
				content: raw.content,
				isError: false,
				details: raw.details,
			});
			assert.equal(toolText(final), rawText, "the generic result envelope is a no-op after allocation-aware review rendering");
			const details = reviewDetails(final);
			const envelope = final.details.output_envelope as Record<string, unknown>;
			assert.equal(envelope.truncated, false);
			assert.equal(envelope.shownTextBytes, Buffer.byteLength(rawText, "utf8"));
			if (!call.visible) {
				assert.match(String((final.details as Record<string, unknown>).error), /presentation_page_unavailable/);
				continue;
			}
			const visibleCount = Math.max(0, index);
			assert.equal(details.displayed_count, visibleCount);
			assert.equal(details.remaining_count, paths.length - visibleCount);
			assert.equal(details.coverage_complete, index === selected.length - 1);
			assert.equal(details.review_status, "PENDING_REVIEW");
			const persisted = await durableReview(root, details);
			assert.deepEqual(persisted.displayed_paths, paths.slice(0, visibleCount));
		}
		await fireRuntimeEvent(stub, "turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx);
	});
});

test("registered review tool: hidden out-of-scope path always FAILs; a scope FAIL demotes a prior same-hash REVIEWED state fail-closed", async () => {
	await withTempDir(async (root) => {
		const { id, afterHash } = await setupDelegation(
			root,
			async (d) => {
				await writeFile(join(d, "src", "main.ts"), "ok\n", "utf8");
				// The worker wrote OUTSIDE the parent-approved scope.
				await writeFile(join(d, "forbidden.ts"), "x\n", "utf8");
			},
			["src/**"],
		);
		const stub = makeStub();
		workbenchRuntime(stub);
		// A persisted state claims REVIEWED at the SAME hash (invariant-valid
		// restore accepts it) even though the real tree violates the scope —
		// the registered tool's re-review must invalidate it fail-closed.
		await fireSessionStart(
			stub,
			root,
			[
				{
					type: "custom",
					customType: DELEGATION_STATE_ENTRY_TYPE,
					data: serializeDelegationState({
						latestId: id,
						status: "REVIEWED",
						currentDiffHash: afterHash,
						reviewedDiffHash: afterHash,
						blockedWriteAttempts: 0,
						updatedAt: NOW,
					}),
				},
			],
		);
		const review = reviewTool(stub);

		// include_paths names ONLY the in-scope path — the hidden out-of-scope
		// path must still FAIL the review.
		const result = await review.execute("call-1", { delegation_id: id, include_paths: ["src/main.ts"] }, undefined, undefined, trustedCtx(root) as never);
		const details = reviewDetails(result);
		assert.equal(details.verdict, "FAIL");
		assert.equal(details.review_status, "PENDING_REVIEW", "a scope FAIL invalidates the prior same-hash REVIEWED state");
		assert.equal(details.violation_count, 1);
		assert.equal(details.checked_count, 2);
		assert.equal(details.displayed_count, 1);
		assert.equal(details.coverage_complete, false);
		assert.equal(details.remaining_count, 1);
		assert.deepEqual(details.next_include_paths, ["forbidden.ts"]);
		assert.equal(details.bound_diff_hash, afterHash, "same hash — the FAIL is the invalidation trigger");
		assertNoFullReviewArrays(details);
		const onDisk = await durableReview(root, details);
		assert.deepEqual(onDisk.violations.map((violation) => violation.path), ["forbidden.ts"]);
		assert.deepEqual(onDisk.remaining_paths, ["forbidden.ts"]);
		assert.ok(toolText(result).includes("scope check: FAIL"), toolText(result));

		// The persisted state is demoted: PENDING_REVIEW, reviewed hash cleared.
		const entry = lastDelegationStateEntry(stub);
		assert.equal(entry.status, "PENDING_REVIEW");
		assert.equal(entry.reviewedDiffHash, undefined, "the reviewed hash is cleared fail-closed");
		assert.equal(entry.currentDiffHash, afterHash, "the current diff hash is kept");
	});
});

test("registered legacy review tool: a hash change resets coverage while unaccepted work remains PENDING", async () => {
	await withTempDir(async (root) => {
		const { id, afterHash } = await setupDelegation(root, async (d) => {
			await writeFile(join(d, "src", "a.ts"), "a1\n", "utf8");
			await writeFile(join(d, "src", "b.ts"), "b1\n", "utf8");
		});
		const stub = makeStub();
		workbenchRuntime(stub);
		await fireSessionStart(stub, root, pendingStateEntry(id, afterHash));
		const review = reviewTool(stub);

		// Complete legacy scope presentation remains PENDING (no semantic marker).
		const r1 = await review.execute("call-1", { delegation_id: id }, undefined, undefined, trustedCtx(root) as never);
		const d1 = reviewDetails(r1);
		assert.equal(d1.review_status, "PENDING_REVIEW");
		assert.equal(d1.coverage_complete, true);
		assert.equal(d1.bound_diff_hash, afterHash);
		assert.equal(d1.violation_count, 0);
		assert.equal(d1.checked_count, 2);
		assert.equal(d1.displayed_count, 2);
		assert.equal(d1.remaining_count, 0);
		assert.deepEqual(d1.next_include_paths, []);
		assertNoFullReviewArrays(d1);
		const disk1 = await durableReview(root, d1);
		assert.deepEqual(disk1.displayed_paths, ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(disk1.remaining_paths, []);

		// The diff changes before semantic acceptance (commander edit).
		await writeFile(join(root, "src", "b.ts"), "b2 — commander edit\n", "utf8");

		// A narrowed rerender: hash change keeps PENDING and resets coverage.
		const r2 = await review.execute("call-2", { delegation_id: id, include_paths: ["src/a.ts"] }, undefined, undefined, trustedCtx(root) as never);
		const d2 = reviewDetails(r2);
		assert.equal(d2.review_status, "PENDING_REVIEW", "unaccepted legacy work remains pending on a new binding");
		assert.equal(d2.coverage_complete, false);
		assert.equal(d2.violation_count, 0);
		assert.equal(d2.displayed_count, 1);
		assert.equal(d2.remaining_count, 1, "coverage resets on the hash change — a.ts was re-displayed in THIS call and is not remaining");
		assert.deepEqual(d2.next_include_paths, ["src/b.ts"]);
		assert.notEqual(d2.bound_diff_hash, afterHash);
		assertNoFullReviewArrays(d2);
		const disk2 = await durableReview(root, d2);
		assert.deepEqual(disk2.displayed_paths, ["src/a.ts"]);
		assert.deepEqual(disk2.remaining_paths, ["src/b.ts"]);
		const pendingEntry = lastDelegationStateEntry(stub);
		assert.equal(pendingEntry.status, "PENDING_REVIEW");
		assert.equal(pendingEntry.reviewedDiffHash, undefined);

		// A full render under the new hash completes presentation but remains pending.
		const r3 = await review.execute("call-3", { delegation_id: id }, undefined, undefined, trustedCtx(root) as never);
		const d3 = reviewDetails(r3);
		assert.equal(d3.review_status, "PENDING_REVIEW");
		assert.equal(d3.coverage_complete, true);
		assert.equal(d3.bound_diff_hash, d2.bound_diff_hash);
		assert.equal(d3.violation_count, 0);
		assert.equal(d3.displayed_count, 2);
		assert.equal(d3.remaining_count, 0);
		assert.deepEqual(d3.next_include_paths, []);
		assertNoFullReviewArrays(d3);
		const disk3 = await durableReview(root, d3);
		assert.deepEqual(disk3.displayed_paths, ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(disk3.remaining_paths, []);
		const rebound = lastDelegationStateEntry(stub);
		assert.equal(rebound.status, "PENDING_REVIEW");
		assert.equal(rebound.reviewedDiffHash, undefined);
		assert.equal(rebound.currentDiffHash, d3.bound_diff_hash);

		// A same-hash complete PASS rerender keeps the blocking pending binding.
		const r4 = await review.execute("call-4", { delegation_id: id, include_paths: ["src/a.ts"] }, undefined, undefined, trustedCtx(root) as never);
		const d4 = reviewDetails(r4);
		assert.equal(d4.review_status, "PENDING_REVIEW", "legacy evidence never becomes semantic acceptance");
		assert.equal(d4.coverage_complete, true, "same-hash merge keeps complete coverage");
		assert.equal(d4.bound_diff_hash, d3.bound_diff_hash);
		assert.equal(d4.displayed_count, 2);
		assert.equal(d4.remaining_count, 0);
		assert.deepEqual(d4.next_include_paths, []);
		assertNoFullReviewArrays(d4);
		const disk4 = await durableReview(root, d4);
		assert.deepEqual(disk4.displayed_paths, ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(disk4.remaining_paths, []);
	});
});

test("registered review tool: a repeated same-hash PASS with incomplete coverage (legacy partial review record) demotes a prior REVIEWED state fail-closed", async () => {
	await withTempDir(async (root) => {
		const { id, afterHash } = await setupDelegation(root, async (d) => {
			await writeFile(join(d, "src", "a.ts"), "a1\n", "utf8");
			await writeFile(join(d, "src", "b.ts"), "b1\n", "utf8");
		});
		const stub = makeStub();
		workbenchRuntime(stub);
		// A legacy partial review record (schema_version 1 WITHOUT the Slice
		// B2 coverage fields) whose patch displayed only a.ts, together with
		// a persisted REVIEWED state at the SAME hash — the exact shape a
		// pre-B2 session could leave behind.
		const reviewDir = join(root, ".pi", "workbench", "delegations", id);
		await mkdir(reviewDir, { recursive: true });
		const legacy = {
			schema_version: 1,
			delegation_id: id,
			reviewed_at: NOW,
			verdict: "PASS",
			bound_diff_hash: afterHash,
			recorded_after_hash: afterHash,
			mismatch: false,
			drift_paths: [],
			violations: [],
			checked_paths: ["src/a.ts", "src/b.ts"],
			include_paths: [],
			patch: [{ path: "src/a.ts", source: "git-diff", text: "diff a", truncated: false }],
			patch_truncated: false,
			patch_paths: [],
			notes: [],
		};
		await writeFile(join(reviewDir, "review.json"), JSON.stringify(legacy), "utf8");
		await fireSessionStart(
			stub,
			root,
			[
				{
					type: "custom",
					customType: DELEGATION_STATE_ENTRY_TYPE,
					data: serializeDelegationState({
						latestId: id,
						status: "REVIEWED",
						currentDiffHash: afterHash,
						reviewedDiffHash: afterHash,
						blockedWriteAttempts: 0,
						updatedAt: NOW,
					}),
				},
			],
		);
		const review = reviewTool(stub);

		// A narrowed same-hash re-review renders only a.ts again: PASS but
		// coverage INCOMPLETE (b.ts has never been displayed for this hash).
		const result = await review.execute("call-1", { delegation_id: id, include_paths: ["src/a.ts"] }, undefined, undefined, trustedCtx(root) as never);
		const details = reviewDetails(result);
		assert.equal(details.verdict, "PASS");
		assert.equal(details.coverage_complete, false);
		assert.equal(details.violation_count, 0);
		assert.equal(details.checked_count, 2);
		assert.equal(details.displayed_count, 1);
		assert.equal(details.remaining_count, 1);
		assert.deepEqual(details.next_include_paths, ["src/b.ts"]);
		assert.equal(details.bound_diff_hash, afterHash, "same hash — the incomplete PASS is the invalidation trigger");
		assert.equal(details.review_status, "PENDING_REVIEW", "a PASS with incomplete coverage must never leave REVIEWED in place");
		assertNoFullReviewArrays(details);
		const partialRecord = await durableReview(root, details);
		assert.deepEqual(partialRecord.displayed_paths, ["src/a.ts"]);
		assert.deepEqual(partialRecord.remaining_paths, ["src/b.ts"]);
		assert.ok(toolText(result).includes("coverage   : INCOMPLETE"), toolText(result));

		// The persisted state is demoted: PENDING_REVIEW, reviewed hash cleared.
		const entry = lastDelegationStateEntry(stub);
		assert.equal(entry.status, "PENDING_REVIEW");
		assert.equal(entry.reviewedDiffHash, undefined, "the reviewed hash is cleared fail-closed");
		assert.equal(entry.currentDiffHash, afterHash, "the current diff hash is kept");

		// Rendering every path completes legacy presentation but cannot create
		// the strict-v2 semantic provenance required for REVIEWED.
		const full = await review.execute("call-2", { delegation_id: id }, undefined, undefined, trustedCtx(root) as never);
		const fullDetails = reviewDetails(full);
		assert.equal(fullDetails.review_status, "PENDING_REVIEW", "legacy complete coverage remains blocking");
		assert.equal(fullDetails.coverage_complete, true);
		assert.equal(fullDetails.displayed_count, 2);
		assert.equal(fullDetails.remaining_count, 0);
		assert.deepEqual(fullDetails.next_include_paths, []);
		assertNoFullReviewArrays(fullDetails);
		const fullRecord = await durableReview(root, fullDetails);
		assert.deepEqual(fullRecord.displayed_paths, ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(fullRecord.remaining_paths, []);
	});
});

test("registered legacy review tool: a >32 KiB JSON yields complete high-risk compact evidence but remains PENDING without strict-v2 acceptance", async () => {
	await withTempDir(async (root) => {
		// One regular JSON LARGER than the default global review byte cap
		// (COMPACT_MIN_BYTES = 32 KiB), multi-line with distinct head/tail
		// markers so both bounded preview windows hold complete lines.
		const bigJson = [
			"{",
			'  "kind": "generated-manifest",',
			'  "head_marker": "MANIFEST_HEAD_9d41c2f7",',
			'  "pad": "' + "p".repeat(40_000) + '",',
			'  "tail_marker": "MANIFEST_TAIL_8b2f9d51"',
			"}",
		].join("\n") + "\n";
		const jsonBytes = Buffer.byteLength(bigJson, "utf8");
		assert.ok(jsonBytes > 32 * 1024, "the JSON must exceed the compact threshold");
		const { id, afterHash } = await setupDelegation(root, async (d) => {
			await writeFile(join(d, "src", "manifest.json"), bigJson, "utf8");
		});
		const stub = makeStub();
		workbenchRuntime(stub);
		// Registration surface is the exact fixed surface — Phase 5 adds no
		// tool, and the review schema still declares exactly the existing
		// eight parameters: the paired semantic-decision fields, bounded repair
		// reason, and optional historical migration binding are not compact/generated controls, and
		// legacy authority still rejects them.
		assert.deepEqual([...stub.tools.keys()], [...NATIVE_OVERRIDE_NAMES, ...WORKBENCH_TOOL_NAMES], "registration order == NATIVE_OVERRIDE_NAMES + WORKBENCH_TOOL_NAMES");
		const registeredParameters = (stub.tools.get("workbench_review_worker_diff") as { parameters: { properties: Record<string, unknown> } }).parameters;
		assert.deepEqual(registeredParameters, WORKBENCH_TOOL_PARAMETERS.workbench_review_worker_diff, "review parameter schema byte-identical to the catalog");
		assert.deepEqual(
			Object.keys(registeredParameters.properties),
			["delegation_id", "include_paths", "max_lines", "max_bytes", "semantic_decision", "expected_bound_diff_hash", "repair_reason", "expected_migration_binding_hash"],
			"the review schema adds only bound semantic-decision fields — no compact/generated parameter",
		);
		assert.ok(!("compact" in registeredParameters) && !("generator" in registeredParameters), "no compact/generated key anywhere in the schema object");
		await fireSessionStart(stub, root, pendingStateEntry(id, afterHash));
		const activeToolsBefore = [...stub.activeTools];
		const review = reviewTool(stub);

		// Execute the EXISTING tool with only the existing {delegation_id}
		// argument — no new argument, no include_paths needed for one path.
		const r1 = await review.execute("call-1", { delegation_id: id }, undefined, undefined, trustedCtx(root) as never);
		const d1 = reviewDetails(r1);
		assert.equal(d1.ok, true);
		assert.equal(d1.verdict, "PASS");
		assert.equal(d1.review_status, "PENDING_REVIEW");
		assert.equal(d1.coverage_complete, true, "the single compact entry is complete displayed-path coverage");
		assert.equal(d1.presentation_complete, true, "strict compact facts form a complete bounded evidence packet");
		assert.equal(d1.semantic_review, "required");
		assert.equal(d1.semantic_risk, "high");
		assert.equal(d1.violation_count, 0);
		assert.equal(d1.checked_count, 1);
		assert.equal(d1.displayed_count, 1);
		assert.equal(d1.remaining_count, 0);
		assert.deepEqual(d1.next_include_paths, []);
		assert.equal(d1.bound_diff_hash, afterHash);
		assert.equal(d1.recorded_after_hash, afterHash);
		assert.equal(d1.review_record, `${CONFIG_DIR_NAME}/workbench/delegations/${id}/review.json`);
		assertNoFullReviewArrays(d1);
		assert.ok(toolText(r1).includes("coverage   : COMPLETE"), toolText(r1));
		assert.ok(toolText(r1).includes("evidence   : COMPLETE"), toolText(r1));
		assert.ok(toolText(r1).includes("generator equality remains NOT_VERIFIED"), toolText(r1));
		assert.ok(toolText(r1).includes("--- src/manifest.json (compact, truncated) ---"), toolText(r1));

		// Durable review record: schema_version stays 1, the patch entry is
		// the compact source with honest truncation, and the additive
		// compact facts carry the expected status/size/digest facts, a
		// recorded-after digest match and generator equality NOT_VERIFIED.
		const onDisk = JSON.parse(await readFile(join(root, d1.review_record), "utf8")) as {
			schema_version: number;
			delegation_id: string;
			verdict: string;
			bound_diff_hash: string;
			recorded_after_hash: string;
			displayed_paths: string[];
			remaining_paths: string[];
			patch_truncated: boolean;
			patch: Array<{ path: string; source: string; truncated: boolean; text: string; compact?: Record<string, unknown> }>;
			patch_paths: Array<{ path: string; source: string; bytes: number; truncated: boolean }>;
		};
		assert.equal(onDisk.schema_version, 1);
		assert.equal(onDisk.delegation_id, id);
		assert.equal(onDisk.verdict, "PASS");
		assert.equal(onDisk.bound_diff_hash, afterHash);
		assert.equal(onDisk.recorded_after_hash, afterHash);
		assert.deepEqual(onDisk.displayed_paths, ["src/manifest.json"]);
		assert.deepEqual(onDisk.remaining_paths, []);
		assert.equal(onDisk.patch.length, 1);
		const entry = onDisk.patch[0]!;
		assert.equal(entry.path, "src/manifest.json");
		assert.equal(entry.source, "compact", "the >32 KiB regular JSON takes the compact source");
		assert.equal(entry.truncated, true, "the compact entry honestly reports its bounded presentation as truncated");
		assert.equal(onDisk.patch_truncated, true, "the per-path compact truncation sets patch_truncated");
		const facts = entry.compact as {
			git_status: string;
			size_bytes: number;
			digest: string;
			digest_kind: string;
			digest_max_bytes: number;
			digest_matches_after: boolean;
			generator_equality: string;
			head_preview: string;
			tail_preview: string;
			head_lines: number;
			tail_lines: number;
			content_truncated: boolean;
		};
		assert.ok(facts, "the additive compact facts are persisted on the patch entry");
		assert.equal(facts.git_status, "??", "the new untracked JSON reports its real porcelain status");
		assert.equal(facts.size_bytes, jsonBytes);
		const freshDigest = await contentDigest(root, "src/manifest.json");
		assert.ok(freshDigest, "manifest.json is a current readable regular file");
		assert.equal(facts.digest, freshDigest, "the compact digest is the fresh current content digest");
		assert.match(facts.digest, /^[0-9a-f]{64}$/, "full sha256 digest form (file ≤ MAX_DIGEST_BYTES)");
		assert.equal(facts.digest_kind, "sha256");
		assert.equal(facts.digest_max_bytes, MAX_DIGEST_BYTES);
		assert.equal(facts.digest_matches_after, true, "the current digest equals the worker's recorded-after digest");
		assert.equal(facts.generator_equality, "NOT_VERIFIED", "generator equality is never verified by the review");
		for (const preview of [facts.head_preview, facts.tail_preview]) {
			const decoded = JSON.parse(preview) as string;
			assert.ok(decoded.length > 0, "the preview is never empty for a non-empty window");
		}
		assert.ok(facts.head_lines > 0 && facts.tail_lines > 0, "the multi-line JSON bounded windows hold complete lines");
		assert.equal(facts.content_truncated, true, "content beyond the shown previews is honestly reported");
		assert.ok(entry.text.includes("generator equality NOT_VERIFIED"), entry.text);

		// The durable patch_paths stat shows the same path with the compact
		// source and honest truncation; its bytes match the durable rendered
		// entry text. Session details deliberately omit this full array.
		assert.deepEqual(onDisk.patch_paths, [
			{ path: "src/manifest.json", source: "compact", bytes: Buffer.byteLength(entry.text, "utf8"), truncated: true },
		]);

		// Review writes/state behavior remains blocking in legacy: the session
		// carries no accepted hash, while registration order,
		// the parameter object and the active tool set are untouched.
		const state = lastDelegationStateEntry(stub);
		assert.equal(state.latestId, id);
		assert.equal(state.status, "PENDING_REVIEW");
		assert.equal(state.reviewedDiffHash, undefined);
		assert.equal(state.currentDiffHash, afterHash);
		assert.deepEqual([...stub.tools.keys()], [...NATIVE_OVERRIDE_NAMES, ...WORKBENCH_TOOL_NAMES], "registration order unchanged after execution");
		assert.deepEqual(
			(stub.tools.get("workbench_review_worker_diff") as { parameters: unknown }).parameters,
			WORKBENCH_TOOL_PARAMETERS.workbench_review_worker_diff,
			"parameter object unchanged after execution",
		);
		assert.deepEqual(stub.activeTools, activeToolsBefore, "review calls never change the active tool set");
	});
});

test("registered review tool returns a whole bounded 500-path presentation with exact omission facts", async () => {
	await withTempDir(async (root) => {
		const names = Array.from({ length: 500 }, (_, index) => `f${String(index).padStart(3, "0")}.ts`);
		const allowed = Array.from({ length: 50 }, (_, index) => `allowed-${index}/${"a".repeat(275)}/**`);
		const { id, afterHash } = await setupDelegation(
			root,
			async (dir) => {
				await mkdir(join(dir, "bulk"), { recursive: true });
				for (const name of names) await writeFile(join(dir, "bulk", name), `${name}\n${"🙂汉\n".repeat(20)}`, "utf8");
			},
			allowed,
		);
		const stub = makeStub();
		workbenchRuntime(stub);
		await fireSessionStart(stub, root, pendingStateEntry(id, afterHash));
		const result = await reviewTool(stub).execute("bulk-review", { delegation_id: id, max_bytes: 512_000, max_lines: 2_000 }, undefined, undefined, trustedCtx(root) as never);
		const text = toolText(result);
		assert.ok(Buffer.byteLength(text, "utf8") <= 32_768, String(Buffer.byteLength(text, "utf8")));
		assert.ok(text.split("\n").length <= 400, String(text.split("\n").length));
		assert.match(text, /packet stats: violations=500\/10\/490;/);
		assert.match(text, /patch=500\/\d+\/\d+; stats=500\/\d+\/\d+;/);
		assert.equal((text.match(/^allowed    :/gm) ?? []).length, 1);
		assert.doesNotMatch(text, /allowed-49\/[a]+\/\*\*.*allowed-49\//s, "allowed scope prose must not repeat per violation");
		assert.match(text, /scope\/integrity evidence is not semantic acceptance or Gate authority/);
		assert.equal(reviewDetails(result).verdict, "FAIL");
	});
});
