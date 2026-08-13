import assert from "node:assert/strict";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import type { Gate } from "../extensions/workbench-runtime/core/gate-schema.ts";
import { decodeContinuationCursor } from "../extensions/workbench-runtime/core/continuation-cursor.ts";
import {
	GATE_READ_MAX_BYTES,
	GATE_EVIDENCE_OUTPUT_MAX_BYTES,
	GATE_EVIDENCE_OUTPUT_MAX_LINES,
	GATE_EVIDENCE_RECORD_MAX_BYTES,
	GATE_RECORD_MAX_BYTES,
	readGateEvidenceView,
	readGateFileRecordWithReason,
	readGateRunPage,
	renderGateDefinitionPage,
} from "../extensions/workbench-runtime/core/report.ts";
import { withTempDir } from "./helpers.ts";

const RUN_ID = "20260813-120000-gate";

function gateRecord(count = 500): Record<string, unknown> {
	return {
		schema_version: 1,
		run_id: RUN_ID,
		requested: ["all"],
		profile: "generic",
		mode: "VERIFY",
		gates: Array.from({ length: count }, (_, index) => {
			const failed = index % 5 === 0;
			return {
				id: `g${index}`,
				title: `title-${index}-${"界".repeat(100)}`,
				status: failed ? "FAIL" : "PASS",
				failure_reason: failed ? `reason-${index}-${"坏".repeat(100)}` : null,
				blocked_reason: null,
				checks: [{
					check_id: `g${index}.1`,
					status: failed ? "FAIL" : "PASS",
					kind: "config",
					failure_reason: failed ? `check-${index}-${"错".repeat(100)}` : null,
					blocked_reason: null,
				}],
			};
		}),
	};
}

async function writeGateRecord(root: string, runId: string, value: unknown): Promise<string> {
	const path = join(root, CONFIG_DIR_NAME, "workbench", "runs", runId, "gates.json");
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, JSON.stringify(value), "utf8");
	return path;
}

function evidenceRecord(runId: string, detail = "reviewed"): Record<string, unknown> {
	return {
		schema_version: 1,
		run_id: runId,
		requested: ["all"],
		profile: "generic",
		mode: "VERIFY",
		checks: {
			"g1.1": {
				check_id: "g1.1",
				status: "PASS",
				kind: "manual",
				evidence: [{ type: "manual", detail }],
			},
		},
	};
}

async function writeEvidenceRecord(root: string, runId: string, value: unknown): Promise<string> {
	const path = join(root, CONFIG_DIR_NAME, "workbench", "runs", runId, "evidence.json");
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, JSON.stringify(value), "utf8");
	return path;
}

test("gate record reads fail closed for oversized, corrupt, and non-regular sources", async () => {
	await withTempDir(async (root) => {
		const oversized = "20260813-120001-over";
		const oversizedPath = join(root, CONFIG_DIR_NAME, "workbench", "runs", oversized, "gates.json");
		await mkdir(join(oversizedPath, ".."), { recursive: true });
		await writeFile(oversizedPath, "x".repeat(GATE_RECORD_MAX_BYTES + 1), "utf8");
		const oversizedRead = await readGateFileRecordWithReason(root, oversized);
		assert.deepEqual(oversizedRead, { ok: false, code: "source_oversized", reason: "gate record unavailable: source_oversized" });

		const corrupt = "20260813-120002-bad0";
		const corruptPath = join(root, CONFIG_DIR_NAME, "workbench", "runs", corrupt, "gates.json");
		await mkdir(join(corruptPath, ".."), { recursive: true });
		await writeFile(corruptPath, "{not-json", "utf8");
		const corruptRead = await readGateFileRecordWithReason(root, corrupt);
		assert.deepEqual(corruptRead, { ok: false, code: "invalid_record", reason: "gate record unavailable: invalid_record" });

		const nonRegular = "20260813-120003-dir0";
		await mkdir(join(root, CONFIG_DIR_NAME, "workbench", "runs", nonRegular, "gates.json"), { recursive: true });
		const nonRegularRead = await readGateFileRecordWithReason(root, nonRegular);
		assert.deepEqual(nonRegularRead, { ok: false, code: "source_not_regular", reason: "gate record unavailable: source_not_regular" });
	});
});

