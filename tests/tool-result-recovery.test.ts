/**
 * P8a tool-result-recovery tests (core/tool-result-recovery.ts).
 *
 * The module is a repository-owned two-phase session-level receipt
 * primitive (pure, no Pi imports): `.pi/workbench/tool-results/<id>.started`
 * (phase 1, exclusive-create) + `<id>.json` (phase 2, atomic publish).
 *
 * Coverage: deterministic path-safe identity derivation and strict
 * identity validation; started-before-final ordering and phase permissions
 * (POSIX); privacy of persisted bytes (raw arguments, session identity,
 * toolCallId, secrets and token shapes never persist — only safe
 * tool/hash/id facts); redaction-first bounded extraction with exact line
 * and UTF-8 byte caps, code-point safety and marker consistency; strict
 * two-phase replay classification (completed replay requires BOTH valid
 * matching phases — finalized-only, missing-started, malformed, unsafe,
 * oversized and cross-phase-conflicting state always fails closed and is
 * never reported completed); incomplete/missing/legacy no-receipt; no
 * overwrite / already-finalized; wrong and forged handles; atomic-finalize
 * failure leaves the started phase recoverably incomplete; parallel
 * distinct ids and same-id racing; repeated recover changes no bytes or
 * mtimes; the bounded project-relative renderer (no absolute root, fixed
 * disclaimer, error-result bounds); recovery id precedence; and the
 * invariant that the core's own bounded output is always accepted by its
 * strict parser (including explicit tiny-cap validation constraints).
 *
 * Temp dirs are always cleaned (withTempDir); platform-specific checks
 * (permissions, symlinks) are skipped on Windows.
 */

import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import { withTempDir } from "./helpers.ts";
import { truncateUtf8, utf8ByteLength } from "../extensions/workbench-runtime/core/milestone-handoff.ts";
import {
	beginReceipt,
	deriveResultId,
	ERROR_MAX_BYTES,
	ERROR_MAX_LINES,
	extractBoundedSummary,
	finalizeReceipt,
	finalizedPathFor,
	MAX_ARTIFACT_BYTES,
	MAX_SESSION_IDENTITY_CHARS,
	MAX_TOOL_CALL_ID_CHARS,
	MAX_TOOL_NAME_CHARS,
	OMISSION_MARKER,
	parseFinalizedArtifact,
	parseStartedArtifact,
	RECEIPT_DISCLAIMER,
	receiptRelativePath,
	recoverReceipt,
	renderReceiptRecovery,
	RESULT_ID_RE,
	RENDER_MAX_BYTES,
	RENDER_MAX_LINES,
	startedPathFor,
	SUMMARY_MAX_BYTES,
	SUMMARY_MAX_LINES,
	toolResultsDir,
	type BeginOutcome,
	type BeginReceiptInput,
	type FinalizeOutcome,
	type FinalizedReceipt,
	type ReceiptHandle,
	type RecoverOutcome,
} from "../extensions/workbench-runtime/core/tool-result-recovery.ts";

const SESSION = "pi-session-2026-01-01T00:00:00.000Z";
const CALL = "call_01H2X3Y4Z5abcde";
const TOOL = "test_tool";
const RAW = { mode: "verify", target: "core", flag: "raw-argument-value" };
const INPUT_HASH = canonicalHash(RAW);
/** Env-style secret (deliberately NOT a well-known token shape). */
const SECRET = "Sup3rS3cretEnvV4lue!";
/** Well-known OpenAI-style `sk-` token shape — scrubbed by pattern without an explicit secret. */
const TOKEN = "sk-abcdefghijklmnopqrstuvwxyz123456789";

/** A valid `wtr1-` id shape that differs from every derived id. */
const OTHER_ID = `wtr1-${"0".repeat(64)}`;

