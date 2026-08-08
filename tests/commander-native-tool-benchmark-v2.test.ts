/**
 * NRO protocol-v2 benchmark core tests (commander-native-tool-benchmark-v2
 * benchmark-core slice) — PURE, hermetic, deterministic: synthetic
 * in-memory fixtures only; no filesystem writes, no network, no process
 * spawning, no provider/model involvement. The only filesystem access is
 * a read-only static-guard scan of the core source text itself.
 *
 * Covers, against the v2 core module:
 *
 *   A. Collection records: the initial empty final record roundtrips;
 *      partial final prefixes with ABBA sessions and interspersed
 *      same-arm retry attempts; attempts never advance the session
 *      position; wrong retry arms, trailing entries after the 40th
 *      session, the 61-entry cap, unknown keys, wrong
 *      schema/protocol/doc, pin/environment/path/hash drift, duplicate
 *      normalized paths and dev-without-session all fail closed; the
 *      serializer emits schema/protocol 2 with a terminal LF and
 *      roundtrips strictly.
 *   B. Manifests: the complete 40-session ABBA manifest and a dev
 *      manifest roundtrip; exact rubric constants; unknown/missing
 *      nested keys, schema/protocol/doc/pin/env/rubric drift, session
 *      count/label/order/arm drift, path/hash/duplicate failures,
 *      attempt label gaps and invalid categories fail closed; the final
 *      paid-attempt cap is sessions + attempts <= 60 (40+20 accepted,
 *      40+21 rejected) while dev keeps its bounded attempts-only cap.
 *   C. Run facts over synthetic Pi session entries: normal preview +
 *      continuation; provider-error assistants and fresh-id retries;
 *      reordered exact-ID results (proving no FIFO shift); orphan and
 *      isError aggregates; malformed/duplicate markers and invalid/
 *      unknown/duplicate ids fail closed through the frozen v2 policy;
 *      spaced/unspaced unicode rubric correctness; exact edit/write
 *      toolCall counts; per-tool totals vs successful (non-error)
 *      bytes; prompt/model/thinking/compaction/terminal validity
 *      failures; privacy (secret ids/paths/bodies/thinking never appear
 *      in v2 core/policy error messages or returned aggregate JSON).
 *   D. Verdicts over minimal typed RunFactsV2 fixtures: exact 50% /
 *      20% / equality / 105% boundaries with just-below/above cases,
 *      nearest-rank p90 at position 18 of 20 (top two values never
 *      affect it), empty/zero-denominator NOT_MEASURED, dev all
 *      NOT_MEASURED, medians/middle-two sums and arm totals.
 *   E. Static guard: the core source imports/calls the frozen v2
 *      evaluateRubricV2/computePaginationV2 and never imports the v1
 *      core functions or frozen constants.
 *   F. Attempt classification: every frozen-priority branch
 *      (prompt_mismatch → env_drift → compaction_present → aborted →
 *      errored → nonterminal → strict ATTEMPT_NOT_INVALID / dev
 *      unclassified), multi-failure precedence, missing-user-prompt
 *      null semantics, provider-error/terminal semantics, exact
 *      aggregate facts, malformed-entry/usage fail-closed propagation
 *      through the existing validators, privacy (bodies, ids, tool
 *      args, absolute paths and thinking never surface in errors or
 *      returned JSON), and a static guard proving the v2 core never
 *      imports or calls the v1 attempt classifier or any v1
 *      manifest/analyzer/prepare implementation.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";

import {
	COLLECTION_ENTRY_CAP,
	NroV2Error,
	V2_ATTEMPT_CATEGORIES,
	abbaArmAtV2,
	abbaPositionsOfV2,
	buildArmFactsV2,
	collectionRecordToJsonV2,
	computeRunFactsV2,
	computeVerdictsFromRunsV2,
	countEditWriteToolCallsV2,
	deriveAttemptFactsV2,
	manifestToJsonV2,
	medianOfV2,
	middleTwoSumV2,
	nearestRankP90V2,
	parseCollectionRecordV2,
	parseManifestV2,
	sessionLabelV2,
	VERDICT_LABELS_V2,
	VERDICT_THRESHOLDS_V2,
	type AttemptCategoryV2,
	type AttemptFactsV2,
	type CollectionRecordV2,
	type DeriveAttemptOptionsV2,
	type ManifestEnvironmentV2,
	type NroV2ErrorCode,
	type RunFactsV2,
} from "../scripts/commander-native-tool-benchmark-v2.ts";

import {
	BENCHMARK_SCHEMA_VERSION,
	COLLECTION_SCHEMA_VERSION,
	FROZEN_ENVIRONMENT,
	FROZEN_NRO_V2_PROTOCOL,
	MAX_PAID_ATTEMPTS,
	PROTOCOL_DOC,
	PROTOCOL_VERSION,
	TOTAL_VALID_RUNS,
	VERDICT_IDS,
	type ArmName,
	type Phase,
} from "../scripts/commander-native-tool-benchmark-v2-protocol.ts";

import {
	V2_RUBRIC_CHECKS,
	V2PolicyError,
	type V2PolicyErrorCode,
} from "../scripts/commander-native-tool-benchmark-v2-policy.ts";

// ---------------------------------------------------------------------------
// Hermetic constants and small helpers
// ---------------------------------------------------------------------------

const H64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const H64_OTHER = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const PROTOCOL = FROZEN_NRO_V2_PROTOCOL;
const PROMPT_SHA = PROTOCOL.milestonePromptSha256 as string;
const FIXTURE_SHA = PROTOCOL.fixtureManifestSha256 as string;
const NON_TREATMENT_SHA = PROTOCOL.nonTreatmentSha256 as string;
const RUBRIC_SHA = PROTOCOL.rubricSha256 as string;

/** Sentinels that must NEVER appear in any v2 error message or returned fact JSON. */
const SECRET_CALL_ID = "call-SECRET-9f2c-bb71";
const SECRET_PATH = "/private/secret-dir/SECRET-file-7c4e.txt";
const SECRET_BODY = "NROPRIVATE-TOOLRESULT-1b3d";
const SECRET_THINKING = "NROPRIVATE-THINKING-a5e8";

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

function environmentWire(): Record<string, unknown> {
	return {
		model_key: FROZEN_ENVIRONMENT.modelKey,
		thinking_level: FROZEN_ENVIRONMENT.thinkingLevel,
		pi_version: FROZEN_ENVIRONMENT.piVersion,
		node_version: FROZEN_ENVIRONMENT.nodeVersion,
	};
}

function expectCode(thunk: () => unknown, code: NroV2ErrorCode): NroV2Error {
	let err: unknown;
	try {
		thunk();
	} catch (e) {
		err = e;
	}
	assert.ok(err instanceof NroV2Error, `expected NroV2Error ${code}, got ${String(err)}`);
	assert.equal(err.code, code);
	return err;
}

function expectPolicyCode(thunk: () => unknown, code: V2PolicyErrorCode): V2PolicyError {
	let err: unknown;
	try {
		thunk();
	} catch (e) {
		err = e;
	}
	assert.ok(err instanceof V2PolicyError, `expected V2PolicyError ${code}, got ${String(err)}`);
	assert.equal(err.code, code);
	return err;
}

function expectNoThrow(thunk: () => unknown): void {
	try {
		thunk();
	} catch (e) {
		assert.fail(`expected no throw, got ${String(e)}`);
	}
}

// ---------------------------------------------------------------------------
// A. Collection records
// ---------------------------------------------------------------------------

function collectionWire(entries: unknown[], phase: Phase = "final", overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema_version: COLLECTION_SCHEMA_VERSION,
		protocol_version: PROTOCOL_VERSION,
		protocol_doc: PROTOCOL_DOC,
		phase,
		milestone_prompt_sha256: PROMPT_SHA,
		fixture_manifest_sha256: FIXTURE_SHA,
		non_treatment_sha256: NON_TREATMENT_SHA,
		rubric_sha256: RUBRIC_SHA,
		environment: environmentWire(),
		entries,
		...overrides,
	};
}

function collEntry(kind: "session" | "attempt", arm: ArmName, path: string, sha: string = H64): Record<string, unknown> {
	return { kind, arm, path, expected_session_sha256: sha };
}

/** The frozen ABBA arm at 1-based position i and the per-arm occurrence of that position. */
function abbaAt(i: number): { arm: ArmName; occurrence: number } {
	const arm = abbaArmAtV2(i);
	return { arm, occurrence: abbaPositionsOfV2(arm).indexOf(i) + 1 };
}

test("collection v2: initial empty final record roundtrips (schema/protocol 2, terminal LF)", () => {
	const record = parseCollectionRecordV2(JSON.stringify(collectionWire([])));
	assert.equal(record.phase, "final");
	assert.deepEqual(record.entries, []);
	const text = collectionRecordToJsonV2(record);
	assert.ok(text.endsWith("\n"), "serializer must emit a terminal LF");
	assert.equal(JSON.parse(text).schema_version, COLLECTION_SCHEMA_VERSION);
	assert.equal(JSON.parse(text).protocol_version, PROTOCOL_VERSION);
	// Strict roundtrip: parse(serialize(parse(x))) is identity.
	assert.deepEqual(parseCollectionRecordV2(text), record);
});

test("collection v2: dev records require at least one session entry", () => {
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "dev"))), "COHORT_COUNT");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([collEntry("attempt", "control", "attempts/a1.json")], "dev"))), "COHORT_COUNT");
	const dev = parseCollectionRecordV2(JSON.stringify(collectionWire([collEntry("session", "control", "sessions/control-01.json")], "dev")));
	assert.equal(dev.phase, "dev");
	assert.equal(dev.entries.length, 1);
});