test("gate evidence view is strict, same-open bounded, and clamps a hostile valid record as a whole", async () => {
	await withTempDir(async (root) => {
		const path = await writeEvidenceRecord(root, RUN_ID, evidenceRecord(RUN_ID, "界".repeat(200_000)));
		const normal = await readGateEvidenceView(root, RUN_ID);
		assert.equal(normal.ok, true);
		assert.ok(Buffer.byteLength(normal.text, "utf8") <= GATE_EVIDENCE_OUTPUT_MAX_BYTES);
		assert.ok(normal.text.split("\n").length <= GATE_EVIDENCE_OUTPUT_MAX_LINES);
		assert.match(normal.text, /full record: .*evidence\.json/);
		assert.match(normal.text, /display: shown=1 omitted=0/);

		await writeFile(path, "x".repeat(GATE_EVIDENCE_RECORD_MAX_BYTES + 1), "utf8");
		const oversizedAllocations: number[] = [];
		const oversized = await readGateEvidenceView(root, RUN_ID, { onBufferAllocate: (bytes) => oversizedAllocations.push(bytes) });
		assert.deepEqual(oversizedAllocations, [], "oversized evidence is rejected before Buffer allocation");
		assert.equal(oversized.ok, false);
		if (!oversized.ok) assert.equal(oversized.code, "source_oversized");

		await rm(path);
		await mkdir(path);
		const nonRegularAllocations: number[] = [];
		const nonRegular = await readGateEvidenceView(root, RUN_ID, { onBufferAllocate: (bytes) => nonRegularAllocations.push(bytes) });
		assert.deepEqual(nonRegularAllocations, [], "non-regular evidence is rejected before Buffer allocation");
		assert.equal(nonRegular.ok, false);
		if (!nonRegular.ok) assert.equal(nonRegular.code, "source_not_regular");

		await rm(path, { recursive: true });
		await writeFile(path, "{not-json", "utf8");
		const corrupt = await readGateEvidenceView(root, RUN_ID);
		assert.equal(corrupt.ok, false);
		if (!corrupt.ok) assert.equal(corrupt.code, "invalid_record");
		assert.ok(Buffer.byteLength(corrupt.text, "utf8") <= GATE_EVIDENCE_OUTPUT_MAX_BYTES);
	});
});

test("500-gate/check records page without loss and reject replay against changed or different sources", async () => {
	await withTempDir(async (root) => {
		const record = gateRecord();
		const path = await writeGateRecord(root, RUN_ID, record);
		const allocation = 4_096;
		const rowKeys = (text: string): string[] => text.split("\n").flatMap((line) => {
			const gate = /^gate (g\d+) (?:PASS|FAIL|BLOCKED|NOT_RUN) /.exec(line);
			if (gate) return [`gate:${gate[1]}`];
			const check = /^check (g\d+\/g\d+\.1) (?:PASS|FAIL|BLOCKED|NOT_RUN) /.exec(line);
			return check ? [`check:${check[1]}`] : [];
		});
		const expectedRows = Array.from({ length: 500 }, (_, index) => [
			`gate:g${index}`,
			`check:g${index}/g${index}.1`,
		]).flat();
		const first = await readGateRunPage({ projectRoot: root, runId: RUN_ID, include: "checks", maxBytes: allocation, maxLines: 20 });
		assert.equal(first.ok, true);
		if (!first.ok) return;
		assert.ok(Buffer.byteLength(first.text, "utf8") <= allocation);
		assert.ok(first.text.split("\n").length <= 20);
		assert.equal(first.details.source_path, `.pi/workbench/runs/${RUN_ID}/gates.json`);
		const firstCursor = first.details.next_cursor;
		assert.ok(firstCursor?.startsWith("wbcur2."));
		const decoded = decodeContinuationCursor(firstCursor);
		if (!decoded.ok) assert.fail(`cursor decode failed: ${decoded.error.code}`);
		assert.equal(decoded.ok, true);
		if (decoded.value.kind === "run-log") assert.fail("gate file cursor decoded as run-log");
		assert.equal(decoded.value.kind, "gate-read");
		assert.equal(decoded.value.v, 2);
		if (decoded.value.v !== 2) assert.fail("real gate file did not mint a v2 cursor");
		assert.equal(decoded.value.mtimeNs, (await stat(path, { bigint: true })).mtimeNs.toString());
		const repeated = await readGateRunPage({ projectRoot: root, runId: RUN_ID, include: "checks", cursor: first.details.next_cursor, maxBytes: allocation, maxLines: 20 });
		const repeatedAgain = await readGateRunPage({ projectRoot: root, runId: RUN_ID, include: "checks", cursor: first.details.next_cursor, maxBytes: allocation, maxLines: 20 });
		assert.deepEqual(repeatedAgain, repeated, "replaying the same cursor is deterministic");

		const replay = await readGateRunPage({ projectRoot: root, runId: RUN_ID, include: "failures", cursor: first.details.next_cursor });
		assert.equal(replay.ok, false);
		if (!replay.ok) assert.equal(replay.code, "source_mismatch");

		let shown = first.details.shown_count;
		const reconstructed = rowKeys(first.text);
		assert.equal(reconstructed.length, first.details.shown_count, "cursor count advances only past complete rows in exact allocation");
		let cursor = first.details.next_cursor;
		let remaining = first.details.remaining_count;
		while (cursor) {
			const page = await readGateRunPage({ projectRoot: root, runId: RUN_ID, include: "checks", cursor, maxBytes: allocation, maxLines: 320 });
			assert.equal(page.ok, true);
			if (!page.ok) break;
			assert.ok(Buffer.byteLength(page.text, "utf8") <= allocation);
			assert.ok(page.text.split("\n").length <= 320);
			const keys = rowKeys(page.text);
			assert.equal(keys.length, page.details.shown_count, "every cursor offset is the number of fully visible semantic rows");
			reconstructed.push(...keys);
			shown += page.details.shown_count;
			remaining = page.details.remaining_count;
			cursor = page.details.next_cursor;
		}
		assert.equal(shown, 1_000, "every gate and every check is returned exactly once");
		assert.equal(remaining, 0);
		assert.deepEqual(reconstructed, expectedRows, "small-allocation cursor chain reconstructs all rows in order with no skips or duplicates");

		await writeFile(path, `${JSON.stringify(record)} `, "utf8");
		const stale = await readGateRunPage({ projectRoot: root, runId: RUN_ID, include: "checks", cursor: first.details.next_cursor });
		assert.equal(stale.ok, false);
		if (!stale.ok) assert.equal(stale.code, "stale_cursor");
	});
});