/** Controls that must never appear in a persisted text field (only \n allowed). */
const FORBIDDEN_CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/** True when `text` contains an unpaired (lone) UTF-16 surrogate. */
function hasLoneSurrogate(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			if (i + 1 >= text.length) return true;
			const next = text.charCodeAt(i + 1);
			if (next < 0xdc00 || next > 0xdfff) return true;
			i++; // valid surrogate pair, consumed whole
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

const isPosix = process.platform !== "win32";

function begin(dir: string, overrides: Partial<BeginReceiptInput> = {}): Promise<BeginOutcome> {
	return beginReceipt({
		projectRoot: dir,
		sessionIdentity: SESSION,
		toolCallId: CALL,
		toolName: TOOL,
		rawInput: RAW,
		...overrides,
	});
}

function expectCreated(outcome: BeginOutcome): ReceiptHandle {
	if (outcome.ok && outcome.kind === "created") return outcome.handle;
	assert.fail(`expected created, got ${JSON.stringify(outcome)}`);
}

function expectFinalized(outcome: FinalizeOutcome): FinalizedReceipt {
	if (outcome.ok && outcome.kind === "finalized") return outcome.receipt;
	assert.fail(`expected finalized, got ${JSON.stringify(outcome)}`);
}

function expectCompleted(outcome: RecoverOutcome): FinalizedReceipt {
	if (outcome.ok && outcome.kind === "completed") return outcome.receipt;
	assert.fail(`expected completed, got ${JSON.stringify(outcome)}`);
}

async function createCompleted(dir: string, overrides: Partial<BeginReceiptInput> = {}, content = "ok"): Promise<ReceiptHandle> {
	const handle = expectCreated(await begin(dir, overrides));
	expectFinalized(await finalizeReceipt({ projectRoot: dir, handle, status: "success", content }));
	return handle;
}

function startedArtifact(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: "wtr1",
		schema_version: 1,
		id,
		tool: TOOL,
		input_hash: INPUT_HASH,
		nonce: "0123456789abcdef0123456789abcdef",
		status: "started",
		created_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function finalizedArtifact(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: "wtr1",
		schema_version: 1,
		id,
		tool: TOOL,
		input_hash: INPUT_HASH,
		status: "success",
		error: null,
		summary: "hand-crafted summary",
		summary_omitted_lines: 0,
		summary_omitted_bytes: 0,
		created_at: "2026-01-01T00:00:00.000Z",
		finalized_at: "2026-01-01T00:00:01.000Z",
		...overrides,
	};
}

async function writeStarted(dir: string, id: string, overrides: Record<string, unknown> = {}): Promise<void> {
	await mkdir(toolResultsDir(dir), { recursive: true });
	await writeFile(startedPathFor(dir, id), `${JSON.stringify(startedArtifact(id, overrides), null, 2)}\n`, "utf8");
}

async function writeFinalized(dir: string, id: string, overrides: Record<string, unknown> = {}): Promise<void> {
	await mkdir(toolResultsDir(dir), { recursive: true });
	await writeFile(finalizedPathFor(dir, id), `${JSON.stringify(finalizedArtifact(id, overrides), null, 2)}\n`, "utf8");
}

function assertFailClosedBegin(outcome: BeginOutcome, kind: "corrupt_receipt" | "identity_conflict", label: string): void {
	assert.equal(outcome.ok, false, label);
	if (!outcome.ok) assert.equal(outcome.kind, kind, label);
}

function assertFailClosedRecover(outcome: RecoverOutcome, kind: "corrupt" | "conflict", label: string): void {
	assert.equal(outcome.ok, false, label);
	if (!outcome.ok) assert.equal(outcome.kind, kind, label);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test("deriveResultId is deterministic, 64-hex and path-safe", () => {
	const id = deriveResultId(SESSION, CALL);
	assert.match(id, RESULT_ID_RE);
	assert.equal(id, deriveResultId(SESSION, CALL));
	assert.notEqual(id, deriveResultId(SESSION, `${CALL}x`));
	assert.notEqual(id, deriveResultId(`${SESSION}x`, CALL));
	// Path-safe by construction: no separators, no traversal-capable chars.
	assert.ok(!id.includes("/") && !id.includes("\\") && !id.includes("."));
});

test("beginReceipt rejects invalid identities fail-closed without persisting anything", async () => {
	// The non-JSON raw-input cases are GENUINELY non-canonical: canonicalHash
	// explicitly rejects Date (implicit locale/toString serialization),
	// functions, bigint, Map and NaN — never silently coerced — so begin
	// must fail closed before any id derivation or persistence.
	for (const bad of [new Date(), () => "nope", 123n, new Map([["k", "v"]]), Number.NaN]) {
		assert.throws(() => canonicalHash(bad));
	}
	const cases: Array<[string, Partial<BeginReceiptInput>]> = [
		["empty session", { sessionIdentity: "" }],
		["whitespace-only session", { sessionIdentity: "   " }],
		["overlong session", { sessionIdentity: "s".repeat(MAX_SESSION_IDENTITY_CHARS + 1) }],
		["NUL in session", { sessionIdentity: "a\u0000b" }],
		["newline in session", { sessionIdentity: "a\nb" }],
		["DEL in session", { sessionIdentity: "a\u007fb" }],
		["empty toolCallId", { toolCallId: "" }],
		["overlong toolCallId", { toolCallId: "c".repeat(MAX_TOOL_CALL_ID_CHARS + 1) }],
		["control char in toolCallId", { toolCallId: "a\u0001b" }],
		["empty tool name", { toolName: "" }],
		["overlong tool name", { toolName: "t".repeat(MAX_TOOL_NAME_CHARS + 1) }],
		["control char in tool name", { toolName: "a\u000bb" }],
		["non-JSON raw input (Date)", { rawInput: new Date() }],
		["non-JSON raw input (function)", { rawInput: () => "nope" }],
		["non-JSON raw input (bigint)", { rawInput: 123n }],
		["non-JSON raw input (Map)", { rawInput: new Map([["k", "v"]]) }],
		["non-JSON raw input (NaN)", { rawInput: Number.NaN }],
	];
	for (const [label, patch] of cases) {
		await withTempDir(async (dir) => {
			const out = await begin(dir, patch);
			assert.equal(out.ok, false, label);
			if (!out.ok) assert.equal(out.kind, "invalid_identity", label);
			// Nothing was persisted for an invalid identity.
			await assert.rejects(lstat(toolResultsDir(dir)), { code: "ENOENT" });
		});
	}
});

test("empty/whitespace project roots are unsafe_dir on every entry point", async () => {
	const begun = await beginReceipt({ projectRoot: "", sessionIdentity: SESSION, toolCallId: CALL, toolName: TOOL, rawInput: RAW });
	assert.equal(begun.ok, false);
	if (!begun.ok) {
		assert.equal(begun.kind, "storage_error");
		if (begun.kind === "storage_error") assert.equal(begun.reason, "unsafe_dir");
	}
	const fin = await finalizeReceipt({ projectRoot: "   ", handle: { id: OTHER_ID, toolName: TOOL, inputHash: INPUT_HASH, nonce: "0".repeat(32) }, status: "success", content: "x" });
	assert.equal(fin.ok, false);
	if (!fin.ok) {
		assert.equal(fin.kind, "write_error");
		if (fin.kind === "write_error") assert.equal(fin.reason, "unsafe_dir");
	}
	const rec = await recoverReceipt({ projectRoot: "" });
	assert.equal(rec.ok, false);
	if (!rec.ok) {
		assert.equal(rec.kind, "storage_error");
		if (rec.kind === "storage_error") assert.equal(rec.reason, "unsafe_dir");
	}
});

// ---------------------------------------------------------------------------
// Two-phase lifecycle, ordering, permissions
// ---------------------------------------------------------------------------

test("begin creates an exclusive started phase; finalize publishes the finalized phase with started-before-final ordering", async () => {
	await withTempDir(async (dir) => {
		const h = expectCreated(await begin(dir));
		assert.equal(h.id, deriveResultId(SESSION, CALL));
		assert.match(h.id, RESULT_ID_RE);
		assert.match(h.inputHash, /^[0-9a-f]{64}$/);
		assert.match(h.nonce, /^[0-9a-f]{32}$/);
		// Only the started artifact exists; it strictly parses.
		const startedBytes = await readFile(startedPathFor(dir, h.id), "utf8");
		const startedParsed = parseStartedArtifact(startedBytes, h.id);
		assert.equal(startedParsed.ok, true);
		let createdAt = "";
		if (startedParsed.ok) {
			assert.equal(startedParsed.value.status, "started");
			assert.equal(startedParsed.value.id, h.id);
			assert.equal(startedParsed.value.tool, TOOL);
			assert.equal(startedParsed.value.input_hash, INPUT_HASH);
			assert.equal(startedParsed.value.nonce, h.nonce);
			assert.ok(!Number.isNaN(Date.parse(startedParsed.value.created_at)));
			createdAt = startedParsed.value.created_at;
		}
		await assert.rejects(lstat(finalizedPathFor(dir, h.id)), { code: "ENOENT" });
		if (isPosix) {
			assert.equal((await stat(startedPathFor(dir, h.id))).mode & 0o777, 0o600);
			assert.equal((await stat(toolResultsDir(dir))).mode & 0o777, 0o700);
		}
		// Finalize: ordering is started-before-final; both phases retained.
		const f = expectFinalized(await finalizeReceipt({ projectRoot: dir, handle: h, status: "success", content: "done" }));
		assert.equal(f.created_at, createdAt);
		assert.ok(!Number.isNaN(Date.parse(f.finalized_at)));
		assert.ok(Date.parse(f.finalized_at) >= Date.parse(f.created_at));
		if (isPosix) assert.equal((await stat(finalizedPathFor(dir, h.id))).mode & 0o777, 0o600);
		await lstat(startedPathFor(dir, h.id)); // started phase is retained
		await lstat(finalizedPathFor(dir, h.id));
	});
});

test("recover exposes a completed receipt only after finalize; ordering violation is corrupt", async () => {
	await withTempDir(async (dir) => {
		const h = expectCreated(await begin(dir));
		const r0 = await recoverReceipt({ projectRoot: dir, id: h.id });
		assert.equal(r0.ok, false);
		if (!r0.ok) assert.equal(r0.kind, "incomplete");
		expectFinalized(await finalizeReceipt({ projectRoot: dir, handle: h, status: "success", content: "done" }));
		const r1 = await recoverReceipt({ projectRoot: dir, id: h.id });
		assert.equal(r1.ok, true);
		if (r1.ok) {
			assert.equal(r1.kind, "completed");
			assert.equal(r1.receipt.summary, "done");
		}
		// A hand-crafted finalized phase whose finalized_at precedes
		// created_at is rejected by the strict parser.
		await writeFinalized(dir, h.id, { created_at: "2026-01-02T00:00:00.000Z", finalized_at: "2026-01-01T00:00:00.000Z" });
		assertFailClosedRecover(await recoverReceipt({ projectRoot: dir, id: h.id }), "corrupt", "finalized_at < created_at");
	});
});

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

test("finalize accepts only the created handle, exact statuses, and never a forged handle", async () => {
	await withTempDir(async (dir) => {
		const h = expectCreated(await begin(dir));
		const forge = (patch: Partial<ReceiptHandle>): ReceiptHandle => ({ ...h, ...patch });
		const attempt = async (handle: ReceiptHandle, status: "success" | "error" = "success"): Promise<FinalizeOutcome> =>
			finalizeReceipt({ projectRoot: dir, handle, status, content: "x" });

		// Wrong nonce capability.
		let out = await attempt(forge({ nonce: "f".repeat(32) }));
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.kind, "invalid_handle");
		// Wrong tool name.
		out = await attempt(forge({ toolName: "other_tool" }));
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.kind, "identity_conflict");
		// Wrong input hash.
		out = await attempt(forge({ inputHash: "1".repeat(64) }));
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.kind, "identity_conflict");
		// A different (valid-shaped) id: no started phase for it.
		out = await attempt(forge({ id: OTHER_ID }));
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.kind, "missing_started");
		// Malformed handles never reach the store.
		out = await attempt(forge({ nonce: "short" }));
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.kind, "invalid_handle");
		out = await attempt(forge({ id: "wtr1-xyz" }));
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.kind, "invalid_handle");
		out = await attempt(forge({ inputHash: "zz" }));
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.kind, "invalid_handle");
		// Unknown status is refused.
		out = await finalizeReceipt({ projectRoot: dir, handle: h, status: "bogus" as "success", content: "x" });
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.kind, "invalid_handle");
		// The real handle still works afterwards.
		expectFinalized(await finalizeReceipt({ projectRoot: dir, handle: h, status: "success", content: "ok" }));
	});
});