test("collection v2: partial final record with ABBA sessions and interspersed same-arm retries", () => {
	const entries = [
		collEntry("attempt", "control", "attempts/a1.json"),
		collEntry("session", "control", "sessions/control-01.json"),
		collEntry("session", "treatment", "sessions/treatment-01.json"),
		collEntry("attempt", "treatment", "attempts/a2.json"),
		collEntry("attempt", "treatment", "attempts/a3.json"),
		collEntry("session", "treatment", "sessions/treatment-02.json"),
		collEntry("session", "control", "sessions/control-02.json"),
		collEntry("attempt", "control", "attempts/a4.json"),
		collEntry("session", "control", "sessions/control-03.json"),
		collEntry("session", "treatment", "sessions/treatment-03.json"),
	];
	const record = parseCollectionRecordV2(JSON.stringify(collectionWire(entries)));
	assert.equal(record.entries.length, 10);
	const sessionArms = record.entries.filter((e) => e.kind === "session").map((e) => e.arm);
	assert.deepEqual(sessionArms, ["control", "treatment", "treatment", "control", "control", "treatment"]);
	assert.deepEqual(
		record.entries.map((e) => e.path),
		entries.map((e) => e.path),
	);
	// Strict roundtrip of a partial final prefix.
	assert.deepEqual(parseCollectionRecordV2(collectionRecordToJsonV2(record)), record);
});

test("collection v2: attempts never advance the ABBA session position; wrong retry arms fail closed", () => {
	// Two filled positions (control@1, treatment@2); every following entry
	// binds the next unfilled position (3 = treatment) until a session fills it.
	const prefix = [collEntry("session", "control", "sessions/control-01.json"), collEntry("session", "treatment", "sessions/treatment-01.json")];
	expectNoThrow(() => parseCollectionRecordV2(JSON.stringify(collectionWire([...prefix, collEntry("attempt", "treatment", "attempts/a1.json")]))));
	expectNoThrow(() =>
		parseCollectionRecordV2(JSON.stringify(collectionWire([...prefix, collEntry("attempt", "treatment", "attempts/a1.json"), collEntry("attempt", "treatment", "attempts/a2.json")]))),
	);
	// A session fills position 3; the next retry must bind position 4 (control).
	expectNoThrow(() =>
		parseCollectionRecordV2(
			JSON.stringify(collectionWire([...prefix, collEntry("attempt", "treatment", "attempts/a1.json"), collEntry("session", "treatment", "sessions/treatment-02.json"), collEntry("attempt", "control", "attempts/a2.json")])),
		),
	);
	// Wrong retry arm fails closed.
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([...prefix, collEntry("attempt", "control", "attempts/a1.json")]))), "ARM_MISMATCH");
	// Wrong session arm at the next position fails closed too.
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([...prefix, collEntry("session", "control", "sessions/control-02.json")]))), "ARM_MISMATCH");
});

test("collection v2: exactly 40 final sessions fill the cohort; no entry of either kind may follow them", () => {
	const full = Array.from({ length: TOTAL_VALID_RUNS }, (_, i) => collEntry("session", abbaArmAtV2(i + 1), `sessions/s-${String(i + 1).padStart(2, "0")}.json`));
	expectNoThrow(() => parseCollectionRecordV2(JSON.stringify(collectionWire(full))));
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([...full, collEntry("attempt", "control", "attempts/trailing.json")]))), "COHORT_COUNT");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([...full, collEntry("session", "control", "sessions/extra.json")]))), "COHORT_COUNT");
});

test("collection v2: entry cap is 60 total; 61 entries fail OVER_BOUND", () => {
	assert.equal(COLLECTION_ENTRY_CAP, MAX_PAID_ATTEMPTS);
	const sessions = Array.from({ length: TOTAL_VALID_RUNS }, (_, i) => collEntry("session", abbaArmAtV2(i + 1), `sessions/s${String(i + 1).padStart(2, "0")}.json`));
	// 21 retries + 40 sessions = 61 entries.
	const over = Array.from({ length: 21 }, (_, i) => collEntry("attempt", "control", `attempts/a${String(i + 1).padStart(2, "0")}.json`));
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([...over, ...sessions]))), "OVER_BOUND");
	// 20 retries + 40 sessions = 60 entries is the accepted boundary.
	const atCap = Array.from({ length: 20 }, (_, i) => collEntry("attempt", "control", `attempts/a${String(i + 1).padStart(2, "0")}.json`));
	expectNoThrow(() => parseCollectionRecordV2(JSON.stringify(collectionWire([...atCap, ...sessions]))));
});

test("collection v2: unknown keys and wrong schema/protocol/doc/phase fail closed", () => {
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "final", { extra: 1 }))), "UNKNOWN_KEY");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "final", { schema_version: 1 }))), "SCHEMA_VERSION");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "final", { protocol_version: 1 }))), "PROTOCOL_VERSION");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "final", { protocol_doc: "docs/other.md" }))), "PROTOCOL_DOC");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "bogus" as Phase))), "INVALID_PHASE");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "final", { entries: "not-an-array" }))), "INVALID_RECORD");
	expectCode(
		() =>
			parseCollectionRecordV2(
				JSON.stringify(collectionWire([collEntry("session", "control", "sessions/c01.json"), { kind: "session", arm: "control", path: "sessions/c02.json", expected_session_sha256: H64, extra: true }])),
			),
		"UNKNOWN_KEY",
	);
});

test("collection v2: pin, environment, path and hash drift fail closed", () => {
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "final", { milestone_prompt_sha256: H64_OTHER }))), "PIN_MISMATCH");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "final", { fixture_manifest_sha256: H64_OTHER }))), "PIN_MISMATCH");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "final", { non_treatment_sha256: H64_OTHER }))), "PIN_MISMATCH");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "final", { rubric_sha256: H64_OTHER }))), "PIN_MISMATCH");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "final", { milestone_prompt_sha256: "zz" }))), "HASH_UNSAFE");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "final", { environment: { ...environmentWire(), model_key: "other/model" } }))), "ENV_MISMATCH");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "final", { environment: { ...environmentWire(), thinking_level: "low" } }))), "ENV_MISMATCH");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "final", { environment: { ...environmentWire(), pi_version: "0.99.0" } }))), "ENV_MISMATCH");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "final", { environment: { ...environmentWire(), model_key: "BAD MODEL!" } }))), "ENV_UNSAFE");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([], "final", { environment: { ...environmentWire(), extra: 1 } }))), "UNKNOWN_KEY");

	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([collEntry("session", "control", "/abs/path.json")]))), "PATH_UNSAFE");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([collEntry("session", "control", "a/../b.json")]))), "PATH_UNSAFE");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([collEntry("session", "control", "bad name!.json")]))), "BASENAME_UNSAFE");
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([collEntry("session", "control", `${"x".repeat(513)}.json`)]))), "OVER_BOUND");
	// Duplicate normalized paths: "." segments resolve to the same path.
	expectCode(
		() => parseCollectionRecordV2(JSON.stringify(collectionWire([collEntry("session", "control", "sessions/a.json"), collEntry("session", "treatment", "sessions/./a.json")]))),
		"DUPLICATE_PATH",
	);
	expectCode(() => parseCollectionRecordV2(JSON.stringify(collectionWire([collEntry("session", "control", "sessions/a.json", "not-a-hash")]))), "HASH_UNSAFE");
});

// ---------------------------------------------------------------------------
// B. Manifests
// ---------------------------------------------------------------------------

function sessionWire(label: string, arm: ArmName, orderIndex: number, path: string, sha: string = H64): Record<string, unknown> {
	return { label, arm, order_index: orderIndex, path, expected_session_sha256: sha };
}

function attemptWire(label: string, arm: ArmName, path: string, category: string, promptSha: string | null = null): Record<string, unknown> {
	return { label, arm, path, expected_session_sha256: H64, prompt_sha256: promptSha, category };
}

/** The frozen 40-session final cohort in chronological ABBA order. */
function finalSessionsWire(): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (let i = 1; i <= TOTAL_VALID_RUNS; i += 1) {
		const { arm, occurrence } = abbaAt(i);
		out.push(sessionWire(sessionLabelV2(arm, occurrence), arm, i, `sessions/${arm}-${String(occurrence).padStart(2, "0")}.json`));
	}
	return out;
}

const FINAL_SESSIONS = finalSessionsWire();

function attemptsWire(count: number, category: string): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (let i = 1; i <= count; i += 1) {
		out.push(attemptWire(`attempt-${i}`, "control", `attempts/attempt-${String(i).padStart(2, "0")}.json`, category));
	}
	return out;
}

function manifestWire(sessions: unknown[], attempts: unknown[], phase: Phase = "final", overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema_version: BENCHMARK_SCHEMA_VERSION,
		protocol_version: PROTOCOL_VERSION,
		protocol_doc: PROTOCOL_DOC,
		phase,
		milestone_prompt_sha256: PROMPT_SHA,
		environment: environmentWire(),
		fixture: { path: "fixture", manifest_sha256: FIXTURE_SHA },
		non_treatment_sha256: NON_TREATMENT_SHA,
		rubric: { sha256: RUBRIC_SHA, checks: V2_RUBRIC_CHECKS.map((c) => ({ id: c.id, pattern: c.pattern })) },
		sessions,
		attempts,
		...overrides,
	};
}

const rubricChecksWire = (): Record<string, unknown>[] => V2_RUBRIC_CHECKS.map((c) => ({ id: c.id, pattern: c.pattern }));

test("manifest v2: complete final 40-session ABBA manifest roundtrips with exact rubric constants", () => {
	const m = parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, attemptsWire(20, "errored"))));
	assert.equal(m.phase, "final");
	assert.equal(m.sessions.length, TOTAL_VALID_RUNS);
	assert.equal(m.attempts.length, 20);
	for (let i = 1; i <= TOTAL_VALID_RUNS; i += 1) {
		const s = m.sessions[i - 1];
		assert.ok(s);
		assert.equal(s.orderIndex, i);
		assert.equal(s.arm, abbaArmAtV2(i));
		const { arm, occurrence } = abbaAt(i);
		assert.equal(s.label, sessionLabelV2(arm, occurrence));
	}
	// Exact frozen rubric constants: pin and the six ordered checks.
	assert.equal(m.rubric.sha256, RUBRIC_SHA);
	assert.deepEqual(m.rubric.checks, V2_RUBRIC_CHECKS);
	const text = manifestToJsonV2(m);
	assert.ok(text.endsWith("\n"), "manifest serializer must emit a terminal LF");
	assert.equal(JSON.parse(text).schema_version, BENCHMARK_SCHEMA_VERSION);
	assert.equal(JSON.parse(text).protocol_version, PROTOCOL_VERSION);
	assert.deepEqual(parseManifestV2(text), m);
});

