import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
	evaluatePlanGateCoverage,
	MAX_PLAN_FILE_BYTES,
	normalizePlanReference,
	parsePlanReference,
	planReferenceHash,
	requiredPlanGateIds,
	verifyCurrentPlanReference,
} from "../extensions/workbench-runtime/core/plan-reference.ts";

const HASH = "a".repeat(64);

function reference(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: "workbench-plan-ref-v1",
		plan_id: "pi-framework-reliability-2026-08-23",
		version: "1.0",
		plan_path: "docs/plans/pi-framework-reliability-optimization.md",
		plan_sha256: HASH,
		candidate: "CURRENT_WORKTREE",
		status: "IN_PROGRESS",
		criteria: [
			{ id: "C1", gate_id: "b1", check_ids: ["b1.1"], evidence_paths: ["tests/gates.test.ts"] },
			{ id: "C2", gate_id: "b2", check_ids: [], evidence_paths: [] },
		],
		next_action: "run the current-tree final selector",
		...overrides,
	};
}

test("plan references parse strictly and have a stable privacy-safe identity", () => {
	const parsed = parsePlanReference(reference());
	assert.ok(parsed);
	assert.deepEqual(requiredPlanGateIds(parsed), ["b1", "b2"]);
	const initialHash = planReferenceHash(parsed);
	assert.match(initialHash ?? "", /^[0-9a-f]{64}$/);
	assert.notEqual(planReferenceHash({ ...parsed, next_action: "different" }), initialHash);
});

test("public plan references normalize order but reject unmapped or unsafe criteria", () => {
	const normalized = normalizePlanReference(reference({
		plan_id: "  pi-framework-reliability-2026-08-23 ",
		criteria: [
			{ id: "C2", gate_id: "b2", check_ids: [], evidence_paths: [] },
			{ id: "C1", gate_id: "b1", check_ids: ["b1.2", "b1.1"], evidence_paths: ["tests/z.ts", "tests/a.ts"] },
		],
	}));
	assert.ok(normalized);
	assert.deepEqual(normalized.criteria.map((criterion) => criterion.id), ["C1", "C2"]);
	assert.deepEqual(normalized.criteria[0]?.check_ids, ["b1.1", "b1.2"]);
	assert.equal(normalizePlanReference(reference({ plan_path: "../outside.md" })), undefined);
	assert.equal(normalizePlanReference(reference({ criteria: [{ id: "C1", gate_id: "UNMAPPED", check_ids: [], evidence_paths: [] }] })), undefined);
	assert.equal(parsePlanReference({ ...reference(), extra: true }), undefined);
	assert.equal(normalizePlanReference(new Proxy(reference(), {})), undefined);
	assert.equal(normalizePlanReference(reference({ criteria: [new Proxy({ id: "C1", gate_id: "b1", check_ids: [], evidence_paths: [] }, {})] })), undefined);
});

test("current plan references bind bounded contained bytes and reject drift or symlink escape", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "plan-reference-root-"));
	const outside = await mkdtemp(join(tmpdir(), "plan-reference-outside-"));
	t.after(async () => {
		await Promise.all([
			rm(root, { recursive: true, force: true }),
			rm(outside, { recursive: true, force: true }),
		]);
	});
	const relative = "docs/plans/current.md";
	const path = join(root, relative);
	await mkdir(dirname(path), { recursive: true });
	const initial = Buffer.from("# Current plan\n\nBounded evidence.\n", "utf8");
	await writeFile(path, initial);
	const valid = reference({
		plan_path: relative,
		plan_sha256: createHash("sha256").update(initial).digest("hex"),
	});
	const verified = await verifyCurrentPlanReference(root, valid);
	assert.equal(verified.ok, true, verified.ok ? "" : verified.error.code);

	await writeFile(path, "# Drifted plan\n");
	const drifted = await verifyCurrentPlanReference(root, valid);
	assert.equal(drifted.ok, false);
	if (!drifted.ok) assert.equal(drifted.error.code, "digest_mismatch");

	await writeFile(path, Buffer.alloc(MAX_PLAN_FILE_BYTES + 1, 0x61));
	const oversized = await verifyCurrentPlanReference(root, valid);
	assert.equal(oversized.ok, false);
	if (!oversized.ok) assert.equal(oversized.error.code, "too_large");

	const outsidePath = join(outside, "plan.md");
	await writeFile(outsidePath, "outside\n");
	const link = join(root, "docs", "plans", "outside.md");
	await symlink(outsidePath, link);
	const escaped = await verifyCurrentPlanReference(root, reference({
		plan_path: "docs/plans/outside.md",
		plan_sha256: createHash("sha256").update("outside\n").digest("hex"),
	}));
	assert.equal(escaped.ok, false);
	if (!escaped.ok) assert.equal(escaped.error.code, "unsafe_path");
});

test("plan Gate coverage is necessary-only and never upgrades a result", () => {
	assert.deepEqual(evaluatePlanGateCoverage(reference(), { b1: "PASS" }), {
		requiredGateIds: ["b1", "b2"],
		missingGateIds: ["b2"],
		nonPassGateIds: [],
		covered: false,
	});
	assert.deepEqual(evaluatePlanGateCoverage(reference(), { b1: "PASS", b2: "FAIL" }), {
		requiredGateIds: ["b1", "b2"],
		missingGateIds: [],
		nonPassGateIds: ["b2"],
		covered: false,
	});
	assert.equal(evaluatePlanGateCoverage(reference(), { b1: "PASS", b2: "PASS" }).covered, true);
	assert.equal(evaluatePlanGateCoverage(undefined, {}).covered, false, "absence never fabricates coverage");
});