test("finalize twice is already_finalized and never overwrites the artifact", async () => {
	await withTempDir(async (dir) => {
		const h = expectCreated(await begin(dir));
		expectFinalized(await finalizeReceipt({ projectRoot: dir, handle: h, status: "success", content: "first" }));
		const bytes = await readFile(finalizedPathFor(dir, h.id));
		const second = await finalizeReceipt({ projectRoot: dir, handle: h, status: "error", content: "second", error: "changed" });
		assert.equal(second.ok, false);
		if (!second.ok) assert.equal(second.kind, "already_finalized");
		assert.deepEqual(await readFile(finalizedPathFor(dir, h.id)), bytes);
		expectCompleted(await recoverReceipt({ projectRoot: dir, id: h.id }));
	});
});

// ---------------------------------------------------------------------------
// Failure atomicity
// ---------------------------------------------------------------------------

test("atomic-finalize failure leaves the started phase intact and recoverably incomplete", async () => {
	await withTempDir(async (dir) => {
		const h = expectCreated(await begin(dir));
		const startedBytes = await readFile(startedPathFor(dir, h.id));
		if (isPosix) {
			// Unwritable receipt directory: the tmp write fails and the
			// finalized artifact never appears.
			await chmod(toolResultsDir(dir), 0o500);
			const out = await finalizeReceipt({ projectRoot: dir, handle: h, status: "success", content: "x" });
			await chmod(toolResultsDir(dir), 0o700);
			assert.equal(out.ok, false);
			if (!out.ok) {
				assert.equal(out.kind, "write_error");
				if (out.kind === "write_error") assert.equal(out.reason, "tmp_write_failed");
			}
		} else {
			// Portable failure: a directory squatting at the finalized path.
			await mkdir(finalizedPathFor(dir, h.id));
			const out = await finalizeReceipt({ projectRoot: dir, handle: h, status: "success", content: "x" });
			assert.equal(out.ok, false);
			if (!out.ok) {
				assert.equal(out.kind, "write_error");
				if (out.kind === "write_error") assert.equal(out.reason, "unsafe_target");
			}
		}
		// The started phase is untouched and recovery still sees incomplete.
		assert.deepEqual(await readFile(startedPathFor(dir, h.id)), startedBytes);
		const rec = await recoverReceipt({ projectRoot: dir, id: h.id });
		assert.equal(rec.ok, false);
		if (!rec.ok) assert.equal(rec.kind, "incomplete");
	});
});

// ---------------------------------------------------------------------------
// Privacy and redaction
// ---------------------------------------------------------------------------

test("persisted bytes carry only safe tool/hash/id facts — never raw arguments, session identity, toolCallId, secrets or tokens", async () => {
	await withTempDir(async (dir) => {
		const h = await createCompleted(dir, {}, "completed successfully");
		const startedRaw = await readFile(startedPathFor(dir, h.id), "utf8");
		const finalizedRaw = await readFile(finalizedPathFor(dir, h.id), "utf8");
		for (const raw of [startedRaw, finalizedRaw]) {
			assert.ok(!raw.includes(SESSION), "session identity must never persist");
			assert.ok(!raw.includes(CALL), "toolCallId must never persist");
			assert.ok(!raw.includes("raw-argument-value"), "raw argument values must never persist");
			assert.ok(!raw.includes(JSON.stringify(RAW)), "raw input must never persist");
			assert.ok(!raw.includes(SECRET), "env secret must never persist");
			assert.ok(!raw.includes(TOKEN), "token shape must never persist");
		}
		// Only safe identity facts persist: id, tool name, input hash.
		assert.ok(startedRaw.includes(h.id) && finalizedRaw.includes(h.id));
		assert.ok(startedRaw.includes(TOOL) && finalizedRaw.includes(TOOL));
		assert.ok(startedRaw.includes(INPUT_HASH) && finalizedRaw.includes(INPUT_HASH));
		// The nonce capability lives only in the started phase.
		assert.ok(startedRaw.includes(h.nonce));
		assert.ok(!finalizedRaw.includes(h.nonce));
	});
});