test("manifest v2: dev manifest roundtrips (relaxed ABBA/counts, unclassified attempts allowed)", () => {
	const sessions = [sessionWire("control-01", "control", 1, "sessions/control-01.json"), sessionWire("treatment-01", "treatment", 2, "sessions/treatment-01.json")];
	const m = parseManifestV2(JSON.stringify(manifestWire(sessions, attemptsWire(3, "unclassified"), "dev")));
	assert.equal(m.phase, "dev");
	assert.equal(m.sessions.length, 2);
	assert.equal(m.attempts.length, 3);
	assert.equal(m.attempts[2]?.category, "unclassified");
	assert.equal(m.attempts[2]?.label, "attempt-3");
	assert.deepEqual(parseManifestV2(manifestToJsonV2(m)), m);
});

test("manifest v2: unknown and missing nested keys fail closed", () => {
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { extra: 1 }))), "UNKNOWN_KEY");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { fixture: { path: "fixture" } }))), "HASH_UNSAFE");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { fixture: { manifest_sha256: FIXTURE_SHA } }))), "INVALID_ENTRY");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { fixture: { path: "fixture", manifest_sha256: FIXTURE_SHA, extra: 1 } }))), "UNKNOWN_KEY");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { rubric: { sha256: RUBRIC_SHA } }))), "RUBRIC_INVALID");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { rubric: { sha256: RUBRIC_SHA, checks: rubricChecksWire(), extra: 1 } }))), "UNKNOWN_KEY");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { environment: { ...environmentWire(), extra: 1 } }))), "UNKNOWN_KEY");
	// Session entry missing expected_session_sha256.
	expectCode(
		() => parseManifestV2(JSON.stringify(manifestWire([sessionWire("control-01", "control", 1, "sessions/control-01.json"), { label: "treatment-01", arm: "treatment", order_index: 2, path: "sessions/treatment-01.json" }], []))),
		"HASH_UNSAFE",
	);
	// Session entry with an unknown key.
	expectCode(
		() => parseManifestV2(JSON.stringify(manifestWire([{ label: "control-01", arm: "control", order_index: 1, path: "sessions/control-01.json", expected_session_sha256: H64, extra: 1 }], []))),
		"UNKNOWN_KEY",
	);
	// Attempt entry missing expected_session_sha256 / carrying an unknown key.
	expectCode(
		() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [{ label: "attempt-1", arm: "control", path: "attempts/a.json", prompt_sha256: null, category: "errored" }]))),
		"HASH_UNSAFE",
	);
	expectCode(
		() =>
			parseManifestV2(
				JSON.stringify(manifestWire(FINAL_SESSIONS, [{ label: "attempt-1", arm: "control", path: "attempts/a.json", expected_session_sha256: H64, prompt_sha256: null, category: "errored", extra: 1 }])),
			),
		"UNKNOWN_KEY",
	);
});

test("manifest v2: schema/protocol/doc/phase/pin/environment drift fails closed", () => {
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { schema_version: 1 }))), "SCHEMA_VERSION");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { protocol_version: 1 }))), "PROTOCOL_VERSION");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { protocol_doc: "docs/other.md" }))), "PROTOCOL_DOC");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { phase: "bogus" }))), "INVALID_PHASE");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { milestone_prompt_sha256: H64_OTHER }))), "PIN_MISMATCH");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { environment: { ...environmentWire(), thinking_level: "low" } }))), "ENV_MISMATCH");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { fixture: { path: "fixture", manifest_sha256: H64_OTHER } }))), "PIN_MISMATCH");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { non_treatment_sha256: H64_OTHER }))), "PIN_MISMATCH");
	expectCode(
		() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { rubric: { sha256: H64_OTHER, checks: rubricChecksWire() } }))),
		"PIN_MISMATCH",
	);
});

test("manifest v2: rubric count/id/pattern/order drift and malformed checks fail closed", () => {
	const rubric = (checks: unknown[]): Record<string, unknown> => ({ sha256: RUBRIC_SHA, checks });
	const checks = rubricChecksWire();
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { rubric: rubric(checks.slice(0, 5)) }))), "RUBRIC_MISMATCH");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { rubric: rubric(checks.map((c, i) => (i === 1 ? { id: "unicodex", pattern: (c as Record<string, unknown>).pattern } : c))) }))), "RUBRIC_MISMATCH");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { rubric: rubric(checks.map((c, i) => (i === 0 ? { id: (c as Record<string, unknown>).id, pattern: "build:\\s*alpha-43\\b" } : c))) }))), "RUBRIC_MISMATCH");
	// Reordered checks: position 0 must be the frozen "build" check.
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { rubric: rubric([checks[1], checks[0], ...checks.slice(2)]) }))), "RUBRIC_MISMATCH");
	// Duplicate check id / missing pattern / non-array checks are RUBRIC_INVALID.
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { rubric: rubric([checks[0], checks[0], ...checks.slice(2)]) }))), "RUBRIC_INVALID");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { rubric: rubric([{ id: "build" }, ...checks.slice(1)]) }))), "RUBRIC_INVALID");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [], "final", { rubric: { sha256: RUBRIC_SHA, checks: "nope" } }))), "RUBRIC_INVALID");
});

test("manifest v2: final session count/label/order/arm drift fails closed", () => {
	// Counts: 39 sessions and 41 sessions.
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS.slice(0, 39), []))), "COHORT_COUNT");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire([...FINAL_SESSIONS, sessionWire("control-21", "control", 41, "sessions/control-21.json")], []))), "COHORT_COUNT");
	// 21 control + 19 treatment — wrong per-arm counts. Labels stay
	// occurrence-consistent (control-01..21, treatment-01..19) so the count
	// check is what fires, not a label/duplicate check.
	const imbalanced = [
		...Array.from({ length: 21 }, (_, i) => sessionWire(`control-${String(i + 1).padStart(2, "0")}`, "control", i + 1, `sessions/c-${String(i + 1).padStart(2, "0")}.json`)),
		...Array.from({ length: 19 }, (_, i) => sessionWire(`treatment-${String(i + 1).padStart(2, "0")}`, "treatment", i + 22, `sessions/t-${String(i + 1).padStart(2, "0")}.json`)),
	];
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(imbalanced, []))), "COHORT_COUNT");
	// Order: not starting at 1, duplicate, non-increasing, out-of-range.
	const notFromOne = FINAL_SESSIONS.map((s) => ({ ...s, order_index: (s.order_index as number) + 1 }));
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(notFromOne, []))), "ORDER_MISMATCH");
	const duplicateOrder = FINAL_SESSIONS.map((s) => ({ ...s }));
	duplicateOrder[1] = { ...(duplicateOrder[1] as Record<string, unknown>), order_index: 1 };
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(duplicateOrder, []))), "ORDER_MISMATCH");
	const nonIncreasing = FINAL_SESSIONS.map((s) => ({ ...s }));
	nonIncreasing[2] = { ...(nonIncreasing[2] as Record<string, unknown>), order_index: 2 };
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(nonIncreasing, []))), "ORDER_MISMATCH");
	const outOfRange = FINAL_SESSIONS.map((s) => ({ ...s }));
	outOfRange[39] = { ...(outOfRange[39] as Record<string, unknown>), order_index: 41 };
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(outOfRange, []))), "ORDER_MISMATCH");
	// Arm drift: swap the labels/arms of the sessions at orders 1 and 2 —
	// counts stay 20/20 and labels stay occurrence-consistent, but the
	// session at ABBA position 1 is no longer control.
	const swapped = FINAL_SESSIONS.map((s) => ({ ...s }));
	const first = swapped[0] as Record<string, unknown>;
	const second = swapped[1] as Record<string, unknown>;
	const firstLabel = first.label;
	const firstArm = first.arm;
	first.label = second.label;
	first.arm = second.arm;
	second.label = firstLabel;
	second.arm = firstArm;
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(swapped, []))), "ARM_MISMATCH");
});

test("manifest v2: session label/path/hash/duplicate failures fail closed", () => {
	const at = (i: number, patch: Record<string, unknown>): Record<string, unknown>[] => FINAL_SESSIONS.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
	// In a complete final manifest every valid label is already in use, so
	// label-shape drift (wrong arm in the label, wrong occurrence number)
	// is exercised on a sparse dev manifest where those labels are fresh.
	const devSessions = [sessionWire("control-01", "control", 1, "sessions/control-01.json"), sessionWire("treatment-01", "treatment", 2, "sessions/treatment-01.json")];
	const devAt = (i: number, patch: Record<string, unknown>): Record<string, unknown>[] => devSessions.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(devAt(0, { label: "control-1" }), [], "dev"))), "LABEL_MISMATCH");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(devAt(0, { label: "control-02" }), [], "dev"))), "LABEL_MISMATCH");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(devAt(0, { label: "treatment-02" }), [], "dev"))), "LABEL_MISMATCH");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(at(1, { label: "control-01" }), []))), "DUPLICATE_LABEL");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(at(0, { label: "bad label!" }), []))), "LABEL_UNSAFE");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(at(0, { path: "fixture" }), []))), "DUPLICATE_PATH");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(at(0, { path: "/abs.json" }), []))), "PATH_UNSAFE");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(at(0, { path: "bad name!.json" }), []))), "BASENAME_UNSAFE");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(at(0, { expected_session_sha256: "xyz" }), []))), "HASH_UNSAFE");
	// Duplicate attempt path against a session path.
	expectCode(
		() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [attemptWire("attempt-1", "control", "sessions/control-01.json", "errored")]))),
		"DUPLICATE_PATH",
	);
});

