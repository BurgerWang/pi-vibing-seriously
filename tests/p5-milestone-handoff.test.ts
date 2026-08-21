/**
 * P5 milestone-handoff tests (commander-token-optimization plan §5).
 *
 * Pure-module tests cover the schema-v1 additive lifecycle records
 * (prepared/resumed/cancelled), the explicit bounded next-step parser, the
 * bounded/redacted CompactState snapshot, the deterministic
 * pointers/status-only hidden note, and fail-closed restore/load.
 *
 * Wiring tests exercise the REAL registered `/q-milestone-handoff` command
 * through a stub ExtensionAPI that simulates Pi's exact newSession ordering
 * (session_start("new") fires BEFORE setup; withSession runs after setup):
 * user-only registration, worker refusal, empty/overlong rejection,
 * unpersisted-session refusal, waitForIdle, source prepared record, parent
 * linkage, target setup entries (resumed + hidden note + mode/compact/
 * delegation copies, NO lease), replacement-context announce + reload, a
 * target-runtime restore proof (copied mode/compact/delegation active after
 * reload while commander writes stay locked), and the additive cancelled
 * record when the replacement is cancelled.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import workbenchRuntime from "../extensions/workbench-runtime/index.ts";
import {
	buildMilestoneHandoffNote,
	buildMilestoneSnapshot,
	latestMilestoneHandoff,
	loadMilestoneHandoffs,
	makeMilestoneId,
	MAX_HANDOFF_NOTE_BYTES,
	MAX_HANDOFF_NOTE_CHARS,
	MAX_HANDOFF_NOTE_LINES,
	MAX_MILESTONE_ID_LENGTH,
	MAX_NEXT_STEP_CHARS,
	MAX_NEXT_STEP_BYTES,
	MAX_SESSION_POINTER_LENGTH,
	MAX_TIMESTAMP_LENGTH,
	MILESTONE_HANDOFF_ENTRY_TYPE,
	MILESTONE_HANDOFF_NOTE_ENTRY_TYPE,
	MILESTONE_HANDOFF_SCHEMA_VERSION,
	parseNextStepArg,
	prepareMilestoneHandoff,
	restoreMilestoneHandoff,
	toCancelledRecord,
	toResumedRecord,
	truncateChars,
	truncateUtf8,
	utf8ByteLength,
	type MilestoneHandoffRecord,
} from "../extensions/workbench-runtime/core/milestone-handoff.ts";
import {
	buildCompactNote,
	COMPACT_STATE_ENTRY_TYPE,
	emptyCompactState,
	loadCompactStateFromEntries,
	MAX_DO_NOT_RETRY,
	MAX_EVIDENCE_PATHS,
	MAX_GATES,
	MAX_MODIFIED_FILES,
} from "../extensions/workbench-runtime/core/compact.ts";
import { MODE_ENTRY_TYPE } from "../extensions/workbench-runtime/core/state.ts";
import {
	DELEGATION_STATE_ENTRY_TYPE,
	emptyDelegationState,
	markReviewed,
	recordBlockedWriteAttempt,
	recordDelegation,
	serializeDelegationState,
} from "../extensions/workbench-runtime/core/delegation-state.ts";
import {
	confirmLease,
	issueLease,
	LEASE_STATE_ENTRY_TYPE,
	serializeLease,
	STRICT_SOL_DEV_ALLOWLIST,
} from "../extensions/workbench-runtime/core/write-authority.ts";
import { WORKER_ROLE_ENV } from "../extensions/workbench-runtime/core/worker-policy.ts";

interface StubAPI {
	commands: Map<string, unknown>;
	tools: Map<string, unknown>;
	events: Map<string, Array<(event: never, ctx: never) => unknown>>;
	entries: Array<{ type: string; customType: string; data?: unknown }>;
	messages: Array<{ customType: string; content: string; display: boolean; options?: unknown }>;
	activeTools: string[];
	appendEntryCalls: Array<{ customType: string; data: unknown }>;
}

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
		exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
	} as unknown as StubAPI & ExtensionAPI;
	return stub;
}

function fakeCtx(entries: StubAPI["entries"], overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		mode: "tui",
		hasUI: false,
		cwd: "/tmp/workbench-project",
		isProjectTrusted: () => false,
		sessionManager: {
			getEntries: () => entries.map((e) => ({ type: e.type, customType: e.customType, data: e.data })),
			getSessionFile: () => "/tmp/workbench-project/session.jsonl",
			getSessionId: () => "stub-session-id",
		} as unknown as ExtensionContext["sessionManager"],
		model: undefined,
		thinkingLevel: undefined,
		ui: {
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => false,
		} as unknown as ExtensionContext["ui"],
		signal: undefined,
		...overrides,
	} as unknown as ExtensionContext;
}

function entry(customType: string, data: unknown): StubAPI["entries"][number] {
	return { type: "custom", customType, data };
}

const SOL_MODEL = { provider: "openai-codex", id: "gpt-5.6-sol", api: "responses" } as never;

/** Commander tests must never inherit a worker-role env from the harness. */
before(() => {
	delete process.env[WORKER_ROLE_ENV];
});

/** Run a block with the worker role env set, restoring the previous value after. */
function withWorkerRole(fn: () => void): void {
	const previous = process.env[WORKER_ROLE_ENV];
	process.env[WORKER_ROLE_ENV] = "worker";
	try {
		fn();
	} finally {
		if (previous === undefined) delete process.env[WORKER_ROLE_ENV];
		else process.env[WORKER_ROLE_ENV] = previous;
	}
}

/** Fire session_start as approved GPT-5.6 Sol (sets the commander identity). */
async function solSession(stub: StubAPI, entries: StubAPI["entries"] = []): Promise<void> {
	const handlers = stub.events.get("session_start");
	assert.ok(handlers && handlers.length > 0);
	await handlers[0]!({ type: "session_start", reason: "resume" } as never, fakeCtx(entries, { model: SOL_MODEL }) as never);
}

// ---------------------------------------------------------------------------
// newSession harness: simulates Pi's exact ordering — session_start("new")
// fires BEFORE setup against the fresh target, then withSession runs with a
// replacement context whose reload() re-fires session_start("reload") over
// the setup-appended target entries.
// ---------------------------------------------------------------------------

interface NewSessionHarness {
	parentSession?: string;
	cancelled: boolean;
	setupRan: boolean;
	withSessionRan: boolean;
	reloadCalls: number;
	waitForIdleCalls: number;
	/** "announce" per replacement notify, then "reload" — ordering proof. */
	orderEvents: string[];
	replacementNotifyLines: string[];
	oldNotifyLines: string[];
	targetEntries: TargetEntry[];
}

/** Target-session entry shape: custom records + hidden custom messages. */
interface TargetEntry {
	type: string;
	customType: string;
	data?: unknown;
	content?: unknown;
	display?: boolean;
	details?: unknown;
}