test("env/token redaction runs first — a secret at the truncation boundary never leaks", async () => {
	await withTempDir(async (dir) => {
		const h = expectCreated(await begin(dir));
		// The secret starts AFTER the byte cap would cut: redaction replaces
		// it in the FULL content before truncation, so no fragment survives.
		const content = `A${"x".repeat(2000)}${SECRET}${"y".repeat(100)}`;
		expectFinalized(await finalizeReceipt({ projectRoot: dir, handle: h, status: "success", content, secrets: [SECRET] }));
		const rec = expectCompleted(await recoverReceipt({ projectRoot: dir, id: h.id }));
		assert.ok(!rec.summary.includes(SECRET));
		assert.ok(!rec.summary.includes("Sup3rS3cret"));
		assert.ok(!(await readFile(finalizedPathFor(dir, h.id), "utf8")).includes(SECRET));

		// Well-known token shapes are scrubbed even without explicit secrets.
		const h2 = expectCreated(await begin(dir, { toolCallId: `${CALL}-token` }));
		expectFinalized(await finalizeReceipt({ projectRoot: dir, handle: h2, status: "success", content: `prefix ${TOKEN} suffix` }));
		const rec2 = expectCompleted(await recoverReceipt({ projectRoot: dir, id: h2.id }));
		assert.ok(!rec2.summary.includes(TOKEN), "token shape must never survive into the summary");
		assert.ok(rec2.summary.includes("[REDACTED]"), "replaced by the redaction marker");
		const raw2 = await readFile(finalizedPathFor(dir, h2.id), "utf8");
		assert.ok(!raw2.includes(TOKEN), "token shape must never persist in the artifact");
		assert.ok(raw2.includes("[REDACTED]"), "persisted artifact carries the redaction marker");
	});
});

// ---------------------------------------------------------------------------
// Bounds: exact caps, marker consistency, code-point safety, controls
// ---------------------------------------------------------------------------

test("extractBoundedSummary enforces exact line and byte caps with marker consistency", () => {
	const oneLine = "x".repeat(10);
	// 19 lines fit: no marker, no omission.
	let bt = extractBoundedSummary(Array(19).fill(oneLine).join("\n"), [], SUMMARY_MAX_LINES, SUMMARY_MAX_BYTES);
	assert.equal(bt.lines, 19);
	assert.equal(bt.omittedLines, 0);
	assert.equal(bt.omittedBytes, 0);
	assert.ok(!bt.text.endsWith(OMISSION_MARKER));
	// 20 lines: one content line is reserved for the marker inside the caps.
	bt = extractBoundedSummary(Array(20).fill(oneLine).join("\n"), [], SUMMARY_MAX_LINES, SUMMARY_MAX_BYTES);
	assert.equal(bt.lines, SUMMARY_MAX_LINES);
	assert.equal(bt.omittedLines, 1);
	assert.ok(bt.text.endsWith(OMISSION_MARKER));
	// 21 lines: two dropped.
	bt = extractBoundedSummary(Array(21).fill(oneLine).join("\n"), [], SUMMARY_MAX_LINES, SUMMARY_MAX_BYTES);
	assert.equal(bt.omittedLines, 2);
	// Byte cap: exactly 2036 bytes fit; 2037 bytes truncate to 2036 + marker = 2048.
	bt = extractBoundedSummary("x".repeat(SUMMARY_MAX_BYTES - OMISSION_MARKER.length), [], SUMMARY_MAX_LINES, SUMMARY_MAX_BYTES);
	assert.equal(bt.bytes, SUMMARY_MAX_BYTES - OMISSION_MARKER.length);
	assert.equal(bt.omittedBytes, 0);
	assert.ok(!bt.text.endsWith(OMISSION_MARKER));
	bt = extractBoundedSummary("x".repeat(SUMMARY_MAX_BYTES - OMISSION_MARKER.length + 1), [], SUMMARY_MAX_LINES, SUMMARY_MAX_BYTES);
	assert.equal(bt.bytes, SUMMARY_MAX_BYTES);
	assert.equal(bt.omittedBytes, 1);
	assert.ok(bt.text.endsWith(OMISSION_MARKER));
	// Marker presence EXACTLY matches the omission facts across cap grids.
	const grids: Array<[number, number]> = [
		[2, 13],
		[2, 2048],
		[3, 100],
		[8, 512],
		[19, 2048],
		[20, 13],
		[20, 2048],
		[5, 1000],
	];
	for (const [maxLines, maxBytes] of grids) {
		const out = extractBoundedSummary(`héllo 🚀 中文\n${"y".repeat(500)}\nline3`, [SECRET], maxLines, maxBytes);
		assert.ok(out.lines <= maxLines, `lines ${out.lines} > ${maxLines}`);
		assert.ok(out.bytes <= maxBytes, `bytes ${out.bytes} > ${maxBytes}`);
		const omitted = out.omittedLines > 0 || out.omittedBytes > 0;
		assert.equal(out.text.endsWith(OMISSION_MARKER), omitted, `marker mismatch at ${maxLines}/${maxBytes}`);
	}
});

test("tiny and out-of-range caps are rejected explicitly (RangeError), never producing a parser-rejected record", () => {
	const bad: Array<[number, number]> = [
		[1, 2048], // marker line cannot fit
		[2, 12], // marker bytes cannot fit
		[2, 0],
		[0, 2048],
		[21, 2048], // above the strict parser's persisted caps
		[2, 2049],
		[2.5, 2048],
		[20, 12.5],
		[Number.NaN, 2048],
		[Number.POSITIVE_INFINITY, 2048],
	];
	for (const [maxLines, maxBytes] of bad) {
		assert.throws(() => extractBoundedSummary("x", [], maxLines, maxBytes), RangeError, `caps ${maxLines}/${maxBytes}`);
	}
	// Minimum supported caps still work and satisfy the marker rule.
	const min = extractBoundedSummary("xy", [], 2, 13);
	assert.equal(min.text, "x\n[truncated]");
	assert.equal(min.bytes, 13);
	assert.equal(min.lines, 2);
	assert.equal(min.omittedBytes, 1);
});

test("truncation is code-point safe and never splits multibyte characters", () => {
	const emoji = "🚀";
	const bt = extractBoundedSummary(emoji.repeat(510), [], SUMMARY_MAX_LINES, SUMMARY_MAX_BYTES);
	assert.equal(bt.bytes, SUMMARY_MAX_BYTES);
	assert.ok(bt.text.endsWith(OMISSION_MARKER));
	// The kept content is exactly 509 complete code points (2036 bytes).
	const kept = bt.text.slice(0, -OMISSION_MARKER.length);
	assert.equal(kept, emoji.repeat(509));
	assert.equal(utf8ByteLength(kept), SUMMARY_MAX_BYTES - OMISSION_MARKER.length);
	// No unpaired surrogates survive, and the text round-trips through UTF-8.
	assert.ok(!hasLoneSurrogate(bt.text));
	assert.equal(Buffer.from(bt.text, "utf8").toString("utf8"), bt.text);
	// truncateUtf8 (used by the helper) also stays code-point safe.
	assert.equal(truncateUtf8("a🚀b", 2), "a");
	assert.equal(truncateUtf8("a🚀b", 3), "a");
});