test("manifest v2: attempt labels are gapless and categories are frozen", () => {
	const ok = attemptsWire(2, "errored");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [ok[1] as Record<string, unknown>]))), "ATTEMPT_LABELS");
	expectCode(
		() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [ok[0] as Record<string, unknown>, { ...(ok[1] as Record<string, unknown>), label: "attempt-3" }]))),
		"ATTEMPT_LABELS",
	);
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [{ ...(ok[0] as Record<string, unknown>), label: "attempt-01" }]))), "ATTEMPT_LABELS");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [{ ...(ok[0] as Record<string, unknown>), label: "attempt-x" }]))), "LABEL_UNSAFE");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [ok[0] as Record<string, unknown>, ok[0] as Record<string, unknown>]))), "DUPLICATE_LABEL");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [{ ...(ok[0] as Record<string, unknown>), category: "bogus" }]))), "INVALID_CATEGORY");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [{ ...(ok[0] as Record<string, unknown>), category: "unclassified" }]))), "INVALID_CATEGORY");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [{ ...(ok[0] as Record<string, unknown>), prompt_sha256: "xyz" }]))), "HASH_UNSAFE");
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, [{ ...(ok[0] as Record<string, unknown>), arm: "bogus" }]))), "INVALID_ENTRY");
	assert.deepEqual(V2_ATTEMPT_CATEGORIES, ["prompt_mismatch", "env_drift", "compaction_present", "aborted", "errored", "nonterminal", "unclassified"]);
});

test("manifest v2: final paid-attempt cap is sessions + attempts <= 60; dev keeps its bounded attempts cap", () => {
	expectNoThrow(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, attemptsWire(20, "errored")))));
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(FINAL_SESSIONS, attemptsWire(21, "errored")))), "OVER_BOUND");
	// Dev: 60 attempts with 2 sessions is fine (attempts-only bound), 61 attempts fails.
	const devSessions = [sessionWire("control-01", "control", 1, "sessions/control-01.json"), sessionWire("treatment-01", "treatment", 2, "sessions/treatment-01.json")];
	expectNoThrow(() => parseManifestV2(JSON.stringify(manifestWire(devSessions, attemptsWire(60, "unclassified"), "dev"))));
	expectCode(() => parseManifestV2(JSON.stringify(manifestWire(devSessions, attemptsWire(61, "unclassified"), "dev"))), "OVER_BOUND");
});

// ---------------------------------------------------------------------------
// C. Run facts (synthetic persisted Pi session entries)
// ---------------------------------------------------------------------------

const PROMPT_TEXT = "Solve the frozen NRO benchmark milestone precisely and report every required fact.";
const PROMPT_SHA256 = sha256Hex(PROMPT_TEXT);
const MODEL_KEY = FROZEN_ENVIRONMENT.modelKey; // "openai-codex/gpt-5.6-sol"
const RUBRIC_FULL_TEXT = ["build: alpha-42", "unicode: α, 水, 🚀", "token: delta-77", "needle_occurrences: 140", "needle_lines: 135", "needle_files: 4"].join("\n");

function userMessage(text: string = PROMPT_TEXT): Record<string, unknown> {
	return { type: "message", id: "m-user", message: { role: "user", content: [{ type: "text", text }] } };
}

function thinkingLevelChange(level: string = FROZEN_ENVIRONMENT.thinkingLevel): Record<string, unknown> {
	return { type: "thinking_level_change", thinkingLevel: level };
}

function assistantMessage(content: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "message",
		id: "m-assistant",
		message: {
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			content,
			stopReason: "stop",
			usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 0.001 } },
			...overrides,
		},
	};
}

function toolCallItem(id: string, name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: "toolCall", id, name, arguments: args };
}

function toolResultMessage(toolCallId: string, toolName: string, content: unknown, isError?: boolean, usage?: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "message",
		id: `m-${toolCallId}-result`,
		message: {
			role: "toolResult",
			toolName,
			toolCallId,
			content,
			...(isError ? { isError: true } : {}),
			...(usage !== undefined ? { usage } : {}),
		},
	};
}

function markerLine(complete: boolean): string {
	return `nro-read-facts: complete=${complete} returned_lines=10 returned_bytes=1000 total_lines=100 total_bytes=10000 omitted_lines=90 omitted_bytes=9000 next_offset=10 line_truncated=false`;
}

function computeFacts(entries: unknown[], enforceValidity: boolean = true, expectedPromptSha: string = PROMPT_SHA256, env: ManifestEnvironmentV2 = FROZEN_ENVIRONMENT): RunFactsV2 {
	return computeRunFactsV2("control-01", "control", 1, "control-01.json", H64, entries, expectedPromptSha, env, { enforceValidity });
}

function validSessionEntries(): unknown[] {
	return [
		userMessage(),
		thinkingLevelChange(),
		assistantMessage([toolCallItem("c1", "read", { path: "fixture/alpha.txt" })]),
		toolResultMessage("c1", "read", markerLine(false)),
		assistantMessage([toolCallItem("c2", "read", { path: "fixture/alpha.txt", offset: 100 })]),
		toolResultMessage("c2", "read", "legacy continuation content"),
		assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }]),
	];
}

test("run facts v2: valid session — preview + continuation, rubric pass, prompt/env/terminal validity", () => {
	const f = computeFacts(validSessionEntries());
	assert.equal(f.requests, 3);
	assert.equal(f.compactions, 0);
	assert.equal(f.promptMatches, true);
	assert.deepEqual(f.modelKeys, [MODEL_KEY]);
	assert.equal(f.thinkingLevel, "high");
	assert.equal(f.terminal.terminalStop, true);
	assert.equal(f.terminal.aborted, false);
	assert.equal(f.terminal.errored, false);
	assert.equal(f.correctness.passed, true);
	assert.deepEqual(
		f.correctness.checks.map((c) => c.id),
		V2_RUBRIC_CHECKS.map((c) => c.id),
	);
	assert.equal(f.pagination.previewResults, 1);
	assert.equal(f.pagination.previewBytes, utf8Bytes(markerLine(false)));
	assert.equal(f.pagination.obligations, 1);
	assert.equal(f.pagination.obligationsPaginated, 1);
	assert.equal(f.pagination.continuationReads, 1);
	assert.equal(f.pagination.continuationBytes, utf8Bytes("legacy continuation content"));
	assert.equal(f.pagination.unpaginatedPreviews, 0);
	assert.equal(f.pagination.completionFraction, 1);
	assert.equal(f.pagination.reachedFraction, 0);
	assert.equal(f.pagination.misuse, false);
	assert.equal(f.pagination.orphanReadCalls, 0);
	assert.equal(f.pagination.errorReadResults, 0);
	assert.equal(f.misuse, false);
	assert.equal(f.editWriteToolCalls, 0);
	// Cost facts: three assistant turns of 165 tokens each.
	assert.equal(f.gross, 3 * (100 + 50 + 10 + 5));
	assert.equal(f.input, 300);
	assert.equal(f.output, 150);
	assert.equal(f.cacheRead, 30);
	assert.equal(f.cacheWrite, 15);
	assert.equal(f.cost, 0.003);
	assert.equal(f.wallTimeMs, null);
});

test("run facts v2: provider-error assistant and fresh-id retry never shift exact-ID attribution", () => {
	const entries = [
		userMessage(),
		thinkingLevelChange(),
		assistantMessage([toolCallItem("c1", "read", { path: "fixture/alpha.txt" })]),
		toolResultMessage("c1", "read", markerLine(false)),
		assistantMessage([toolCallItem("c2", "read", { path: "fixture/alpha.txt", offset: 100 })]), // orphan — no result ever arrives
		assistantMessage([{ type: "text", text: "provider error mid-session" }], { stopReason: "error", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } } }),
		assistantMessage([toolCallItem("c3", "read", { path: "fixture/alpha.txt", offset: 200 })]), // fresh-id retry succeeds
		toolResultMessage("c3", "read", "legacy full content"),
		assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }]),
	];
	const f = computeFacts(entries);
	assert.equal(f.pagination.orphanReadCalls, 1); // c2 never matched
	assert.equal(f.pagination.continuationReads, 1); // only the fresh-id c3
	assert.equal(f.pagination.obligationsPaginated, 1);
	assert.equal(f.pagination.errorReadResults, 0);
	assert.equal(f.pagination.misuse, false);
	assert.equal(f.requests, 5);
	assert.equal(f.gross, 4 * 165 + 15);
	assert.equal(f.terminal.terminalStop, true); // terminal facts come from the final stop message
	assert.equal(f.correctness.passed, true);
});

test("run facts v2: reordered exact-ID results never shift attribution (no FIFO)", () => {
	const entries = [
		userMessage(),
		thinkingLevelChange(),
		assistantMessage([toolCallItem("cA", "read", { path: "f.txt" }), toolCallItem("cB", "read", { path: "g.txt" })]),
		toolResultMessage("cB", "read", SECRET_BODY, true), // error for g arrives first
		toolResultMessage("cA", "read", markerLine(false)), // preview for f arrives second
		assistantMessage([toolCallItem("cC", "read", { path: "g.txt", offset: 100 })]),
		toolResultMessage("cC", "read", "legacy"),
		assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }]),
	];
	const f = computeFacts(entries);
	// Under FIFO, the error would glue to cA (f) and the preview to cB (g),
	// making cC a continuation. Under exact-ID matching only f is previewed.
	assert.equal(f.pagination.previewResults, 1);
	assert.equal(f.pagination.obligations, 1);
	assert.equal(f.pagination.errorReadResults, 1);
	assert.equal(f.pagination.continuationReads, 0);
	assert.equal(f.pagination.obligationsPaginated, 0);
	assert.equal(f.pagination.unpaginatedPreviews, 1);
	assert.equal(f.pagination.misuse, true);
	assert.equal(f.misuse, true);
	assert.equal(f.pagination.orphanReadCalls, 0);
});