function makeHarness(opts: { cancelled?: boolean } = {}): NewSessionHarness {
	return {
		cancelled: opts.cancelled ?? false,
		setupRan: false,
		withSessionRan: false,
		reloadCalls: 0,
		waitForIdleCalls: 0,
		orderEvents: [],
		replacementNotifyLines: [],
		oldNotifyLines: [],
		targetEntries: [],
	};
}

/** SessionManager-shaped stub used by the setup callback (records into the target). */
function makeTargetSessionManager(harness: NewSessionHarness): unknown {
	return {
		appendCustomEntry: (customType: string, data?: unknown): string => {
			harness.targetEntries.push({ type: "custom", customType, data });
			return `entry-${harness.targetEntries.length}`;
		},
		appendCustomMessageEntry: (customType: string, content: string, display: boolean, details?: unknown): string => {
			harness.targetEntries.push({ type: "custom_message", customType, content, display, details });
			return `msg-${harness.targetEntries.length}`;
		},
	};
}

function attachNewSession(stub: StubAPI, harness: NewSessionHarness): ExtensionCommandContext["newSession"] {
	const sessionStart = stub.events.get("session_start")![0]!;
	return async (options) => {
		harness.parentSession = options?.parentSession;
		if (harness.cancelled) return { cancelled: true };
		// Pi ordering: session_start("new") fires BEFORE setup, against the
		// empty fresh target session.
		await sessionStart(
			{ type: "session_start", reason: "new", previousSessionFile: options?.parentSession } as never,
			fakeCtx(harness.targetEntries, { model: SOL_MODEL }) as never,
		);
		harness.setupRan = true;
		if (options?.setup) await options.setup(makeTargetSessionManager(harness) as never);
		harness.withSessionRan = true;
		const replacementCtx = {
			...fakeCtx(harness.targetEntries, { model: SOL_MODEL }),
			mode: "tui",
			hasUI: true,
			ui: {
				notify: (text: string) => {
					harness.replacementNotifyLines.push(text);
					harness.orderEvents.push("announce");
				},
				setStatus: () => {},
				setWidget: () => {},
				confirm: async () => false,
			},
			reload: async () => {
				harness.reloadCalls += 1;
				harness.orderEvents.push("reload");
				await sessionStart(
					{ type: "session_start", reason: "reload" } as never,
					fakeCtx(harness.targetEntries, { model: SOL_MODEL }) as never,
				);
			},
		} as unknown as ExtensionCommandContext;
		if (options?.withSession) await options.withSession(replacementCtx as never);
		return { cancelled: false };
	};
}

/** Run the REAL registered /q-milestone-handoff handler against the harness. */
async function runMilestoneCommand(
	stub: StubAPI,
	sourceEntries: StubAPI["entries"],
	harness: NewSessionHarness,
	args: string,
	overrides: Partial<ExtensionCommandContext> = {},
): Promise<void> {
	const def = stub.commands.get("q-milestone-handoff") as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
	assert.ok(def, "q-milestone-handoff registered");
	const ctx = {
		...fakeCtx(sourceEntries, { model: SOL_MODEL }),
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (text: string) => {
				harness.oldNotifyLines.push(text);
			},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => false,
		},
		waitForIdle: async () => {
			harness.waitForIdleCalls += 1;
		},
		newSession: attachNewSession(stub, harness),
		...overrides,
	} as unknown as ExtensionCommandContext;
	await def.handler(args, ctx);
}

let milestoneGuardSerial = 0;

/** Run all guards for one real fresh-turn tool call with a unique Pi id. */
async function guardCall(stub: StubAPI, toolName: string, input: unknown): Promise<{ block?: boolean; reason?: string } | undefined> {
	milestoneGuardSerial += 1;
	const ctx = fakeCtx([]) as never;
	for (const handler of stub.events.get("turn_start") ?? []) {
		await handler({ type: "turn_start", turnIndex: milestoneGuardSerial } as never, ctx);
	}
	for (const guard of stub.events.get("tool_call") ?? []) {
		const result = (await guard({
			type: "tool_call",
			toolCallId: `milestone-guard-${milestoneGuardSerial}`,
			toolName,
			input,
		} as never, ctx)) as { block?: boolean; reason?: string } | undefined;
		if (result !== undefined) return result;
	}
	return undefined;
}

// ===========================================================================
// Pure module: UTF-8 helpers, next-step parser, ids, snapshot, records,
// fail-closed restore/load, hidden note
// ===========================================================================

test("utf8 helpers are exact and code-point safe", () => {
	assert.equal(utf8ByteLength(""), 0);
	assert.equal(utf8ByteLength("abc"), 3);
	assert.equal(utf8ByteLength("é"), 2, "2-byte code point");
	assert.equal(utf8ByteLength("😀"), 4, "4-byte code point (surrogate pair)");
	assert.equal(utf8ByteLength("a😀é"), 1 + 4 + 2);
	// Truncation never splits a code point.
	assert.equal(truncateUtf8("😀😀", 4), "😀");
	assert.equal(truncateUtf8("😀😀", 3), "", "a 4-byte code point does not fit in 3 bytes");
	assert.equal(truncateUtf8("abcdef", 3), "abc");
	assert.equal(truncateUtf8("abcdef", 6), "abcdef");
	assert.equal(truncateUtf8("x", 0), "");
	// Char truncation is surrogate-safe too.
	assert.equal(truncateChars("a😀b", 2), "a");
	assert.equal(truncateChars("a😀b", 3), "a😀");
	assert.equal(truncateChars("abc", 5), "abc");
});

test("parseNextStepArg trims and rejects empty and overlong next steps", () => {
	const empty = parseNextStepArg("");
	assert.equal(empty.ok, false);
	if (!empty.ok) assert.match(empty.error, /must not be empty/);
	assert.equal(parseNextStepArg("   ").ok, false);
	const trimmed = parseNextStepArg("  run the q3 verification  ");
	assert.ok(trimmed.ok);
	if (trimmed.ok) assert.equal(trimmed.nextStep, "run the q3 verification");
	// Character cap: exactly MAX is accepted, one more is rejected.
	const atCap = parseNextStepArg("x".repeat(MAX_NEXT_STEP_CHARS));
	assert.ok(atCap.ok);
	const over = parseNextStepArg("x".repeat(MAX_NEXT_STEP_CHARS + 1));
	assert.equal(over.ok, false);
	if (!over.ok) {
		assert.match(over.error, /too long/);
		assert.match(over.error, new RegExp(String(MAX_NEXT_STEP_CHARS)));
	}
	// The UTF-8 byte cap is enforced explicitly as defense in depth.
	assert.equal(utf8ByteLength("😀".repeat(120)), 480);
});

test("makeMilestoneId is bounded and shaped", () => {
	const id = makeMilestoneId(new Date("2026-08-05T23:53:25.000Z"));
	assert.ok(id.length <= MAX_MILESTONE_ID_LENGTH, `id ${id} exceeds ${MAX_MILESTONE_ID_LENGTH}`);
	assert.match(id, /^mh-\d{8}-\d{6}-[a-z0-9]{4}$/);
});