test("control characters are sanitized; a marker-looking content suffix never fakes an omission", () => {
	// Sanitization: every forbidden control is replaced, only \n survives.
	const bt = extractBoundedSummary("a\u0000b\u0001c\u001fd\u007fe\rf", [], SUMMARY_MAX_LINES, SUMMARY_MAX_BYTES);
	assert.ok(!FORBIDDEN_CONTROL_RE.test(bt.text));
	// Natural marker-like suffix with NO omission: stripped, so marker
	// presence exactly matches the omission facts (parser invariant).
	const nat = extractBoundedSummary("hello\n[truncated]", [], SUMMARY_MAX_LINES, SUMMARY_MAX_BYTES);
	assert.equal(nat.text, "hello");
	assert.equal(nat.omittedLines, 0);
	assert.equal(nat.omittedBytes, 0);
	assert.ok(!nat.text.endsWith(OMISSION_MARKER));
	const nat2 = extractBoundedSummary("\n[truncated]", [], SUMMARY_MAX_LINES, SUMMARY_MAX_BYTES);
	assert.equal(nat2.text, "");
	// Repeated marker-like suffixes are all stripped.
	const nat3 = extractBoundedSummary("a\n[truncated]\n[truncated]", [], SUMMARY_MAX_LINES, SUMMARY_MAX_BYTES);
	assert.equal(nat3.text, "a");
	// A REAL truncation that lands on marker-like content still ends with
	// the marker and reports the omission.
	const real = extractBoundedSummary(`${"z".repeat(2050)}\n[truncated]`, [], SUMMARY_MAX_LINES, SUMMARY_MAX_BYTES);
	assert.ok(real.text.endsWith(OMISSION_MARKER));
	assert.ok(real.omittedBytes > 0);
});

test("error facts are bounded to the smaller caps; success receipts never carry an error", async () => {
	await withTempDir(async (dir) => {
		const h = expectCreated(await begin(dir));
		const bigError = `${Array(30).fill("error line with detail").join("\n")}\n${"E".repeat(3000)} tail ${SECRET}`;
		expectFinalized(await finalizeReceipt({ projectRoot: dir, handle: h, status: "error", content: "failed", error: bigError, secrets: [SECRET] }));
		const rec = expectCompleted(await recoverReceipt({ projectRoot: dir, id: h.id }));
		assert.equal(rec.status, "error");
		assert.ok(rec.error !== null);
		if (rec.error !== null) {
			assert.ok(utf8ByteLength(rec.error) <= ERROR_MAX_BYTES, "error bytes exceed cap");
			assert.ok(rec.error.split("\n").length <= ERROR_MAX_LINES, "error lines exceed cap");
			assert.ok(!FORBIDDEN_CONTROL_RE.test(rec.error));
			assert.ok(!rec.error.includes(SECRET));
			assert.ok(rec.error.endsWith(OMISSION_MARKER));
		}
		// Success with an error argument: the error fact is null.
		const h2 = expectCreated(await begin(dir, { toolCallId: `${CALL}-ok` }));
		expectFinalized(await finalizeReceipt({ projectRoot: dir, handle: h2, status: "success", content: "ok", error: "ignored" }));
		const rec2 = expectCompleted(await recoverReceipt({ projectRoot: dir, id: h2.id }));
		assert.equal(rec2.error, null);
	});
});

// ---------------------------------------------------------------------------
// Strict two-phase replay classification (Commander review fix)
// ---------------------------------------------------------------------------

test("completed replay requires BOTH valid matching phases and never overwrites", async () => {
	await withTempDir(async (dir) => {
		const h = await createCompleted(dir, {}, "first completion");
		const startedBytes = await readFile(startedPathFor(dir, h.id));
		const replay = await begin(dir);
		assert.equal(replay.ok, false);
		if (!replay.ok) {
			assert.equal(replay.kind, "completed_replay");
			if (replay.kind === "completed_replay") {
				assert.equal(replay.receipt.id, h.id);
				assert.equal(replay.receipt.tool, TOOL);
				assert.equal(replay.receipt.input_hash, INPUT_HASH);
				assert.equal(replay.receipt.summary, "first completion");
			}
		}
		// No-overwrite: the started artifact is byte-identical after replay.
		assert.deepEqual(await readFile(startedPathFor(dir, h.id)), startedBytes);
	});
});

test("finalized-only receipts fail closed and are never completed", async () => {
	await withTempDir(async (dir) => {
		const id = deriveResultId(SESSION, CALL);
		await writeFinalized(dir, id);
		assertFailClosedBegin(await begin(dir), "corrupt_receipt", "finalized-only begin");
		assertFailClosedRecover(await recoverReceipt({ projectRoot: dir, id }), "corrupt", "finalized-only recover");
		// A finalized-only receipt for an UNRELATED id is simply missing.
		const other = await recoverReceipt({ projectRoot: dir, id: OTHER_ID });
		assert.equal(other.ok, false);
		if (!other.ok) assert.equal(other.kind, "missing");
	});
});

test("every malformed started phase with a valid finalized phase fails closed", async () => {
	const variants: Array<[string, Record<string, unknown>]> = [
		["not json", { __raw: "not json" }],
		["extra field", { extra: 1 }],
		["missing nonce", { nonce: undefined }],
		["bad nonce", { nonce: "zz" }],
		["bad status", { status: "done" }],
		["bad created_at", { created_at: "yesterday" }],
		["wrong id", { id: OTHER_ID }],
		["wrong schema", { schema: "wtr2" }],
		["wrong version", { schema_version: 2 }],
		["control char in tool", { tool: "a\u0000b" }],
	];
	for (const [label, patch] of variants) {
		await withTempDir(async (dir) => {
			const id = deriveResultId(SESSION, CALL);
			await writeFinalized(dir, id);
			if (patch.__raw !== undefined) {
				await writeFile(startedPathFor(dir, id), patch.__raw as string, "utf8");
			} else {
				await writeFile(startedPathFor(dir, id), JSON.stringify(startedArtifact(id, patch)), "utf8");
			}
			assertFailClosedBegin(await begin(dir), "corrupt_receipt", `begin: ${label}`);
			assertFailClosedRecover(await recoverReceipt({ projectRoot: dir, id }), "corrupt", `recover: ${label}`);
		});
	}
});