test("run facts v2: orphan and isError aggregates", () => {
	const entries = [
		userMessage(),
		thinkingLevelChange(),
		assistantMessage([toolCallItem("c1", "read", { path: "a.txt" }), toolCallItem("c2", "read", { path: "b.txt" })]),
		toolResultMessage("c1", "read", "legacy"),
		toolResultMessage("c2", "read", "boom", true), // error result consumes its id
		assistantMessage([toolCallItem("c3", "read", { path: "c.txt" })]), // orphan — no result
		assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }]),
	];
	const f = computeFacts(entries);
	assert.equal(f.pagination.orphanReadCalls, 1);
	assert.equal(f.pagination.errorReadResults, 1);
	assert.equal(f.pagination.previewResults, 0);
	assert.equal(f.pagination.obligations, 0);
	assert.equal(f.pagination.misuse, false);
});

test("run facts v2: malformed and duplicate preview-facts markers fail closed via the v2 policy", () => {
	const bad = (content: unknown): unknown[] => [
		userMessage(),
		thinkingLevelChange(),
		assistantMessage([toolCallItem("c1", "read", { path: "a.txt" })]),
		toolResultMessage("c1", "read", content),
		assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }]),
	];
	expectPolicyCode(() => computeFacts(bad(`${markerLine(false)} bogus`)), "FACTS_MALFORMED");
	expectPolicyCode(() => computeFacts(bad(`${markerLine(false)}\n${markerLine(false)}`)), "FACTS_MALFORMED");
});

test("run facts v2: invalid, unknown and duplicate read ids fail closed via the v2 policy", () => {
	const withResults = (results: unknown[]): unknown[] => [
		userMessage(),
		thinkingLevelChange(),
		assistantMessage([toolCallItem("c1", "read", { path: "a.txt" })]),
		...results,
		assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }]),
	];
	expectPolicyCode(() => computeFacts(withResults([toolResultMessage("nope", "read", "x")])), "UNKNOWN_RESULT_ID");
	expectPolicyCode(() => computeFacts(withResults([toolResultMessage("c1", "read", "x"), toolResultMessage("c1", "read", "y")])), "RESULT_ALREADY_CONSUMED");
	expectPolicyCode(
		() => computeFacts([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "toolCall", name: "read", arguments: { path: "a.txt" } }]), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])]),
		"INVALID_CALL_ID",
	);
	expectPolicyCode(
		() => computeFacts([userMessage(), thinkingLevelChange(), assistantMessage([toolCallItem("c1", "read", { path: "a.txt" }), toolCallItem("c1", "read", { path: "b.txt" })]), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])]),
		"DUPLICATE_CALL_ID",
	);
});

test("run facts v2: correctness uses the frozen v2 rubric (spaced/unspaced unicode positive, wrong value negative)", () => {
	for (const unicodeLine of ["unicode: α, 水, 🚀", "unicode: α,水,🚀"]) {
		const finalText = RUBRIC_FULL_TEXT.replace("unicode: α, 水, 🚀", unicodeLine);
		const f = computeFacts([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: finalText }])]);
		assert.equal(f.correctness.passed, true, unicodeLine);
		assert.ok(f.correctness.checks.every((c) => c.passed), unicodeLine);
	}
	const wrong = computeFacts([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT.replace("α, 水, 🚀", "α, 水, 🍕") }])]);
	assert.equal(wrong.correctness.passed, false);
	assert.equal(wrong.correctness.checks.find((c) => c.id === "unicode")?.passed, false);
	assert.equal(wrong.correctness.checks.find((c) => c.id === "build")?.passed, true);
});

test("run facts v2: exact edit/write toolCall counts", () => {
	const entries = [
		userMessage(),
		thinkingLevelChange(),
		assistantMessage([
			toolCallItem("e1", "edit", { path: "a.txt" }),
			toolCallItem("w1", "write", { path: "b.txt" }),
			toolCallItem("r1", "read", { path: "c.txt" }),
			{ type: "text", text: "plain text" },
			toolCallItem("e2", "edit", { path: "d.txt" }),
		]),
		toolResultMessage("r1", "read", "ok"),
		assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }]),
	];
	const f = computeFacts(entries);
	assert.equal(f.editWriteToolCalls, 3);
	assert.equal(countEditWriteToolCallsV2(entries), 3);
	// Non-assistant entries and non-toolCall items never count.
	assert.equal(countEditWriteToolCallsV2([userMessage(), toolResultMessage("r1", "edit", "x")]), 0);
});

test("run facts v2: per-tool totals vs successful bytes (isError results excluded)", () => {
	const entries = [
		userMessage(),
		thinkingLevelChange(),
		assistantMessage([toolCallItem("r1", "read", { path: "a.txt" }), toolCallItem("r2", "read", { path: "b.txt" }), toolCallItem("b1", "bash", { cmd: "x" })]),
		toolResultMessage("r1", "read", "AAAA"),
		toolResultMessage("r2", "read", "BBBBBB", true), // isError — excluded from the successful pass
		toolResultMessage("b1", "bash", "CC"),
		{ type: "message", id: "m-u2", message: { role: "toolResult", toolCallId: "u1", content: "DDDD" } }, // no toolName → (unknown)
		assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }]),
	];
	const f = computeFacts(entries);
	assert.equal(f.toolResultEntries, 4);
	assert.equal(f.successfulToolResultEntries, 3);
	assert.equal(f.totalTextBytes, utf8Bytes("AAAA") + utf8Bytes("BBBBBB") + utf8Bytes("CC") + utf8Bytes("DDDD"));
	assert.equal(f.successfulTextBytes, utf8Bytes("AAAA") + utf8Bytes("CC") + utf8Bytes("DDDD"));
	const byName = new Map(f.perTool.map((row) => [row.toolName, row]));
	assert.deepEqual(
		[...byName.keys()].sort(),
		["(unknown)", "bash", "read"],
	);
	assert.deepEqual(byName.get("read"), { toolName: "read", entries: 2, textBytes: 10, successfulEntries: 1, successfulTextBytes: 4 });
	assert.deepEqual(byName.get("bash"), { toolName: "bash", entries: 1, textBytes: 2, successfulEntries: 1, successfulTextBytes: 2 });
	assert.deepEqual(byName.get("(unknown)"), { toolName: "(unknown)", entries: 1, textBytes: 4, successfulEntries: 1, successfulTextBytes: 4 });
});

test("run facts v2: prompt/model/thinking/compaction/terminal validity failures fail closed", () => {
	// Prompt pin mismatch.
	expectCode(() => computeFacts(validSessionEntries(), true, sha256Hex("a different prompt")), "PROMPT_MISMATCH");
	// First user message with no extractable text.
	expectCode(() => computeFacts([userMessage(""), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])]), "MISSING_PROMPT_TEXT");
	// Assistant model key drift.
	expectCode(() => computeFacts([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { model: "gpt-4o" })]), "MODEL_MISMATCH");
	// Missing / wrong recorded thinking level.
	expectCode(() => computeFacts([userMessage(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])]), "MISSING_THINKING_LEVEL");
	expectCode(() => computeFacts([userMessage(), thinkingLevelChange("low"), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])]), "THINKING_MISMATCH");
	// Compaction present.
	expectCode(
		() => computeFacts([userMessage(), thinkingLevelChange(), { type: "compaction", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } } }, assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])]),
		"COMPACTION_PRESENT",
	);
	// Terminal: error, aborted, or no terminal stop.
	expectCode(() => computeFacts([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "error" })]), "ERRORED");
	expectCode(() => computeFacts([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "aborted" })]), "ABORTED");
	expectCode(
		() => computeFacts([userMessage(), thinkingLevelChange(), assistantMessage([toolCallItem("c1", "read", { path: "a.txt" })]), toolResultMessage("c1", "read", "ok")]),
		"NOT_TERMINAL_STOP",
	);
	// Dev (no enforcement): the same facts are recorded without failing closed.
	const dev = computeFacts([userMessage("not the pinned prompt"), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])], false);
	assert.equal(dev.promptMatches, false);
	assert.equal(dev.thinkingLevel, null);
	assert.equal(dev.terminal.terminalStop, true);
	assert.equal(dev.correctness.passed, true);
});

test("run facts v2: privacy — secrets never appear in v2 core/policy errors or returned aggregate JSON", () => {
	const secrets = [SECRET_CALL_ID, SECRET_PATH, SECRET_BODY, SECRET_THINKING];
	const assertSafeError = (thunk: () => unknown): void => {
		let err: unknown;
		try {
			thunk();
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof Error, `expected an error, got ${String(err)}`);
		for (const s of secrets) {
			assert.ok(!err.message.includes(s), `error message leaks "${s}": ${err.message}`);
		}
	};
	// Policy failures (missing id, consumed id, duplicate markers) with secrets in play.
	assertSafeError(() => computeFacts([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "toolCall", name: "read", arguments: { path: SECRET_PATH } }]), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])]));
	assertSafeError(() =>
		computeFacts([
			userMessage(),
			thinkingLevelChange(),
			assistantMessage([toolCallItem(SECRET_CALL_ID, "read", { path: SECRET_PATH })]),
			toolResultMessage(SECRET_CALL_ID, "read", SECRET_BODY),
			toolResultMessage(SECRET_CALL_ID, "read", SECRET_BODY),
			assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }]),
		]),
	);
	assertSafeError(() =>
		computeFacts([
			userMessage(),
			thinkingLevelChange(),
			assistantMessage([toolCallItem(SECRET_CALL_ID, "read", { path: SECRET_PATH })]),
			toolResultMessage(SECRET_CALL_ID, "read", `${markerLine(false)}\n${SECRET_BODY}\n${markerLine(false)}`),
			assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }]),
		]),
	);
	// Core failure (prompt pin mismatch) — the label and hashes only.
	assertSafeError(() => computeFacts(validSessionEntries(), true, sha256Hex(SECRET_BODY)));
	// Returned aggregate JSON: ids, paths, bodies and thinking stay out.
	const f = computeFacts([
		userMessage(),
		thinkingLevelChange(),
		assistantMessage([toolCallItem(SECRET_CALL_ID, "read", { path: SECRET_PATH }), { type: "thinking", text: SECRET_THINKING }]),
		toolResultMessage(SECRET_CALL_ID, "read", `${markerLine(false)}\n${SECRET_BODY}`),
		assistantMessage([{ type: "text", text: `${SECRET_BODY}\n${RUBRIC_FULL_TEXT}\n${SECRET_THINKING}` }]),
	]);
	const json = JSON.stringify(f);
	for (const s of secrets) {
		assert.ok(!json.includes(s), `run facts JSON leaks "${s}"`);
	}
	// The facts themselves are still correct aggregates.
	assert.equal(f.pagination.previewResults, 1);
	assert.equal(f.correctness.passed, true);
	assert.equal(f.successfulTextBytes, utf8Bytes(`${markerLine(false)}\n${SECRET_BODY}`));
});