test("buildMilestoneSnapshot re-caps, redacts and normalizes", () => {
	const state: ReturnType<typeof emptyCompactState> = {
		...emptyCompactState("VERIFY"),
		mode: "bogus-mode",
		task: "verify sk-abcdefghijklmnop supersecretvalue " + "y".repeat(500),
		modifiedFiles: Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts` + "z".repeat(300)),
		evidencePaths: Array.from({ length: 12 }, (_, i) => `.pi/workbench/runs/run-${i}`),
		doNotRetry: Array.from({ length: 10 }, (_, i) => `recipe "r${i}" failed`),
		passedGates: Array.from({ length: 20 }, (_, i) => `q${i}`),
	};
	const snapshot = buildMilestoneSnapshot(state, ["supersecretvalue"]);
	// Mode normalized; caps re-applied exactly like the compact supplement.
	assert.equal(snapshot.mode, "DEV", "unknown mode falls back to DEV");
	assert.equal(snapshot.modifiedFiles.length, MAX_MODIFIED_FILES);
	assert.equal(snapshot.evidencePaths.length, MAX_EVIDENCE_PATHS);
	assert.equal(snapshot.doNotRetry.length, MAX_DO_NOT_RETRY);
	assert.equal(snapshot.passedGates.length, MAX_GATES);
	for (const item of snapshot.modifiedFiles) assert.ok(item.length <= 240, "per-item cap after redaction");
	assert.ok(snapshot.task !== undefined && snapshot.task.length <= 240, "string cap after redaction");
	// Redaction: env-derived secret values AND credential shapes are scrubbed.
	assert.ok(snapshot.task !== undefined && !snapshot.task.includes("supersecretvalue"), "env secret value redacted");
	assert.ok(snapshot.task !== undefined && !snapshot.task.includes("sk-abcdefghijklmnop"), "credential shape redacted");
	assert.ok(snapshot.task !== undefined && snapshot.task.includes("[REDACTED]"));
	// Re-cap after redaction: a field at the cap that GROWS via [REDACTED]
	// replacement stays within the cap.
	const grow = buildMilestoneSnapshot({ ...emptyCompactState("DEV"), task: "ab".repeat(120) }, ["ab"]);
	assert.ok(grow.task !== undefined && grow.task.length <= 240, "post-redaction growth is re-capped");
});

test("prepare/resumed/cancelled records form the deterministic lifecycle chain", () => {
	const prepared = prepareMilestoneHandoff({
		milestoneId: "mh-20260805-235325-abcd",
		nextStep: "run the q3 verification",
		session: "/sessions/source.jsonl",
		state: { ...emptyCompactState("AUDIT"), task: "verify q3" },
		secrets: [],
		now: "2026-08-05T23:53:25.000Z",
	});
	assert.equal(prepared.schema_version, MILESTONE_HANDOFF_SCHEMA_VERSION);
	assert.equal(prepared.lifecycle, "prepared");
	assert.equal(prepared.milestone_id, "mh-20260805-235325-abcd");
	assert.equal(prepared.next_step, "run the q3 verification");
	assert.equal(prepared.session, "/sessions/source.jsonl");
	assert.equal(prepared.updated_at, "2026-08-05T23:53:25.000Z");
	assert.equal(prepared.state?.mode, "AUDIT");
	assert.equal(prepared.state?.task, "verify q3");
	// The explicit next step is authoritative and stored identically in the
	// record and the copied CompactState snapshot (never stale/undefined).
	assert.equal(prepared.state?.nextStep, prepared.next_step);
	// Resumed: same milestone id / next step / session / snapshot, new lifecycle.
	const resumed = toResumedRecord(prepared, "2026-08-05T23:53:40.000Z");
	assert.equal(resumed.lifecycle, "resumed");
	assert.equal(resumed.milestone_id, prepared.milestone_id);
	assert.equal(resumed.next_step, prepared.next_step);
	assert.equal(resumed.session, prepared.session);
	assert.deepEqual(resumed.state, prepared.state);
	assert.equal(resumed.updated_at, "2026-08-05T23:53:40.000Z");
	// Cancelled: additive source record, same pointers, no snapshot needed.
	const cancelled = toCancelledRecord(prepared, "2026-08-05T23:53:45.000Z");
	assert.equal(cancelled.lifecycle, "cancelled");
	assert.equal(cancelled.milestone_id, prepared.milestone_id);
	assert.equal(cancelled.next_step, prepared.next_step);
	assert.equal(cancelled.session, prepared.session);
	assert.equal(cancelled.state, undefined);
});

test("an env-secret next step is redacted once and mirrored identically into the record, snapshot and hidden note", () => {
	const secrets = ["supersecretvalue", "mh-token-9f8e7d6c"];
	const prepared = prepareMilestoneHandoff({
		milestoneId: "mh-20260805-235325-abcd",
		nextStep: "rotate supersecretvalue and keep mh-token-9f8e7d6c out of context",
		session: "/sessions/source.jsonl",
		// A STALE pre-existing snapshot nextStep: it must never win over the
		// explicit next step and its secret must never persist via the copy.
		state: { ...emptyCompactState("DEV"), nextStep: "stale supersecretvalue step" },
		secrets,
		now: "2026-08-05T23:53:25.000Z",
	});
	// The explicit next step is redacted in the lifecycle record…
	assert.ok(!prepared.next_step.includes("supersecretvalue"), "env secret redacted in record.next_step");
	assert.ok(!prepared.next_step.includes("mh-token-9f8e7d6c"), "env secret redacted in record.next_step");
	assert.ok(prepared.next_step.includes("[REDACTED]"));
	// …and the copied snapshot carries the SAME redacted value (the stale
	// snapshot nextStep is replaced, never kept).
	assert.equal(prepared.state?.nextStep, prepared.next_step, "snapshot nextStep exactly equals the record next step");
	assert.ok(!prepared.state?.nextStep?.includes("supersecretvalue"), "stale snapshot secret never persists");
	// The lifecycle chain keeps the redacted value everywhere.
	const resumed = toResumedRecord(prepared, "2026-08-05T23:53:40.000Z");
	assert.equal(resumed.next_step, prepared.next_step);
	assert.equal(resumed.state?.nextStep, prepared.next_step);
	const cancelled = toCancelledRecord(prepared, "2026-08-05T23:53:45.000Z");
	assert.equal(cancelled.next_step, prepared.next_step);
	// The hidden note never carries the secret either.
	const note = buildMilestoneHandoffNote(resumed);
	assert.ok(!note.includes("supersecretvalue"), "env secret redacted in the hidden note");
	assert.ok(!note.includes("mh-token-9f8e7d6c"), "env secret redacted in the hidden note");
	assert.ok(note.includes("[REDACTED]"));
	// Redaction can GROW the value ([REDACTED] is longer than the secret):
	// prepare re-caps after redaction (code-point and UTF-8 safe) and the
	// result still round-trips through the fail-closed loader.
	const growSecret = "xyzw";
	const grow = prepareMilestoneHandoff({
		milestoneId: "mh-20260805-235325-abcd",
		nextStep: growSecret.repeat(70), // 280 raw chars; grows past the cap once redacted
		session: "/sessions/source.jsonl",
		state: { ...emptyCompactState("DEV") },
		secrets: [growSecret],
		now: "2026-08-05T23:53:25.000Z",
	});
	assert.ok(grow.next_step.length <= MAX_NEXT_STEP_CHARS, "re-capped after redaction (chars)");
	assert.ok(utf8ByteLength(grow.next_step) <= MAX_NEXT_STEP_BYTES, "re-capped after redaction (bytes)");
	assert.ok(!grow.next_step.includes(growSecret), "grown redacted value stays redacted");
	assert.equal(grow.state?.nextStep, grow.next_step);
	const restoredGrow = restoreMilestoneHandoff(grow);
	assert.ok(restoredGrow, "redacted/grown record still passes its own fail-closed loader");
	assert.equal(restoredGrow?.next_step, grow.next_step);
	assert.equal(restoredGrow?.state?.nextStep, grow.next_step, "restored snapshot carries the same explicit next step");
	// Persistence into later compaction: the copied snapshot's nextStep
	// survives a target reload and the compaction supplement retains it.
	const reloaded = loadCompactStateFromEntries(
		[{ type: "custom", customType: COMPACT_STATE_ENTRY_TYPE, data: resumed.state }],
		"DEV",
	);
	assert.equal(reloaded.nextStep, resumed.next_step, "target reload keeps the explicit handoff next step");
	assert.ok(buildCompactNote(reloaded).includes(resumed.next_step), "compaction supplement retains the explicit handoff next step");
});

test("prepare bounds and redacts every record string so its own loader always accepts the record", () => {
	// Overlong ASCII + multibyte inputs across every record field.
	const prepared = prepareMilestoneHandoff({
		milestoneId: "mh-" + "x".repeat(200),
		nextStep: "y".repeat(300), // over the parser cap — prepare re-caps
		session: "/sessions/" + "路径".repeat(300), // 600 multibyte code points
		state: { ...emptyCompactState("DEV"), task: "件".repeat(500) },
		secrets: [],
		now: "2026-08-05T23:53:25.000Z" + "z".repeat(80),
	});
	// Every persisted field is within its explicit bound.
	assert.ok(prepared.milestone_id.length <= MAX_MILESTONE_ID_LENGTH, "milestone id bounded");
	assert.ok(prepared.next_step.length <= MAX_NEXT_STEP_CHARS, "next step char-bounded");
	assert.ok(utf8ByteLength(prepared.next_step) <= MAX_NEXT_STEP_BYTES, "next step byte-bounded");
	assert.ok(prepared.session.length <= MAX_SESSION_POINTER_LENGTH, "session pointer bounded");
	assert.ok(prepared.updated_at.length <= MAX_TIMESTAMP_LENGTH, "timestamp bounded");
	// Multibyte truncation never splits a code point.
	assert.equal(
		new TextDecoder().decode(new TextEncoder().encode(prepared.session)),
		prepared.session,
		"session pointer truncation never splits a surrogate pair",
	);
	assert.equal(
		new TextDecoder().decode(new TextEncoder().encode(prepared.next_step)),
		prepared.next_step,
		"next-step truncation never splits a surrogate pair",
	);
	// The record passes its own fail-closed loader unchanged.
	const restored = restoreMilestoneHandoff(prepared);
	assert.ok(restored, "prepare can never build a record its own loader rejects");
	assert.equal(restored?.milestone_id, prepared.milestone_id);
	assert.equal(restored?.next_step, prepared.next_step);
	assert.equal(restored?.session, prepared.session);
	assert.equal(restored?.updated_at, prepared.updated_at);
	assert.equal(restored?.state?.nextStep, prepared.next_step);
	assert.equal(restored?.state?.task, prepared.state?.task);
	// The session pointer is redacted too (defensive — it is persisted
	// outside model context, but an env-secret value must not land there).
	const secretPath = prepareMilestoneHandoff({
		milestoneId: "mh-20260805-235325-abcd",
		nextStep: "run the q3 verification",
		session: "/home/ops/supersecretvalue/projects/source.jsonl",
		state: { ...emptyCompactState("DEV") },
		secrets: ["supersecretvalue"],
		now: "2026-08-05T23:53:25.000Z",
	});
	assert.ok(!secretPath.session.includes("supersecretvalue"), "session pointer redacted");
	assert.ok(restoreMilestoneHandoff(secretPath), "redacted pointer still loadable");
});

test("restoreMilestoneHandoff fails closed on unknown schema, lifecycle, empty/overlong fields and malformed state", () => {
	const valid = {
		schema_version: 1,
		lifecycle: "prepared",
		milestone_id: "mh-20260805-235325-abcd",
		next_step: "run the q3 verification",
		session: "/sessions/source.jsonl",
		updated_at: "2026-08-05T23:53:25.000Z",
	};
	assert.ok(restoreMilestoneHandoff(valid), "valid record restores");
	// Unknown schema / missing schema / non-object payloads.
	assert.equal(restoreMilestoneHandoff(undefined), undefined);
	assert.equal(restoreMilestoneHandoff(null), undefined);
	assert.equal(restoreMilestoneHandoff("text"), undefined);
	assert.equal(restoreMilestoneHandoff({ ...valid, schema_version: 2 }), undefined);
	assert.equal(restoreMilestoneHandoff({ ...valid, schema_version: undefined }), undefined);
	// Unknown lifecycle values.
	for (const lifecycle of ["done", "started", "finished", 1, ""]) {
		assert.equal(restoreMilestoneHandoff({ ...valid, lifecycle }), undefined, `lifecycle ${String(lifecycle)}`);
	}
	// Empty / missing / overlong required fields.
	assert.equal(restoreMilestoneHandoff({ ...valid, next_step: "" }), undefined);
	assert.equal(restoreMilestoneHandoff({ ...valid, next_step: undefined }), undefined);
	assert.equal(restoreMilestoneHandoff({ ...valid, next_step: "x".repeat(MAX_NEXT_STEP_CHARS + 1) }), undefined);
	assert.equal(restoreMilestoneHandoff({ ...valid, milestone_id: "" }), undefined);
	assert.equal(restoreMilestoneHandoff({ ...valid, milestone_id: "x".repeat(MAX_MILESTONE_ID_LENGTH + 1) }), undefined);
	assert.equal(restoreMilestoneHandoff({ ...valid, session: "" }), undefined);
	assert.equal(restoreMilestoneHandoff({ ...valid, session: "x".repeat(MAX_SESSION_POINTER_LENGTH + 1) }), undefined);
	assert.equal(restoreMilestoneHandoff({ ...valid, updated_at: "" }), undefined);
	assert.equal(restoreMilestoneHandoff({ ...valid, updated_at: "x".repeat(MAX_TIMESTAMP_LENGTH + 1) }), undefined);
	// A malformed state snapshot invalidates the whole record.
	assert.equal(restoreMilestoneHandoff({ ...valid, state: "not-an-object" }), undefined);
	assert.equal(restoreMilestoneHandoff({ ...valid, state: null }), undefined);
	// Unknown extra fields are tolerated (additive schema).
	const withExtra = restoreMilestoneHandoff({ ...valid, future_field: "ignored" });
	assert.ok(withExtra, "unknown extra fields do not invalidate a v1 record");
	// Restored records are normalized: trimmed fields, sanitized state,
	// hostile state mode normalized fail-closed.
	const restored = restoreMilestoneHandoff({
		...valid,
		milestone_id: "  mh-20260805-235325-abcd  ",
		state: { mode: "weird", modifiedFiles: ["a", "b", ...Array.from({ length: 30 }, (_, i) => `f${i}`)] },
	});
	assert.ok(restored);
	assert.equal(restored.milestone_id, "mh-20260805-235325-abcd", "trimmed");
	assert.equal(restored.state?.mode, "DEV", "hostile state mode normalized");
	assert.ok((restored.state?.modifiedFiles.length ?? 0) <= MAX_MODIFIED_FILES, "hostile state lists re-capped");
});

test("loadMilestoneHandoffs ignores unknown/malformed records and never touches legacy entries", () => {
	const valid = {
		schema_version: 1,
		lifecycle: "prepared",
		milestone_id: "mh-20260805-235325-abcd",
		next_step: "run the q3 verification",
		session: "/sessions/source.jsonl",
		updated_at: "2026-08-05T23:53:25.000Z",
	};
	const entries = [
		entry(MODE_ENTRY_TYPE, { mode: "AUDIT" }),
		entry(COMPACT_STATE_ENTRY_TYPE, { task: "legacy task" }),
		entry(LEASE_STATE_ENTRY_TYPE, { id: "wl-1" }),
		entry(DELEGATION_STATE_ENTRY_TYPE, { latestId: "20260801-120000-abcd" }),
		entry(MILESTONE_HANDOFF_ENTRY_TYPE, valid),
		entry(MILESTONE_HANDOFF_ENTRY_TYPE, { ...valid, lifecycle: "bogus" }),
		entry(MILESTONE_HANDOFF_ENTRY_TYPE, { ...valid, schema_version: 99 }),
		entry(MILESTONE_HANDOFF_ENTRY_TYPE, { ...valid, lifecycle: "resumed" }),
	];
	const snapshot = JSON.parse(JSON.stringify(entries)) as StubAPI["entries"];
	const loaded = loadMilestoneHandoffs(entries);
	assert.equal(loaded.length, 2, "only the two valid milestone records load");
	assert.equal(loaded[0]?.lifecycle, "prepared");
	assert.equal(loaded[1]?.lifecycle, "resumed");
	assert.deepEqual(entries, snapshot, "entries are never mutated, migrated or rewritten");
	// latestMilestoneHandoff returns the last valid record.
	const latest = latestMilestoneHandoff(entries);
	assert.equal(latest?.lifecycle, "resumed");
	assert.equal(latestMilestoneHandoff([]), undefined);
	// A non-custom entry type with the matching customType is not a record.
	assert.equal(loadMilestoneHandoffs([{ type: "message", customType: MILESTONE_HANDOFF_ENTRY_TYPE, data: valid }]).length, 0);
});

test("the hidden note is deterministic, bounded, redacted and pointers-only", () => {
	const prepared = prepareMilestoneHandoff({
		milestoneId: "mh-20260805-235325-abcd",
		nextStep: "run the q3 verification",
		session: "/sessions/source.jsonl",
		state: {
			...emptyCompactState("AUDIT"),
			task: "verify q3",
			lastDelegationId: "20260801-120000-abcd",
			pendingDelegationReview: true,
			lastRunId: "20260801-120000-abcd",
			lastRecipe: "unit-test",
			passedGates: ["b6"],
			failedGates: ["q3 (run 20260801-120000-abcd)"],
			commanderWritesDenied: true,
		},
		secrets: [],
		now: "2026-08-05T23:53:25.000Z",
	});
	const resumed = toResumedRecord(prepared, "2026-08-05T23:53:40.000Z");
	const note = buildMilestoneHandoffNote(resumed);
	// Deterministic: same record, same note.
	assert.equal(buildMilestoneHandoffNote(resumed), note);
	// Pointers/status only — never logs.
	assert.ok(note.includes("milestone: mh-20260805-235325-abcd"));
	assert.ok(note.includes("lifecycle: resumed"));
	// The absolute source session path NEVER enters model context: the note
	// renders only the fixed parent-linked fact (the pointer is persisted in
	// the record outside LLM context).
	assert.ok(note.includes("source session: parent-linked (pointer persisted outside model context)"));
	assert.ok(!note.includes("/sessions/source.jsonl"), "note excludes the absolute source session path");
	assert.ok(!note.includes("source.jsonl"), "note excludes any source session file name");
	assert.ok(note.includes("next step: run the q3 verification"));
	assert.ok(note.includes("mode: AUDIT"));
	assert.ok(note.includes("delegation: 20260801-120000-abcd PENDING_REVIEW"));
	assert.ok(note.includes("last run: 20260801-120000-abcd (unit-test)"));
	assert.ok(note.includes("development writes: ordinary paths direct; high-risk lease never carried"));
	assert.ok(!note.includes("stdout") && !note.includes("stderr"), "no log content");
	assert.ok(!note.includes("[truncated]"), "small note is never truncated");
	// Hard caps: the note never exceeds the line/char/byte bounds, even when
	// the bounded fields are at their maximum (many multibyte items).
	const huge = prepareMilestoneHandoff({
		milestoneId: "mh-20260805-235325-abcd",
		nextStep: "run the q3 verification",
		session: "/sessions/source.jsonl",
		state: {
			...emptyCompactState("DEV"),
			task: "件".repeat(240),
			modifiedFiles: Array.from({ length: MAX_MODIFIED_FILES }, () => "件".repeat(240)),
			evidencePaths: Array.from({ length: MAX_EVIDENCE_PATHS }, () => "证".repeat(240)),
			doNotRetry: Array.from({ length: MAX_DO_NOT_RETRY }, () => "忌".repeat(240)),
		},
		secrets: [],
		now: "2026-08-05T23:53:25.000Z",
	});
	const hugeNote = buildMilestoneHandoffNote(huge);
	assert.ok(utf8ByteLength(hugeNote) <= MAX_HANDOFF_NOTE_BYTES, `note bytes ${utf8ByteLength(hugeNote)} > ${MAX_HANDOFF_NOTE_BYTES}`);
	assert.ok(hugeNote.length <= MAX_HANDOFF_NOTE_CHARS, `note chars ${hugeNote.length} > ${MAX_HANDOFF_NOTE_CHARS}`);
	const contentLines = hugeNote.replace(/\n\[truncated\]$/, "").split("\n");
	assert.ok(contentLines.length <= MAX_HANDOFF_NOTE_LINES, `note lines ${contentLines.length} > ${MAX_HANDOFF_NOTE_LINES}`);
	assert.ok(hugeNote.endsWith("[truncated]"), "overlong note is visibly truncated");
	// Defense-in-depth shape redaction in the note itself.
	const secret = prepareMilestoneHandoff({
		milestoneId: "mh-20260805-235325-abcd",
		nextStep: "rotate the sk-abcdefghijklmnop key",
		session: "/sessions/source.jsonl",
		state: { ...emptyCompactState("DEV") },
		secrets: [],
		now: "2026-08-05T23:53:25.000Z",
	});
	const secretNote = buildMilestoneHandoffNote(secret);
	assert.ok(secretNote.includes("[REDACTED]"), "credential shapes never reach the hidden note");
	assert.ok(!secretNote.includes("sk-abcdefghijklmnop"));
});

test("line truncation is explicitly marked and the marker stays inside every cap", () => {
	// A hand-built record with far more note lines than MAX_HANDOFF_NOTE_LINES
	// (the fail-closed loader could never produce such a record — the note
	// builder still accounts for dropped lines deterministically).
	const manyLines: MilestoneHandoffRecord = {
		schema_version: 1,
		lifecycle: "resumed",
		milestone_id: "mh-20260805-235325-abcd",
		next_step: "run the q3 verification",
		session: "/sessions/source.jsonl",
		updated_at: "2026-08-05T23:53:40.000Z",
		state: {
			...emptyCompactState("DEV"),
			doNotRetry: Array.from({ length: 120 }, (_, i) => `item ${i}`),
		},
	};
	const note = buildMilestoneHandoffNote(manyLines);
	assert.ok(note.endsWith("\n[truncated]"), "dropped lines are explicitly marked");
	// The FULL note (content + marker) stays inside every cap: lines, chars
	// and UTF-8 bytes.
	assert.ok(
		note.split("\n").length <= MAX_HANDOFF_NOTE_LINES,
		`note lines ${note.split("\n").length} > ${MAX_HANDOFF_NOTE_LINES}`,
	);
	assert.ok(note.length <= MAX_HANDOFF_NOTE_CHARS, `note chars ${note.length} > ${MAX_HANDOFF_NOTE_CHARS}`);
	assert.ok(utf8ByteLength(note) <= MAX_HANDOFF_NOTE_BYTES, `note bytes ${utf8ByteLength(note)} > ${MAX_HANDOFF_NOTE_BYTES}`);
	// The marker's own line is reserved INSIDE the line cap: the content
	// before the marker is capped one line short of the full bound.
	const content = note.slice(0, -"\n[truncated]".length);
	assert.ok(
		content.split("\n").length <= MAX_HANDOFF_NOTE_LINES - 1,
		`content lines ${content.split("\n").length} leave room for the marker`,
	);
});

// ===========================================================================
// Wiring: the REAL registered /q-milestone-handoff command
// ===========================================================================

test("the milestone handoff is registered as a user-only command, never a tool", () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	assert.ok(stub.commands.has("q-milestone-handoff"), "registered as a command");
	assert.ok(!stub.tools.has("q-milestone-handoff"), "never a model tool");
	const def = stub.commands.get("q-milestone-handoff") as { description?: string };
	assert.ok((def.description ?? "").length > 10, "has a description");
});

test("worker role is refused with no mutation and no session control", async () => {
	const stub = makeStub();
	withWorkerRole(() => workbenchRuntime(stub));
	await solSession(stub);
	const harness = makeHarness();
	await runMilestoneCommand(stub, [], harness, "run the q3 verification");
	assert.match(harness.oldNotifyLines.join("\n"), /user-only/);
	assert.equal(harness.waitForIdleCalls, 0, "no idle wait before the refusal");
	assert.equal(harness.parentSession, undefined, "newSession never called");
	assert.equal(stub.appendEntryCalls.length, 0, "no entry appended");
	assert.equal(harness.targetEntries.length, 0);
});

test("empty and overlong next steps are rejected before any session control", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	await solSession(stub);
	for (const bad of ["", "   ", "x".repeat(MAX_NEXT_STEP_CHARS + 1)]) {
		const harness = makeHarness();
		await runMilestoneCommand(stub, [], harness, bad);
		const output = harness.oldNotifyLines.join("\n");
		assert.match(output, /q-milestone-handoff:/, JSON.stringify(bad.slice(0, 20)));
		assert.match(output, /usage: \/q-milestone-handoff/, JSON.stringify(bad.slice(0, 20)));
		assert.equal(harness.waitForIdleCalls, 0, "parse failure happens before waitForIdle");
		assert.equal(harness.parentSession, undefined, "newSession never called");
		assert.equal(stub.appendEntryCalls.length, 0, "no entry appended");
	}
});

test("an unpersisted current session is refused after waitForIdle with no mutation", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	await solSession(stub);
	const harness = makeHarness();
	await runMilestoneCommand(
		stub,
		[],
		harness,
		"run the q3 verification",
		{ sessionManager: { getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => "stub" } } as never,
	);
	assert.match(harness.oldNotifyLines.join("\n"), /not persisted/);
	assert.equal(harness.waitForIdleCalls, 1, "waitForIdle runs before the persisted-file requirement");
	assert.equal(harness.parentSession, undefined, "newSession never called");
	assert.equal(stub.appendEntryCalls.length, 0, "no entry appended");
});

test("successful handoff: idle wait, prepared record, parent link, setup entries, replacement-only announce+reload, restored target with locked writes", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	// Source state: AUDIT mode, compact task, REVIEWED delegation with two
	// blocked-write audit counters (proves the exact copy + restore).
	const recorded = recordDelegation(emptyDelegationState(), {
		id: "20260801-120000-abcd",
		diffHash: "a".repeat(64),
		now: "2026-08-01T12:00:00.000Z",
	});
	if (!recorded.ok) throw new Error(recorded.error);
	const reviewed = markReviewed(recorded.state, "2026-08-01T12:05:00.000Z");
	if (!reviewed.ok) throw new Error(reviewed.error);
	const blocked = recordBlockedWriteAttempt(recordBlockedWriteAttempt(reviewed.state, "2026-08-01T12:06:00.000Z"), "2026-08-01T12:07:00.000Z");
	const sourceEntries = [
		entry(MODE_ENTRY_TYPE, { mode: "AUDIT" }),
		entry(COMPACT_STATE_ENTRY_TYPE, { mode: "AUDIT", task: "verify q3 milestone task", failedGates: ["q3 (run 20260801-120000-abcd)"] }),
		entry(DELEGATION_STATE_ENTRY_TYPE, serializeDelegationState(blocked)),
	];
	await solSession(stub, sourceEntries);
	const harness = makeHarness();
	await runMilestoneCommand(stub, sourceEntries, harness, "run the q3 verification and write the report");

	// waitForIdle happened, then the parent link points at the persisted source.
	assert.equal(harness.waitForIdleCalls, 1);
	assert.equal(harness.parentSession, "/tmp/workbench-project/session.jsonl");

	// Persist-first: exactly one additive prepared record in the SOURCE.
	const milestoneAppends = stub.appendEntryCalls.filter((c) => c.customType === MILESTONE_HANDOFF_ENTRY_TYPE);
	assert.equal(milestoneAppends.length, 1, "one prepared record, no cancelled record");
	const prepared = milestoneAppends[0]!.data as {
		schema_version: number;
		lifecycle: string;
		milestone_id: string;
		next_step: string;
		session: string;
		state?: { mode?: string; task?: string; nextStep?: string };
	};
	assert.equal(prepared.schema_version, MILESTONE_HANDOFF_SCHEMA_VERSION);
	assert.equal(prepared.lifecycle, "prepared");
	assert.ok(prepared.milestone_id.startsWith("mh-"));
	assert.equal(prepared.next_step, "run the q3 verification and write the report");
	assert.equal(prepared.session, harness.parentSession);
	assert.equal(prepared.state?.mode, "AUDIT");
	assert.equal(prepared.state?.task, "verify q3 milestone task");
	assert.equal(prepared.state?.nextStep, prepared.next_step, "copied CompactState nextStep equals the redacted record next step");
	// The prepared record is machine-readable through the pure loader.
	const restoredPrepared = loadMilestoneHandoffs(stub.entries);
	assert.equal(restoredPrepared.length, 1);
	assert.equal(restoredPrepared[0]!.lifecycle, "prepared");

	// Setup ran and appended the exact target records IN ORDER.
	assert.ok(harness.setupRan, "setup executed");
	assert.ok(harness.withSessionRan, "withSession executed");
	assert.equal(harness.targetEntries.length, 5);
	const resumedEntry = harness.targetEntries[0]!;
	const noteEntry = harness.targetEntries[1]!;
	const modeEntry = harness.targetEntries[2]!;
	const compactEntry = harness.targetEntries[3]!;
	const delegationEntry = harness.targetEntries[4]!;
	// 1) resumed milestone record (same milestone id / pointers / snapshot).
	assert.equal(resumedEntry.customType, MILESTONE_HANDOFF_ENTRY_TYPE);
	assert.equal((resumedEntry.data as { lifecycle?: string }).lifecycle, "resumed");
	assert.equal((resumedEntry.data as { milestone_id?: string }).milestone_id, prepared.milestone_id);
	assert.equal((resumedEntry.data as { session?: string }).session, prepared.session);
	assert.deepEqual((resumedEntry.data as { state?: unknown }).state, prepared.state);
	// 2) hidden custom milestone message: display false, no trigger turn,
	//    deterministic bounded note, pointers/details only.
	assert.equal(noteEntry.type, "custom_message");
	assert.equal(noteEntry.customType, MILESTONE_HANDOFF_NOTE_ENTRY_TYPE);
	assert.equal(noteEntry.display, false, "hidden from the TUI");
	const note = String(noteEntry.content);
	// Deterministic round-trip: the note equals the note derived from the
	// TARGET's own resumed record (lifecycle: resumed).
	const restoredResumed = loadMilestoneHandoffs(harness.targetEntries);
	assert.equal(restoredResumed.length, 1);
	assert.equal(restoredResumed[0]!.lifecycle, "resumed");
	assert.equal(note, buildMilestoneHandoffNote(restoredResumed[0]!), "deterministic note from the resumed record");
	assert.ok(note.includes(`milestone: ${prepared.milestone_id}`));
	assert.ok(note.includes("lifecycle: resumed"));
	// The hidden note never carries the absolute source session path — only
	// the fixed parent-linked fact (the pointer lives outside model context).
	assert.ok(note.includes("source session: parent-linked (pointer persisted outside model context)"));
	assert.ok(!note.includes("/tmp/workbench-project/session.jsonl"), "hidden note excludes the absolute source session path");
	assert.ok(note.includes("next step: run the q3 verification and write the report"));
	assert.ok(note.includes("mode: AUDIT"));
	assert.ok(note.includes("development writes: ordinary paths direct; high-risk lease never carried"));
	assert.ok(!note.includes("stdout") && !note.includes("stderr"), "note never carries logs");
	assert.ok(utf8ByteLength(note) <= MAX_HANDOFF_NOTE_BYTES);
	assert.ok(note.length <= MAX_HANDOFF_NOTE_CHARS);
	const noteDetails = noteEntry.details as { milestone_id?: string; lifecycle?: string };
	assert.equal(noteDetails.milestone_id, prepared.milestone_id);
	assert.equal(noteDetails.lifecycle, "resumed");
	// 3) copied MODE entry.
	assert.equal(modeEntry.customType, MODE_ENTRY_TYPE);
	assert.deepEqual(modeEntry.data, { mode: "AUDIT" });
	// 4) copied bounded COMPACT entry — exactly the snapshot that travelled,
	//    including the explicit handoff next step.
	assert.equal(compactEntry.customType, COMPACT_STATE_ENTRY_TYPE);
	assert.deepEqual(compactEntry.data, prepared.state);
	assert.equal((compactEntry.data as { nextStep?: string }).nextStep, prepared.next_step);
	// 5) copied serialized DELEGATION state.
	assert.equal(delegationEntry.customType, DELEGATION_STATE_ENTRY_TYPE);
	assert.deepEqual(delegationEntry.data, serializeDelegationState(blocked));
	// NO lease entry anywhere in the target: write authority stays locked.
	assert.ok(!harness.targetEntries.some((e) => e.customType === LEASE_STATE_ENTRY_TYPE), "no lease transfer");

	// withSession used ONLY the replacement context: announce first, reload
	// afterwards, and nothing on the captured command ctx after the switch.
	const announce = harness.replacementNotifyLines.join("\n");
	assert.ok(announce.includes(`milestone ${prepared.milestone_id} handed off`));
	assert.ok(announce.includes("run the q3 verification and write the report"));
	assert.ok(announce.includes("NOT carried") && announce.includes("high-risk"));
	assert.ok(announce.includes("delegation  : DELEGATION 20260801-120000-abcd REVIEWED"));
	assert.equal(harness.reloadCalls, 1, "reload restores setup entries before continuation");
	assert.equal(harness.orderEvents[harness.orderEvents.length - 1], "reload", "announce happens before reload");
	assert.ok(harness.orderEvents.slice(0, -1).every((e) => e === "announce"));
	assert.equal(harness.oldNotifyLines.length, 0, "the old ctx is never used after the successful replacement");

	// Target-runtime restore proof: after reload semantics, the copied
	// mode/compact/delegation are active; AUDIT still blocks mutation.
	assert.ok(stub.activeTools.includes("read"), "restored AUDIT mode active");
	assert.ok(!stub.activeTools.includes("bash") && !stub.activeTools.includes("edit") && !stub.activeTools.includes("write"), "AUDIT tool set");
	// AUDIT mode blocks edit independently of the DEV direct-write policy.
	const blockedEdit = await guardCall(stub, "edit", { path: "src/main.ts" });
	assert.ok(blockedEdit && blockedEdit.block === true);
	assert.match(String(blockedEdit.reason), /AUDIT mode blocks/);
	// The AUDIT denial does not masquerade as a blocked high-risk write
	// attempt, so it creates no new delegation-state append.
	const delegationAppends = stub.appendEntryCalls.filter((c) => c.customType === DELEGATION_STATE_ENTRY_TYPE);
	assert.equal(delegationAppends.length, 0);
	// Compact restored: the copied task surfaces through the compaction
	// supplement (nothing re-seeded it via before_agent_start).
	const compact = stub.events.get("session_before_compact")![0]!;
	await compact!(
		{ type: "session_before_compact", preparation: {}, branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal } as never,
		fakeCtx(harness.targetEntries) as never,
	);
	assert.ok(stub.messages.length > 0, "supplement note sent from restored compact state");
	assert.ok(stub.messages[0]?.content.includes("verify q3 milestone task"), "copied compact task active after reload");
	assert.ok(
		stub.messages[0]?.content.includes("run the q3 verification and write the report"),
		"explicit handoff next step retained in the target compaction supplement",
	);
});

test("the source lease never transfers: DEV source with an ACTIVE lease yields an exactly-locked target", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	// Source: DEV + approved Sol + a confirmed ACTIVE lease + delegation.
	const recentNow = new Date(Date.now() - 60_000).toISOString();
	const issued = issueLease({
		id: "wl-milestone",
		reason: "user-directed",
		paths: ["src/**"],
		confirmationTokenA: "MS-A-123",
		confirmationTokenB: "MS-B-456",
		maxCalls: 3,
		now: recentNow,
	});
	if (!issued.ok) throw new Error(issued.error);
	const confirmed = confirmLease(issued.lease, "MS-A-123", "MS-B-456", recentNow);
	if (!confirmed.ok) throw new Error(confirmed.error);
	const recorded = recordDelegation(emptyDelegationState(), {
		id: "20260801-120000-abcd",
		diffHash: "a".repeat(64),
		now: "2026-08-01T12:00:00.000Z",
	});
	if (!recorded.ok) throw new Error(recorded.error);
	const sourceEntries = [
		entry(MODE_ENTRY_TYPE, { mode: "DEV" }),
		entry(COMPACT_STATE_ENTRY_TYPE, { mode: "DEV", task: "implement slice D" }),
		entry(DELEGATION_STATE_ENTRY_TYPE, serializeDelegationState(recorded.state)),
		entry(LEASE_STATE_ENTRY_TYPE, serializeLease(confirmed.lease)),
	];
	await solSession(stub, sourceEntries);
	// The source lease is genuinely ACTIVE: edit/write are advertised.
	assert.deepEqual(stub.activeTools, [...STRICT_SOL_DEV_ALLOWLIST, "edit", "write"]);
	assert.equal(await guardCall(stub, "edit", { path: "src/main.ts" }), undefined, "source lease authorizes writes");

	const harness = makeHarness();
	await runMilestoneCommand(stub, sourceEntries, harness, "implement the next slice");
	assert.ok(harness.setupRan && harness.withSessionRan);
	assert.ok(!harness.targetEntries.some((e) => e.customType === LEASE_STATE_ENTRY_TYPE), "no lease entry in the target");
	assert.equal(harness.reloadCalls, 1);
	// Restored target: ordinary development writes remain direct; only the
	// source session's high-risk lease is intentionally absent.
	assert.deepEqual(stub.activeTools, [...STRICT_SOL_DEV_ALLOWLIST, "edit", "write"]);
	assert.equal(stub.activeTools.length, 17);
	assert.equal(await guardCall(stub, "edit", { path: "src/main.ts" }), undefined);
	const blocked = await guardCall(stub, "edit", { path: "package.json" });
	assert.ok(blocked && blocked.block === true, "high-risk path requires fresh authorization");
	assert.match(String(blocked.reason), /lease locked/);
	// The milestone note states the development-first target fact.
	const noteEntry = harness.targetEntries.find((e) => e.customType === MILESTONE_HANDOFF_NOTE_ENTRY_TYPE);
	assert.ok(noteEntry && noteEntry.type === "custom_message");
	assert.ok(String(noteEntry.content).includes("development writes: ordinary paths direct; high-risk lease never carried"));
});

test("a cancelled replacement records an additive cancelled record in the source and reports", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	await solSession(stub);
	const harness = makeHarness({ cancelled: true });
	await runMilestoneCommand(stub, [], harness, "run the q3 verification");
	// The prepared record was persisted first, then the additive cancelled
	// record — the source session stays valid and untouched otherwise.
	const milestoneAppends = stub.appendEntryCalls.filter((c) => c.customType === MILESTONE_HANDOFF_ENTRY_TYPE);
	assert.equal(milestoneAppends.length, 2, "prepared + cancelled");
	const prepared = milestoneAppends[0]!.data as { milestone_id: string; lifecycle: string };
	const cancelled = milestoneAppends[1]!.data as { milestone_id: string; lifecycle: string; next_step: string; session: string };
	assert.equal(prepared.lifecycle, "prepared");
	assert.equal(cancelled.lifecycle, "cancelled");
	assert.equal(cancelled.milestone_id, prepared.milestone_id, "cancelled binds the same milestone id");
	assert.equal(cancelled.next_step, "run the q3 verification");
	assert.equal(cancelled.session, "/tmp/workbench-project/session.jsonl");
	// No setup, no withSession, no reload — nothing was replaced.
	assert.equal(harness.setupRan, false);
	assert.equal(harness.withSessionRan, false);
	assert.equal(harness.reloadCalls, 0);
	assert.equal(harness.targetEntries.length, 0);
	assert.match(harness.oldNotifyLines.join("\n"), /cancelled/);
	assert.match(harness.oldNotifyLines.join("\n"), /unchanged/);
	// The cancelled record is machine-readable through the pure loader.
	assert.equal(loadMilestoneHandoffs(stub.entries).map((r) => r.lifecycle).join(","), "prepared,cancelled");
});

test("malformed and unknown-schema milestone entries never break the runtime command surface", async () => {
	const stub = makeStub();
	workbenchRuntime(stub);
	// A hostile source session with garbage milestone records: session_start
	// restore must ignore them (the command surface stays intact).
	const hostile = [
		entry(MILESTONE_HANDOFF_ENTRY_TYPE, { schema_version: 1, lifecycle: "prepared" }),
		entry(MILESTONE_HANDOFF_ENTRY_TYPE, { schema_version: 3, lifecycle: "prepared", milestone_id: "x", next_step: "y", session: "z", updated_at: "t" }),
		entry(MILESTONE_HANDOFF_ENTRY_TYPE, "not-an-object"),
	];
	await solSession(stub, hostile);
	assert.equal(loadMilestoneHandoffs(stub.entries).length, 0, "hostile records are ignored, not applied");
	assert.ok(stub.commands.has("q-milestone-handoff"));
});