test("every malformed finalized phase with a valid started phase fails closed and blocks finalize", async () => {
	const variants: Array<[string, Record<string, unknown> | string]> = [
		["not json", "not json"],
		["extra field", { extra: 1 }],
		["missing summary", { summary: undefined }],
		["forbidden control in summary", { summary: "a\u0000b" }],
		["summary over byte cap", { summary: "x".repeat(SUMMARY_MAX_BYTES + 1) }],
		["summary over line cap", { summary: Array(SUMMARY_MAX_LINES + 1).fill("x").join("\n") }],
		["marker without omission", { summary: "ok\n[truncated]" }],
		["omission without marker", { summary: "ok", summary_omitted_lines: 1 }],
		["negative omissions", { summary: "ok", summary_omitted_bytes: -1 }],
		["bad status", { status: "done" }],
		["bad input hash", { input_hash: "zz" }],
		["forbidden control in error", { status: "error", error: "a\u0001b" }],
		["error over byte cap", { status: "error", error: "e".repeat(ERROR_MAX_BYTES + 1) }],
		["error over line cap", { status: "error", error: Array(ERROR_MAX_LINES + 1).fill("e").join("\n") }],
		["finalized before started", { created_at: "2026-01-02T00:00:00.000Z", finalized_at: "2026-01-01T00:00:00.000Z" }],
		["wrong schema version", { schema_version: 2 }],
	];
	for (const [label, patch] of variants) {
		await withTempDir(async (dir) => {
			const h = expectCreated(await begin(dir));
			if (typeof patch === "string") {
				await writeFile(finalizedPathFor(dir, h.id), patch, "utf8");
			} else {
				await writeFile(finalizedPathFor(dir, h.id), JSON.stringify(finalizedArtifact(h.id, patch)), "utf8");
			}
			assertFailClosedBegin(await begin(dir), "corrupt_receipt", `begin: ${label}`);
			assertFailClosedRecover(await recoverReceipt({ projectRoot: dir, id: h.id }), "corrupt", `recover: ${label}`);
			// No-overwrite: an existing finalized artifact (even malformed)
			// is never replaced — finalize reports already_finalized.
			const fin = await finalizeReceipt({ projectRoot: dir, handle: h, status: "success", content: "x" });
			assert.equal(fin.ok, false, label);
			if (!fin.ok) assert.equal(fin.kind, "already_finalized", label);
		});
	}
});

test("cross-phase conflicts (tool / input_hash / created_at) fail closed, never completed", async () => {
	await withTempDir(async (dir) => {
		const id = deriveResultId(SESSION, CALL);
		// Tool mismatch between the two phases.
		await writeStarted(dir, id);
		await writeFinalized(dir, id, { tool: "other_tool" });
		assertFailClosedBegin(await begin(dir), "corrupt_receipt", "tool mismatch begin");
		assertFailClosedRecover(await recoverReceipt({ projectRoot: dir, id }), "conflict", "tool mismatch recover");

		// input_hash mismatch between the two phases.
		await writeStarted(dir, id);
		await writeFinalized(dir, id, { input_hash: "1".repeat(64) });
		assertFailClosedBegin(await begin(dir), "corrupt_receipt", "hash mismatch begin");
		assertFailClosedRecover(await recoverReceipt({ projectRoot: dir, id }), "conflict", "hash mismatch recover");

		// created_at mismatch between the two phases (finalized_at still
		// after created_at so only the cross-phase check can fire).
		await writeStarted(dir, id);
		await writeFinalized(dir, id, { created_at: "2026-01-02T00:00:00.000Z", finalized_at: "2026-01-02T00:00:01.000Z" });
		assertFailClosedBegin(await begin(dir), "corrupt_receipt", "created_at mismatch begin");
		assertFailClosedRecover(await recoverReceipt({ projectRoot: dir, id }), "conflict", "created_at mismatch recover");

		// Phases agreeing with each other but differing from the REQUESTED
		// identity: begin (which carries the requested tool/input facts)
		// classifies identity_conflict and never replays. recover carries NO
		// requested identity facts beyond the id (the exact-one /
		// requested-identity runtime rule is a P8b concern, not a core rule),
		// so a self-consistent pair is a completed receipt for that id —
		// recover's fail-closed codes cover cross-phase conflicts (above),
		// never self-consistent foreign facts.
		await writeStarted(dir, id, { tool: "other_tool", input_hash: "2".repeat(64) });
		await writeFinalized(dir, id, { tool: "other_tool", input_hash: "2".repeat(64) });
		assertFailClosedBegin(await begin(dir), "identity_conflict", "foreign identity begin");
		const foreign = await recoverReceipt({ projectRoot: dir, id });
		assert.equal(foreign.ok, true, "recover carries no requested identity facts");
		if (foreign.ok) {
			assert.equal(foreign.kind, "completed");
			assert.equal(foreign.receipt.tool, "other_tool");
			assert.equal(foreign.receipt.input_hash, "2".repeat(64));
		}
	});
});

test("unsafe and oversized artifacts fail closed on begin, finalize and recover", async () => {
	await withTempDir(async (dir) => {
		const id = deriveResultId(SESSION, CALL);
		const handle: ReceiptHandle = { id, toolName: TOOL, inputHash: INPUT_HASH, nonce: "0123456789abcdef0123456789abcdef" };

		// Oversized started artifact (> MAX_ARTIFACT_BYTES).
		await writeStarted(dir, id);
		await writeFile(startedPathFor(dir, id), "x".repeat(MAX_ARTIFACT_BYTES + 1), "utf8");
		assertFailClosedBegin(await begin(dir), "corrupt_receipt", "oversize started begin");
		let fin = await finalizeReceipt({ projectRoot: dir, handle, status: "success", content: "x" });
		assert.equal(fin.ok, false);
		if (!fin.ok) assert.equal(fin.kind, "corrupt_started", "oversize started finalize");
		assertFailClosedRecover(await recoverReceipt({ projectRoot: dir, id }), "corrupt", "oversize started recover");

		// Oversized finalized artifact (with a valid started phase).
		await writeStarted(dir, id);
		await writeFile(finalizedPathFor(dir, id), "y".repeat(MAX_ARTIFACT_BYTES + 1), "utf8");
		assertFailClosedBegin(await begin(dir), "corrupt_receipt", "oversize finalized begin");
		assertFailClosedRecover(await recoverReceipt({ projectRoot: dir, id }), "corrupt", "oversize finalized recover");

		if (isPosix) {
			// Symlinked started artifact.
			await writeFile(join(dir, "target.txt"), "outside content", "utf8");
			await writeStarted(dir, id);
			await unlink(startedPathFor(dir, id));
			await symlink(join(dir, "target.txt"), startedPathFor(dir, id));
			assertFailClosedBegin(await begin(dir), "corrupt_receipt", "symlink started begin");
			fin = await finalizeReceipt({ projectRoot: dir, handle, status: "success", content: "x" });
			assert.equal(fin.ok, false);
			if (!fin.ok) assert.equal(fin.kind, "corrupt_started", "symlink started finalize");
			assertFailClosedRecover(await recoverReceipt({ projectRoot: dir, id }), "corrupt", "symlink started recover");

			// Symlinked finalized artifact (started phase restored to a real
			// file; the handle nonce matches the hand-written started phase).
			await unlink(startedPathFor(dir, id));
			await writeStarted(dir, id);
			await unlink(finalizedPathFor(dir, id));
			await symlink(join(dir, "target.txt"), finalizedPathFor(dir, id));
			assertFailClosedBegin(await begin(dir), "corrupt_receipt", "symlink finalized begin");
			fin = await finalizeReceipt({ projectRoot: dir, handle, status: "success", content: "x" });
			assert.equal(fin.ok, false);
			if (!fin.ok) {
				assert.equal(fin.kind, "write_error");
				if (fin.kind === "write_error") assert.equal(fin.reason, "unsafe_target");
			}
			assertFailClosedRecover(await recoverReceipt({ projectRoot: dir, id }), "corrupt", "symlink finalized recover");
		}
	});
});