// ---------------------------------------------------------------------------
// D. Verdicts (minimal typed RunFactsV2 fixtures)
// ---------------------------------------------------------------------------

function runFactsFixture(overrides: Partial<RunFactsV2>): RunFactsV2 {
	return {
		label: "control-01",
		arm: "control",
		orderIndex: 1,
		sessionBasename: "control-01.json",
		sessionSha256: H64,
		promptSha256: PROMPT_SHA256,
		promptMatches: true,
		requests: 1,
		compactions: 0,
		cost: 0.001,
		input: 100,
		output: 50,
		cacheRead: 10,
		cacheWrite: 5,
		gross: 165,
		toolResultEntries: 1,
		successfulToolResultEntries: 1,
		totalTextBytes: 100,
		successfulTextBytes: 100,
		perTool: [],
		modelKeys: [MODEL_KEY],
		thinkingLevel: "high",
		wallTimeMs: null,
		terminal: {
			messageCount: 3,
			assistantMessageCount: 2,
			compactionCount: 0,
			lastEntryType: "message",
			lastMessageRole: "assistant",
			lastAssistantStopReason: "stop",
			terminalStop: true,
			aborted: false,
			errored: false,
		},
		correctness: { passed: true, checks: V2_RUBRIC_CHECKS.map((c) => ({ id: c.id, passed: true })) },
		pagination: {
			previewResults: 0,
			previewBytes: 0,
			continuationReads: 0,
			continuationBytes: 0,
			obligations: 0,
			obligationsPaginated: 0,
			reachedComplete: 0,
			completionFraction: null,
			reachedFraction: null,
			unpaginatedPreviews: 0,
			misuse: false,
			orphanReadCalls: 0,
			errorReadResults: 0,
		},
		misuse: false,
		editWriteToolCalls: 0,
		...overrides,
	};
}

function runsFor(arm: ArmName, bytes: number[], gross: number[], requests: number[]): RunFactsV2[] {
	return bytes.map((b, i) =>
		runFactsFixture({
			arm,
			label: `${arm}-${String(i + 1).padStart(2, "0")}`,
			orderIndex: i + 1,
			successfulTextBytes: b,
			gross: gross[i] ?? 0,
			requests: requests[i] ?? 0,
		}),
	);
}

test("verdicts v2: bytes median reduction — exact 50% boundary achieved, just below missed", () => {
	const c = runsFor("control", Array(20).fill(100), Array(20).fill(165), Array(20).fill(1));
	const tExact = runsFor("treatment", Array(20).fill(50), Array(20).fill(165), Array(20).fill(1));
	const v = computeVerdictsFromRunsV2(c, tExact, "final");
	const bytes = v.find((x) => x.id === "bytes_median_reduction");
	assert.ok(bytes);
	assert.equal(bytes.status, "ACHIEVED"); // (200 - 100) * 1000 = 500 * 200
	assert.equal(bytes.control, 100);
	assert.equal(bytes.treatment, 50);
	assert.equal(bytes.ratio, 0.5);
	const tBelow = runsFor("treatment", Array(20).fill(51), Array(20).fill(165), Array(20).fill(1));
	assert.equal(computeVerdictsFromRunsV2(c, tBelow, "final").find((x) => x.id === "bytes_median_reduction")?.status, "MISSED");
});

test("verdicts v2: gross median reduction — exact 20% boundary achieved, just below missed", () => {
	const c = runsFor("control", Array(20).fill(100), Array(20).fill(100), Array(20).fill(1));
	const tExact = runsFor("treatment", Array(20).fill(100), Array(20).fill(80), Array(20).fill(1));
	assert.equal(computeVerdictsFromRunsV2(c, tExact, "final").find((x) => x.id === "gross_median_reduction")?.status, "ACHIEVED");
	const tBelow = runsFor("treatment", Array(20).fill(100), Array(20).fill(81), Array(20).fill(1));
	assert.equal(computeVerdictsFromRunsV2(c, tBelow, "final").find((x) => x.id === "gross_median_reduction")?.status, "MISSED");
});

test("verdicts v2: requests median — equality achieves non-increase, any median increase misses", () => {
	const c = runsFor("control", Array(20).fill(100), Array(20).fill(165), Array(20).fill(10));
	const tEq = runsFor("treatment", Array(20).fill(100), Array(20).fill(165), Array(20).fill(10));
	assert.equal(computeVerdictsFromRunsV2(c, tEq, "final").find((x) => x.id === "requests_median_non_increase")?.status, "ACHIEVED");
	// Uniform increase.
	const tUp = runsFor("treatment", Array(20).fill(100), Array(20).fill(165), Array(20).fill(11));
	assert.equal(computeVerdictsFromRunsV2(c, tUp, "final").find((x) => x.id === "requests_median_non_increase")?.status, "MISSED");
	// Median increase with a mixed distribution: 11 of 20 runs above control.
	const tMixed = runsFor("treatment", Array(20).fill(100), Array(20).fill(165), Array.from({ length: 20 }, (_, i) => (i < 9 ? 10 : 20)));
	assert.equal(computeVerdictsFromRunsV2(c, tMixed, "final").find((x) => x.id === "requests_median_non_increase")?.status, "MISSED");
});

test("verdicts v2: gross p90 — exact 105% boundary (20t = 21c) at nearest-rank 18 of 20; top two never affect p90", () => {
	// 17 small values, one rank-18 value, and two extreme top values that
	// must never influence the rank-18 p90 (they differ wildly between arms).
	const controlGross = [...Array(17).fill(100), 1000, 1e9, 1e9];
	const treatmentGross = [...Array(17).fill(100), 1050, 1e12, 1e12];
	const c = runsFor("control", Array(20).fill(100), controlGross, Array(20).fill(1));
	const t = runsFor("treatment", Array(20).fill(100), treatmentGross, Array(20).fill(1));
	const v = computeVerdictsFromRunsV2(c, t, "final");
	const p90 = v.find((x) => x.id === "gross_p90_regression");
	assert.ok(p90);
	assert.equal(p90.status, "ACHIEVED"); // 20 * 1050 = 21 * 1000 exactly
	assert.equal(p90.control, 1000);
	assert.equal(p90.treatment, 1050);
	assert.equal(p90.ratio, 1.05);
	// Just above the boundary: 1051 > 1050 → missed.
	const tAbove = runsFor("treatment", Array(20).fill(100), [...Array(17).fill(100), 1051, 1e12, 1e12], Array(20).fill(1));
	assert.equal(computeVerdictsFromRunsV2(c, tAbove, "final").find((x) => x.id === "gross_p90_regression")?.status, "MISSED");
});

test("verdicts v2: empty arms and zero denominators are NOT_MEASURED", () => {
	const v = computeVerdictsFromRunsV2([], [], "final");
	assert.equal(v.length, VERDICT_IDS.length);
	for (const verdict of v) {
		assert.equal(verdict.status, "NOT_MEASURED");
		assert.equal(verdict.control, null);
		assert.equal(verdict.treatment, null);
		assert.equal(verdict.ratio, null);
		assert.ok(verdict.reason.includes("NOT_MEASURED (never PASS)"), verdict.reason);
	}
	// Zero control denominators: bytes/gross medians and the p90 guard are NOT_MEASURED.
	const zeroControl = runsFor("control", Array(20).fill(0), Array(20).fill(0), Array(20).fill(1));
	const t = runsFor("treatment", Array(20).fill(10), Array(20).fill(10), Array(20).fill(1));
	const v2 = computeVerdictsFromRunsV2(zeroControl, t, "final");
	assert.equal(v2.find((x) => x.id === "bytes_median_reduction")?.status, "NOT_MEASURED");
	assert.equal(v2.find((x) => x.id === "gross_median_reduction")?.status, "NOT_MEASURED");
	assert.equal(v2.find((x) => x.id === "gross_p90_regression")?.status, "NOT_MEASURED");
	// Requests stay measurable when the control requests median is non-zero.
	assert.equal(v2.find((x) => x.id === "requests_median_non_increase")?.status, "ACHIEVED");
});

test("verdicts v2: dev manifests are always NOT_MEASURED with the frozen dev reason and exact label/threshold constants", () => {
	const c = runsFor("control", Array(20).fill(100), Array(20).fill(100), Array(20).fill(1));
	const t = runsFor("treatment", Array(20).fill(50), Array(20).fill(50), Array(20).fill(1));
	const v = computeVerdictsFromRunsV2(c, t, "dev");
	assert.deepEqual(
		v.map((x) => x.id),
		VERDICT_IDS,
	);
	for (const verdict of v) {
		assert.equal(verdict.status, "NOT_MEASURED");
		assert.equal(verdict.control, null);
		assert.equal(verdict.treatment, null);
		assert.equal(verdict.ratio, null);
		assert.ok(verdict.reason.includes("development-phase manifest"), verdict.reason);
	}
	assert.equal(VERDICT_LABELS_V2.bytes_median_reduction, "successful inline bytes median reduction");
	assert.equal(VERDICT_LABELS_V2.gross_median_reduction, "commander gross tokens median reduction");
	assert.equal(VERDICT_LABELS_V2.requests_median_non_increase, "commander requests median non-increase");
	assert.equal(VERDICT_LABELS_V2.gross_p90_regression, "commander gross p90 regression");
	assert.equal(VERDICT_THRESHOLDS_V2.bytes_median_reduction, ">= 50%");
	assert.equal(VERDICT_THRESHOLDS_V2.gross_median_reduction, ">= 20%");
	assert.equal(VERDICT_THRESHOLDS_V2.requests_median_non_increase, "treatment median <= control median");
	assert.equal(VERDICT_THRESHOLDS_V2.gross_p90_regression, "treatment p90 <= 1.05 x control p90");
});