test("500-check gate definitions use the same bounded, strict cursor protocol", () => {
	const gate: Gate = {
		id: "g500",
		title: `large ${"界".repeat(2_000)}`,
		description: "definition",
		profiles: [],
		prerequisites: [],
		required: true,
		blocking: true,
		evidence: [],
		acceptance: "all checks pass",
		source: "project",
		checks: Array.from({ length: 500 }, (_, index) => ({
			id: `g500.${index}`,
			title: `check-${index}-${"测".repeat(300)}`,
			description: "",
			required: true,
			blocking: true,
			kind: "config" as const,
		})),
	};
	const allocation = 4_096;
	const expected = gate.checks.map((check) => check.id);
	const rowIds = (text: string): string[] => text.split("\n").flatMap((line) => {
		const matched = /^check (g500\.\d+) kind=/.exec(line);
		return matched ? [matched[1]!] : [];
	});
	const first = renderGateDefinitionPage({ gate, include: "checks", maxBytes: allocation, maxLines: 20 });
	assert.equal(first.ok, true);
	if (!first.ok) return;
	assert.ok(Buffer.byteLength(first.text, "utf8") <= allocation);
	assert.ok(first.text.split("\n").length <= 20);
	assert.equal(first.details.source_path, ".pi/workbench/gates.yaml + builtin ladder");
	if (!first.details.next_cursor) assert.fail("the first bounded definition page must provide a continuation cursor");
	const reconstructed = rowIds(first.text);
	assert.equal(reconstructed.length, first.details.shown_count);
	let cursor: string | undefined = first.details.next_cursor;
	while (cursor) {
		const page = renderGateDefinitionPage({ gate, include: "checks", cursor, maxBytes: allocation, maxLines: 320 });
		assert.equal(page.ok, true);
		if (!page.ok) break;
		assert.ok(Buffer.byteLength(page.text, "utf8") <= allocation);
		const rows = rowIds(page.text);
		assert.equal(rows.length, page.details.shown_count);
		reconstructed.push(...rows);
		cursor = page.details.next_cursor;
	}
	assert.deepEqual(reconstructed, expected, "small-allocation definition cursor chain has no skipped or repeated check rows");
	const mismatched = renderGateDefinitionPage({ gate, include: "summary", cursor: first.details.next_cursor });
	assert.equal(mismatched.ok, false);
	if (!mismatched.ok) assert.equal(mismatched.code, "source_mismatch");
});