test("an escaping .pi symlink blocks every entry point as unsafe_dir before any write", async () => {
	if (!isPosix) return;
	await withTempDir(async (dir) => {
		await withTempDir(async (outside) => {
			await symlink(outside, join(dir, ".pi"));
			const b = await begin(dir);
			assert.equal(b.ok, false);
			if (!b.ok) {
				assert.equal(b.kind, "storage_error");
				if (b.kind === "storage_error") assert.equal(b.reason, "unsafe_dir");
			}
			const f = await finalizeReceipt({ projectRoot: dir, handle: { id: OTHER_ID, toolName: TOOL, inputHash: INPUT_HASH, nonce: "0".repeat(32) }, status: "success", content: "x" });
			assert.equal(f.ok, false);
			if (!f.ok) {
				assert.equal(f.kind, "write_error");
				if (f.kind === "write_error") assert.equal(f.reason, "unsafe_dir");
			}
			const r = await recoverReceipt({ projectRoot: dir, id: OTHER_ID });
			assert.equal(r.ok, false);
			if (!r.ok) {
				assert.equal(r.kind, "storage_error");
				if (r.kind === "storage_error") assert.equal(r.reason, "unsafe_dir");
			}
			// Nothing was written through the symlink.
			assert.deepEqual(await readdir(outside), []);
		});
	});
});

// ---------------------------------------------------------------------------
// Missing / incomplete / legacy
// ---------------------------------------------------------------------------

test("missing, incomplete and identity-conflicting states behave fail-closed; foreign files are ignored", async () => {
	await withTempDir(async (dir) => {
		// Missing.
		let rec = await recoverReceipt({ projectRoot: dir, id: OTHER_ID });
		assert.equal(rec.ok, false);
		if (!rec.ok) assert.equal(rec.kind, "missing");

		// Foreign/legacy files in the directory are never read or rewritten.
		await mkdir(toolResultsDir(dir), { recursive: true });
		await writeFile(join(toolResultsDir(dir), "legacy.json"), "old format", "utf8");
		await writeFile(join(toolResultsDir(dir), ".stale.tmp"), "leftover", "utf8");
		const sorted = (entries: string[]): string[] => [...entries].sort();

		// Incomplete: started only.
		const h = expectCreated(await begin(dir));
		assert.deepEqual(sorted(await readdir(toolResultsDir(dir))), sorted([...["legacy.json", ".stale.tmp"], `${h.id}.started`]));
		rec = await recoverReceipt({ projectRoot: dir, id: h.id });
		assert.equal(rec.ok, false);
		if (!rec.ok) assert.equal(rec.kind, "incomplete");
		// Replaying begin over an incomplete receipt with the same identity.
		const replay = await begin(dir);
		assert.equal(replay.ok, false);
		if (!replay.ok) assert.equal(replay.kind, "incomplete_replay");
		// A different identity is a conflict, never a replay.
		const conflict = await begin(dir, { toolName: "other_tool" });
		assert.equal(conflict.ok, false);
		if (!conflict.ok) assert.equal(conflict.kind, "identity_conflict");
		const conflict2 = await begin(dir, { rawInput: { different: true } });
		assert.equal(conflict2.ok, false);
		if (!conflict2.ok) assert.equal(conflict2.kind, "identity_conflict");

		// Recover is strictly read-only: the directory listing is unchanged.
		assert.deepEqual(sorted(await readdir(toolResultsDir(dir))), sorted([...["legacy.json", ".stale.tmp"], `${h.id}.started`]));

		// Completing the cycle still works afterwards.
		expectFinalized(await finalizeReceipt({ projectRoot: dir, handle: h, status: "success", content: "done" }));
		expectCompleted(await recoverReceipt({ projectRoot: dir, id: h.id }));
	});
});

test("legacy unknown-schema receipts fail closed and are never migrated or rewritten", async () => {
	await withTempDir(async (dir) => {
		const id = deriveResultId(SESSION, CALL);
		await writeStarted(dir, id, { schema_version: 2 });
		const bytes = await readFile(startedPathFor(dir, id));
		assertFailClosedBegin(await begin(dir), "corrupt_receipt", "legacy version begin");
		assertFailClosedRecover(await recoverReceipt({ projectRoot: dir, id }), "corrupt", "legacy version recover");
		// No migration/rewrite: bytes are identical after the reads.
		assert.deepEqual(await readFile(startedPathFor(dir, id)), bytes);
	});
});

// ---------------------------------------------------------------------------
// Parallelism
// ---------------------------------------------------------------------------

test("parallel receipts with distinct ids are fully independent", async () => {
	await withTempDir(async (dir) => {
		const n = 6;
		const ids = await Promise.all(
			Array.from({ length: n }, (_, i) =>
				(async () => {
					const handle = expectCreated(await begin(dir, { toolCallId: `${CALL}_p${i}` }));
					expectFinalized(await finalizeReceipt({ projectRoot: dir, handle, status: "success", content: `done ${i}` }));
					return handle.id;
				})(),
			),
		);
		assert.equal(new Set(ids).size, n);
		for (const id of ids) {
			const rec = expectCompleted(await recoverReceipt({ projectRoot: dir, id }));
			assert.equal(rec.id, id);
		}
	});
});

test("parallel same-id begins yield exactly one created and fail-closed replays", async () => {
	await withTempDir(async (dir) => {
		const outcomes = await Promise.all(Array.from({ length: 6 }, () => begin(dir)));
		const created = outcomes.filter((o): o is Extract<BeginOutcome, { ok: true; kind: "created" }> => o.ok && o.kind === "created");
		assert.equal(created.length, 1);
		for (const o of outcomes) {
			if (o.ok) continue;
			// Racing losers re-classify the winner's started phase.
			assert.ok(o.kind === "incomplete_replay" || o.kind === "completed_replay", `unexpected loser outcome ${o.kind}`);
		}
		const winner = created[0];
		assert.ok(winner, "exactly one created expected");
		expectFinalized(await finalizeReceipt({ projectRoot: dir, handle: winner.handle, status: "success", content: "won" }));
		const rec = expectCompleted(await recoverReceipt({ projectRoot: dir, id: winner.handle.id }));
		assert.equal(rec.summary, "won");
	});
});

// ---------------------------------------------------------------------------
// Read-only recovery
// ---------------------------------------------------------------------------