test("verdicts v2: medians, middle-two sums, nearest-rank p90 and arm totals", () => {
	assert.equal(medianOfV2([]), null);
	assert.equal(medianOfV2([3]), 3);
	assert.equal(medianOfV2([1, 2, 3, 4]), 2.5);
	assert.equal(medianOfV2([1, 1, 3, 4, 5]), 3);
	assert.equal(middleTwoSumV2([]), null);
	assert.equal(middleTwoSumV2([1, 2, 3, 4]), 5);
	assert.equal(middleTwoSumV2([1, 1, 3, 4, 5]), 6);
	assert.equal(nearestRankP90V2([]), null);
	assert.equal(nearestRankP90V2([1, 2, 3]), 3); // ceil(0.9 * 3) = 3
	assert.equal(nearestRankP90V2([...Array(17).fill(100), 1000, 1e9, 1e9]), 1000); // rank 18 of 20
	// Arm facts: run count, medians, p90 and exact totals (cost rounded to 9 decimals).
	const runs = [
		runFactsFixture({ label: "control-01", orderIndex: 1, requests: 5, gross: 50, successfulTextBytes: 500, cost: 0.0000000005 }),
		runFactsFixture({ label: "control-02", orderIndex: 2, requests: 1, gross: 100, successfulTextBytes: 400, cost: 0.1 }),
		runFactsFixture({ label: "control-03", orderIndex: 3, requests: 3, gross: 10, successfulTextBytes: 300, cost: 0.2 }),
	];
	const arm = buildArmFactsV2("control", runs);
	assert.equal(arm.arm, "control");
	assert.equal(arm.runCount, 3);
	assert.equal(arm.requestsMedian, 3);
	assert.equal(arm.grossMedian, 50);
	assert.equal(arm.successfulTextBytesMedian, 400);
	assert.equal(arm.grossP90, 100); // ceil(0.9 * 3) = 3 → largest
	assert.equal(arm.totals.requests, 9);
	assert.equal(arm.totals.gross, 160);
	assert.equal(arm.totals.cost, 0.300000001); // 0.0000000005 + 0.1 + 0.2, rounded to 9 decimals
	assert.equal(arm.totals.input, 300);
	assert.equal(arm.totals.output, 150);
	assert.equal(arm.totals.cacheRead, 30);
	assert.equal(arm.totals.cacheWrite, 15);
	assert.equal(arm.totals.successfulTextBytes, 1200);
});

// ---------------------------------------------------------------------------
// E. Static guard (read-only source scan)
// ---------------------------------------------------------------------------

test("static guard: v2 core imports/calls the frozen v2 policy and never the v1 core functions or constants", async () => {
	const source = await readFile(join(process.cwd(), "scripts", "commander-native-tool-benchmark-v2.ts"), "utf8");
	// The v2 core must import and call the frozen v2 policy entry points.
	assert.match(source, /\bevaluateRubricV2\(/);
	assert.match(source, /\bcomputePaginationV2\(/);
	const importBlocks = [...source.matchAll(/import(?:\s+type)?\s*\{[^}]*\}\s*from\s+"([^"]+)"/g)].map((m) => m[0]);
	const policyBlock = importBlocks.find((b) => b.includes('from "./commander-native-tool-benchmark-v2-policy.ts"'));
	assert.ok(policyBlock, "v2 core must import the frozen v2 policy module");
	assert.match(policyBlock, /\bevaluateRubricV2\b/);
	assert.match(policyBlock, /\bcomputePaginationV2\b/);
	assert.ok(importBlocks.some((b) => b.includes('from "./commander-native-tool-benchmark-v2-protocol.ts"')), "v2 core must import the frozen v2 protocol module");
	// The v1 harness may be imported exactly once, for the safe reused
	// primitives only — never the v1 core functions or frozen constants.
	const v1Blocks = importBlocks.filter((b) => b.includes('from "./commander-native-tool-benchmark.ts"'));
	assert.equal(v1Blocks.length, 1, "exactly one v1 harness import (the safe primitives)");
	const v1Block = v1Blocks[0] as string;
	for (const banned of ["computeRunFacts", "computePagination", "parseManifest", "parseCollectionRecord", "FROZEN_NRO_PROTOCOL"]) {
		assert.ok(!new RegExp(`\\b${banned}\\b`).test(v1Block), `v1 harness import must not carry ${banned}`);
	}
});

// ---------------------------------------------------------------------------
// F. Attempt classification (frozen seven-way priority — protocol-v2 §4.3/§8.6)
// ---------------------------------------------------------------------------

const ATTEMPT_RAW_SHA = "ab".repeat(32); // 64 lowercase hex chars
const ATTEMPT_BASENAME = "attempt-1.jsonl";
const STRICT: DeriveAttemptOptionsV2 = { strict: true };
const DEV: DeriveAttemptOptionsV2 = { strict: false };

function deriveFacts(entries: unknown[], opts: DeriveAttemptOptionsV2, expectedPromptSha: string = PROMPT_SHA256, env: ManifestEnvironmentV2 = FROZEN_ENVIRONMENT): AttemptFactsV2 {
	return deriveAttemptFactsV2("attempt-1", "control", ATTEMPT_BASENAME, ATTEMPT_RAW_SHA, entries, expectedPromptSha, env, opts);
}

function attemptCategory(entries: unknown[], opts: DeriveAttemptOptionsV2 = STRICT): AttemptCategoryV2 {
	return deriveFacts(entries, opts).category;
}

function attemptValidEntries(): unknown[] {
	return [userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])];
}

function attemptCompactionEntry(): Record<string, unknown> {
	return { type: "compaction", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } } };
}

test("attempt facts v2: every frozen-priority branch classifies exactly (strict mode)", () => {
	// 1. Non-null wrong prompt hash wins.
	assert.equal(attemptCategory([userMessage("a different prompt"), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])]), "prompt_mismatch");
	// 2. Any observed model mismatch or observed thinking mismatch.
	assert.equal(attemptCategory([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { model: "gpt-4o" })]), "env_drift");
	assert.equal(attemptCategory([userMessage(), thinkingLevelChange("low"), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])]), "env_drift");
	// 3. Any compaction.
	assert.equal(attemptCategory([userMessage(), thinkingLevelChange(), attemptCompactionEntry(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])]), "compaction_present");
	// 4. Terminal abort.
	assert.equal(attemptCategory([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "aborted" })]), "aborted");
	// 5. Terminal error.
	assert.equal(attemptCategory([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "error" })]), "errored");
	// 6. No terminal stop (length stop, or a non-assistant last entry).
	assert.equal(attemptCategory([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "length" })]), "nonterminal");
	assert.equal(attemptCategory([userMessage(), thinkingLevelChange(), assistantMessage([toolCallItem("c1", "read", { path: "a.txt" })]), toolResultMessage("c1", "read", "ok")]), "nonterminal");
	// 7. Machine-observably valid: strict final mode fails closed.
	expectCode(() => deriveFacts(attemptValidEntries(), STRICT), "ATTEMPT_NOT_INVALID");
});

test("attempt facts v2: multi-failure precedence is the frozen order", () => {
	// Wrong prompt + thinking drift + compaction + model drift + aborted → prompt_mismatch.
	const drifted = [userMessage("a different prompt"), thinkingLevelChange("low"), attemptCompactionEntry(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { model: "gpt-4o", stopReason: "aborted" })];
	assert.equal(attemptCategory(drifted), "prompt_mismatch");
	// Correct prompt + thinking drift + compaction + aborted → env_drift.
	const thinkingBeat = [userMessage(), thinkingLevelChange("low"), attemptCompactionEntry(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "aborted" })];
	assert.equal(attemptCategory(thinkingBeat), "env_drift");
	// Correct prompt + model drift + compaction + errored → env_drift.
	const modelBeat = [userMessage(), thinkingLevelChange(), attemptCompactionEntry(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { model: "gpt-4o", stopReason: "error" })];
	assert.equal(attemptCategory(modelBeat), "env_drift");
	// Correct prompt + clean env + compaction + aborted → compaction_present.
	const compactionBeat = [userMessage(), thinkingLevelChange(), attemptCompactionEntry(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "aborted" })];
	assert.equal(attemptCategory(compactionBeat), "compaction_present");
	// Aborted and errored beats nonterminal even though neither is a terminal stop.
	assert.equal(attemptCategory([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "aborted" })]), "aborted");
	assert.equal(attemptCategory([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "error" })]), "errored");
});

test("attempt facts v2: missing user message yields null prompt hash without masking lower-priority categories", () => {
	// No user message at all: null hash, no throw (attempts skip the user/assistant presence requirements).
	const noUser = deriveFacts([thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])], DEV);
	assert.equal(noUser.promptSha256, null);
	assert.equal(noUser.category, "unclassified");
	// Null prompt never preempts: compaction/env/terminal categories still classify.
	assert.equal(attemptCategory([thinkingLevelChange(), attemptCompactionEntry(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "aborted" })]), "compaction_present");
	assert.equal(attemptCategory([thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { model: "gpt-4o" })]), "env_drift");
	assert.equal(attemptCategory([thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "aborted" })]), "aborted");
	assert.equal(attemptCategory([thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "length" })]), "nonterminal");
	// Machine-valid with no user message: strict still fails closed, dev records unclassified.
	expectCode(() => deriveFacts([thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])], STRICT), "ATTEMPT_NOT_INVALID");
	assert.equal(attemptCategory([thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])], DEV), "unclassified");
	// Empty entry list: null prompt, no assistant, no terminal stop → nonterminal.
	const empty = deriveFacts([], DEV);
	assert.equal(empty.promptSha256, null);
	assert.equal(empty.category, "nonterminal");
	assert.deepEqual(empty.modelKeys, []);
	assert.equal(empty.requests, 0);
});