test("repeated recover changes no bytes and no mtimes", async () => {
	await withTempDir(async (dir) => {
		const h = await createCompleted(dir, {}, "stable");
		const startedPath = startedPathFor(dir, h.id);
		const finalizedPath = finalizedPathFor(dir, h.id);
		const snapshot = async () => ({
			startedBytes: await readFile(startedPath),
			finalizedBytes: await readFile(finalizedPath),
			startedMtime: (await stat(startedPath)).mtimeMs,
			finalizedMtime: (await stat(finalizedPath)).mtimeMs,
		});
		const before = await snapshot();
		expectCompleted(await recoverReceipt({ projectRoot: dir, id: h.id }));
		expectCompleted(await recoverReceipt({ projectRoot: dir, sessionIdentity: SESSION, toolCallId: CALL }));
		expectCompleted(await recoverReceipt({ projectRoot: dir, id: h.id }));
		assert.deepEqual(await snapshot(), before);
	});
});

// ---------------------------------------------------------------------------
// Recovery precedence
// ---------------------------------------------------------------------------

test("recover prefers an explicit id over identity derivation (exact-one choice is a P8b runtime rule)", async () => {
	await withTempDir(async (dir) => {
		const h = await createCompleted(dir, {}, "precedence");
		// Both id and identity given: the id wins, so a different valid id
		// resolves to missing even though the identity derivation exists.
		const other = await recoverReceipt({ projectRoot: dir, id: OTHER_ID, sessionIdentity: SESSION, toolCallId: CALL });
		assert.equal(other.ok, false);
		if (!other.ok) assert.equal(other.kind, "missing");
		// The correct id resolves to the completed receipt.
		const exact = await recoverReceipt({ projectRoot: dir, id: h.id, sessionIdentity: SESSION, toolCallId: CALL });
		assert.equal(exact.ok, true);
		if (exact.ok) assert.equal(exact.receipt.id, h.id);
		// Identity derivation alone also works.
		const derived = await recoverReceipt({ projectRoot: dir, sessionIdentity: SESSION, toolCallId: CALL });
		assert.equal(derived.ok, true);
		if (derived.ok) assert.equal(derived.receipt.id, h.id);
		// Neither id nor identity: invalid.
		const none = await recoverReceipt({ projectRoot: dir });
		assert.equal(none.ok, false);
		if (!none.ok) assert.equal(none.kind, "invalid");
		// Malformed ids and identities: invalid.
		for (const id of ["wtr1-xyz", "../etc/passwd", `wtr1-${"g".repeat(64)}`, ""]) {
			const bad = await recoverReceipt({ projectRoot: dir, id });
			assert.equal(bad.ok, false);
			if (!bad.ok) assert.equal(bad.kind, "invalid");
		}
		const badIdentity = await recoverReceipt({ projectRoot: dir, sessionIdentity: "a\nb", toolCallId: CALL });
		assert.equal(badIdentity.ok, false);
		if (!badIdentity.ok) assert.equal(badIdentity.kind, "invalid");
	});
});

// ---------------------------------------------------------------------------
// Bounded renderer + path helpers
// ---------------------------------------------------------------------------

test("renderReceiptRecovery is bounded, project-relative, never absolute, with the fixed disclaimer", async () => {
	await withTempDir(async (dir) => {
		const h = await createCompleted(dir, {}, "render me");
		const rec = expectCompleted(await recoverReceipt({ projectRoot: dir, id: h.id }));
		const text = renderReceiptRecovery(dir, rec);
		assert.ok(text.startsWith("tool-result receipt (schema wtr1)"));
		assert.ok(text.includes(`receipt path: .pi/workbench/tool-results/${h.id}.json`));
		assert.ok(text.includes(RECEIPT_DISCLAIMER));
		assert.ok(!text.includes(resolve(dir)), "renderer must never emit an absolute project root");
		assert.ok(utf8ByteLength(text) <= RENDER_MAX_BYTES);
		assert.ok(text.split("\n").length <= RENDER_MAX_LINES);
		// A 20-line summary still renders within the global caps.
		const h2 = await createCompleted(dir, { toolCallId: `${CALL}-lines` }, Array(20).fill("line of summary").join("\n"));
		const rec2 = expectCompleted(await recoverReceipt({ projectRoot: dir, id: h2.id }));
		const text2 = renderReceiptRecovery(dir, rec2);
		assert.ok(utf8ByteLength(text2) <= RENDER_MAX_BYTES);
		assert.ok(text2.split("\n").length <= RENDER_MAX_LINES);
	});
});

test("exported path helpers validate ids and roots before building any path", async () => {
	await withTempDir(async (dir) => {
		for (const id of ["../../etc/passwd", "wtr1-xyz", `wtr1-${"g".repeat(64)}`, "../escape", `wtr1-${"A".repeat(64)}`, ""]) {
			assert.throws(() => startedPathFor(dir, id), RangeError, `startedPathFor ${id}`);
			assert.throws(() => finalizedPathFor(dir, id), RangeError, `finalizedPathFor ${id}`);
			assert.throws(() => receiptRelativePath(dir, id), RangeError, `receiptRelativePath ${id}`);
		}
		assert.throws(() => toolResultsDir(""), RangeError);
		const h = await createCompleted(dir);
		assert.equal(receiptRelativePath(dir, h.id), `.pi/workbench/tool-results/${h.id}.json`);
	});
});

// ---------------------------------------------------------------------------
// End-to-end parser acceptance of the core's own output
// ---------------------------------------------------------------------------

test("the core's own bounded output is always accepted by its strict parser", async () => {
	await withTempDir(async (dir) => {
		const nasty = [
			"line with \u0000 NUL and \u001f unit-sep and \u007f DEL",
			"unicode: héllo 🚀 中文 café",
			`env secret: ${SECRET}`,
			`token: ${TOKEN}`,
			"marker-like suffix",
			"[truncated]",
			...Array(20).fill("filler line " + "z".repeat(90)),
		].join("\n");
		const h = expectCreated(await begin(dir));
		expectFinalized(
			await finalizeReceipt({ projectRoot: dir, handle: h, status: "error", content: nasty, error: nasty, secrets: [SECRET] }),
		);
		const startedParsed = parseStartedArtifact(await readFile(startedPathFor(dir, h.id), "utf8"), h.id);
		assert.equal(startedParsed.ok, true);
		const finalizedParsed = parseFinalizedArtifact(await readFile(finalizedPathFor(dir, h.id), "utf8"), h.id);
		assert.equal(finalizedParsed.ok, true);
		const rec = expectCompleted(await recoverReceipt({ projectRoot: dir, id: h.id }));
		assert.ok(!rec.summary.includes(SECRET));
		assert.ok(!rec.summary.includes(TOKEN));
		assert.ok(!FORBIDDEN_CONTROL_RE.test(rec.summary));
		assert.ok(!(await readFile(finalizedPathFor(dir, h.id), "utf8")).includes(SECRET));
		const text = renderReceiptRecovery(dir, rec);
		assert.ok(utf8ByteLength(text) <= RENDER_MAX_BYTES);
		assert.ok(text.split("\n").length <= RENDER_MAX_LINES);
	});
});