test("attempt facts v2: strict final mode fails closed, non-strict dev mode records unclassified", () => {
	const entries = attemptValidEntries();
	const dev = deriveFacts(entries, DEV);
	assert.equal(dev.category, "unclassified");
	assert.equal(dev.promptSha256, PROMPT_SHA256);
	assert.equal(dev.promptSha256, sha256Hex(PROMPT_TEXT));
	assert.equal(dev.requests, 1);
	assert.equal(dev.compactions, 0);
	assert.deepEqual(dev.modelKeys, [MODEL_KEY]);
	assert.equal(dev.thinkingLevel, FROZEN_ENVIRONMENT.thinkingLevel);
	assert.equal(dev.terminal.terminalStop, true);
	// The same machine-valid entries fail closed under strict mode.
	const err = expectCode(() => deriveFacts(entries, STRICT), "ATTEMPT_NOT_INVALID");
	assert.ok(err.message.includes("attempt-1"), err.message);
	assert.ok(!err.message.includes(PROMPT_TEXT), "ATTEMPT_NOT_INVALID message must not carry prompt text");
});

test("attempt facts v2: provider-error/terminal semantics — only the LAST assistant stop decides", () => {
	// A mid-session provider error followed by a clean terminal stop is machine-valid, not errored.
	const recovered = [userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: "provider error mid-session" }], { stopReason: "error" }), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])];
	assert.equal(attemptCategory(recovered, DEV), "unclassified");
	expectCode(() => deriveFacts(recovered, STRICT), "ATTEMPT_NOT_INVALID");
	// A later aborted stop after the mid-session error classifies aborted.
	assert.equal(attemptCategory([...recovered.slice(0, 3), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "aborted" })]), "aborted");
	// An aborted stop followed by an error stop classifies errored.
	assert.equal(
		attemptCategory([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: "x" }], { stopReason: "aborted" }), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "error" })]),
		"errored",
	);
	// A toolUse stop is nonterminal, never errored.
	assert.equal(attemptCategory([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "toolUse" })]), "nonterminal");
	// Terminal facts mirror the last assistant stop exactly.
	const f = deriveFacts(recovered, DEV);
	assert.equal(f.terminal.lastAssistantStopReason, "stop");
	assert.equal(f.terminal.terminalStop, true);
	assert.equal(f.terminal.errored, false);
	assert.equal(f.terminal.aborted, false);
});

test("attempt facts v2: aggregate facts are exact — requests, compactions, model keys, thinking, terminal", () => {
	const entries = [
		userMessage(),
		thinkingLevelChange(),
		assistantMessage([toolCallItem("c1", "read", { path: "a.txt" })]),
		toolResultMessage("c1", "read", "ok"),
		assistantMessage([{ type: "text", text: "second turn" }], { model: "gpt-4o" }),
		thinkingLevelChange("low"),
		attemptCompactionEntry(),
		assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { stopReason: "length" }),
	];
	const f = deriveFacts(entries, DEV);
	assert.equal(f.label, "attempt-1");
	assert.equal(f.arm, "control");
	assert.equal(f.sessionBasename, ATTEMPT_BASENAME);
	assert.equal(f.rawSha256, ATTEMPT_RAW_SHA);
	assert.equal(f.promptSha256, PROMPT_SHA256);
	assert.equal(f.category, "env_drift"); // observed model + thinking drift beat compaction/terminal
	assert.equal(f.requests, 3); // three assistant messages
	assert.equal(f.compactions, 1);
	assert.deepEqual(f.modelKeys, [MODEL_KEY, "openai-codex/gpt-4o"]); // first-seen order
	assert.equal(f.thinkingLevel, "low"); // last recorded thinking level
	assert.equal(f.terminal.messageCount, 5);
	assert.equal(f.terminal.assistantMessageCount, 3);
	assert.equal(f.terminal.compactionCount, 1);
	assert.equal(f.terminal.lastEntryType, "message");
	assert.equal(f.terminal.lastMessageRole, "assistant");
	assert.equal(f.terminal.lastAssistantStopReason, "length");
	assert.equal(f.terminal.terminalStop, false);
	assert.equal(f.terminal.aborted, false);
	assert.equal(f.terminal.errored, false);
	// Unknown provider/model identities surface as the bounded "unknown" key — still env_drift.
	const unknownModel = deriveFacts([userMessage(), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }], { provider: undefined, model: undefined })], DEV);
	assert.deepEqual(unknownModel.modelKeys, ["unknown/unknown"]);
	assert.equal(unknownModel.category, "env_drift");
});

test("attempt facts v2: malformed entries and usage fail closed through the existing validators", () => {
	const expectValidatorCode = (thunk: () => unknown, code: string): Error => {
		let err: unknown;
		try {
			thunk();
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof Error, `expected validator error ${code}, got ${String(err)}`);
		assert.equal((err as { code?: unknown }).code, code);
		return err;
	};
	// Message entry without a message object (strict JSONL validation).
	expectValidatorCode(() => deriveFacts([{ type: "message", id: "m-broken" }], DEV), "MALFORMED_JSONL");
	// Assistant message without a usage object.
	expectValidatorCode(
		() => deriveFacts([userMessage(), { type: "message", id: "m-a", message: { role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "stop" } }], DEV),
		"MISSING_ASSISTANT_USAGE",
	);
	// Malformed usage on a compaction entry (negative and non-finite components).
	expectValidatorCode(() => deriveFacts([userMessage(), { type: "compaction", usage: { input: -5, output: 1, cacheRead: 0, cacheWrite: 0 } }], DEV), "INVALID_FACTS");
	expectValidatorCode(() => deriveFacts([userMessage(), { type: "compaction", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: NaN } } }], DEV), "INVALID_FACTS");
	// The same validators protect strict mode identically.
	expectValidatorCode(() => deriveFacts([{ type: "message", id: "m-broken" }], STRICT), "MALFORMED_JSONL");
});

test("attempt facts v2: privacy — errors and returned aggregate JSON never leak bodies, ids, tool args, paths or thinking", () => {
	const secrets = [SECRET_CALL_ID, SECRET_PATH, SECRET_BODY, SECRET_THINKING, "SECRET-TOOL-ARG-99"];
	const assertSafeError = (thunk: () => unknown): void => {
		let err: unknown;
		try {
			thunk();
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof Error, `expected an error, got ${String(err)}`);
		for (const s of secrets) {
			assert.ok(!err.message.includes(s), `error message leaks "${s}": ${err.message}`);
		}
	};
	// ATTEMPT_NOT_INVALID with secrets in play.
	assertSafeError(() =>
		deriveFacts(
			[
				userMessage(),
				thinkingLevelChange(),
				assistantMessage([toolCallItem(SECRET_CALL_ID, "read", { path: SECRET_PATH }), { type: "thinking", text: SECRET_THINKING }]),
				toolResultMessage(SECRET_CALL_ID, "read", SECRET_BODY),
				assistantMessage([{ type: "text", text: `${SECRET_BODY}\n${RUBRIC_FULL_TEXT}\n${SECRET_THINKING}` }]),
			],
			STRICT,
		),
	);
	// Validator failures with secrets in play.
	assertSafeError(() => deriveFacts([{ type: "message", id: SECRET_CALL_ID, message: SECRET_BODY }], DEV));
	// Returned aggregate JSON: entry content never surfaces.
	const f = deriveFacts(
		[
			userMessage(),
			thinkingLevelChange(),
			assistantMessage([toolCallItem(SECRET_CALL_ID, "bash", { cmd: "SECRET-TOOL-ARG-99" }), { type: "thinking", text: SECRET_THINKING }]),
			toolResultMessage(SECRET_CALL_ID, "bash", `${SECRET_BODY}\n${SECRET_PATH}`),
			assistantMessage([{ type: "text", text: `${SECRET_BODY}\n${SECRET_THINKING}\n${RUBRIC_FULL_TEXT}` }], { stopReason: "length" }),
		],
		DEV,
	);
	const json = JSON.stringify(f);
	for (const s of secrets) {
		assert.ok(!json.includes(s), `attempt facts JSON leaks "${s}"`);
	}
	// The aggregates themselves stay correct.
	assert.equal(f.category, "nonterminal");
	assert.equal(f.requests, 2);
	assert.equal(f.compactions, 0);
	// The prompt body is hashed only: the hash is returned, the body never is.
	const hashed = deriveFacts([userMessage(SECRET_BODY), thinkingLevelChange(), assistantMessage([{ type: "text", text: RUBRIC_FULL_TEXT }])], DEV);
	assert.equal(hashed.promptSha256, sha256Hex(SECRET_BODY));
	assert.equal(hashed.category, "prompt_mismatch");
	assert.ok(!JSON.stringify(hashed).includes(SECRET_BODY));
});

test("static guard: v2 core exports the v2-native classifier and never imports/calls v1 attempt classification or v1 manifest/analyzer/prepare implementations", async () => {
	const source = await readFile(join(process.cwd(), "scripts", "commander-native-tool-benchmark-v2.ts"), "utf8");
	// The v2-native exports and the extended v2 error-code surface exist.
	assert.match(source, /export interface AttemptFactsV2/);
	assert.match(source, /export interface DeriveAttemptOptionsV2/);
	assert.match(source, /export function deriveAttemptFactsV2\(/);
	assert.match(source, /"ATTEMPT_NOT_INVALID"/);
	// The v1 classifier, analyzer, prepare and manifest implementations never
	// appear as identifiers (the \b boundary excludes the V2-suffixed natives).
	for (const banned of ["deriveAttemptFacts", "analyzeManifestFile", "buildReport", "prepareEvidence", "parseManifest", "parseCollectionRecord"]) {
		assert.ok(!new RegExp(`\\b${banned}\\b`).test(source), `v2 core must not reference ${banned}`);
	}
});
