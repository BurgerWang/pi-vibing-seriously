/**
 * Quant result contract tests (P3).
 *
 * The workbench never computes strategy metrics — it validates the target
 * project's declared output. Covers: required fields, finiteness (NaN /
 * Infinity via 1e999), fold reporting (failed folds are never filtered),
 * duplicate/empty folds, risk-adjusted metric alternatives, and
 * profile-specific optional fields.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { validateQuantResult } from "../extensions/workbench-runtime/core/quant-result.ts";
import { makeValidQuantResult } from "./helpers.ts";

test("a conforming quant-result artifact validates", () => {
	const result = validateQuantResult(makeValidQuantResult());
	assert.equal(result.valid, true);
	assert.deepEqual(result.errors, []);
	assert.ok(result.checked.includes("metrics.return"));
	assert.ok(result.checked.includes("folds.length"));
});

test("missing required top-level fields fail validation", () => {
	const artifact = makeValidQuantResult();
	delete artifact.benchmark;
	const result = validateQuantResult(artifact);
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.includes("benchmark")), `errors: ${result.errors.join("; ")}`);
});

test("missing required metric fields fail validation", () => {
	const artifact = makeValidQuantResult();
	delete (artifact.metrics as Record<string, unknown>).turnover;
	const result = validateQuantResult(artifact);
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.includes("metrics.turnover")));
});

test("a risk-adjusted alternative to sharpe is accepted", () => {
	const artifact = makeValidQuantResult();
	const metrics = artifact.metrics as Record<string, unknown>;
	delete metrics.sharpe;
	metrics.sortino = 1.1;
	assert.equal(validateQuantResult(artifact).valid, true);

	delete metrics.sortino;
	const none = validateQuantResult(artifact);
	assert.equal(none.valid, false);
	assert.ok(none.errors.some((e) => e.includes("risk-adjusted")));
});

test("non-finite numbers fail validation (Infinity via 1e999)", () => {
	const artifact = makeValidQuantResult();
	(artifact.metrics as Record<string, unknown>).return = 1e999; // parses to Infinity
	const result = validateQuantResult(artifact);
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.includes("metrics.return") && e.includes("finite")));

	(artifact.metrics as Record<string, unknown>).return = "NaN";
	assert.equal(validateQuantResult(artifact).valid, false);
});

test("failed folds are reported, never filtered", () => {
	const artifact = makeValidQuantResult({
		folds: [
			{ id: "f1", status: "failed", period: { start: "2015-01-01", end: "2017-12-31" } },
			{ id: "f2", status: "passed", period: { start: "2018-01-01", end: "2020-12-31" }, metrics: { return: 0.11, sharpe: 0.75 } },
		],
	});
	const result = validateQuantResult(artifact);
	assert.equal(result.valid, true, result.errors.join("; "));
	assert.deepEqual(result.failed_folds, ["f1"], "the failed fold must appear in failed_folds");
	assert.deepEqual(result.fold_statuses, { f1: "failed", f2: "passed" }, "every fold is recorded, including failed ones");
});

test("a passed fold without metrics fails validation", () => {
	const artifact = makeValidQuantResult({
		folds: [{ id: "f1", status: "passed" }],
	});
	const result = validateQuantResult(artifact);
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.includes("folds[0].metrics")));
});

test("duplicate fold ids and empty folds fail validation", () => {
	const dup = makeValidQuantResult({
		folds: [
			{ id: "f1", status: "failed" },
			{ id: "f1", status: "failed" },
		],
	});
	assert.ok(!validateQuantResult(dup).valid);

	const empty = makeValidQuantResult({ folds: [] });
	const result = validateQuantResult(empty);
	assert.ok(!result.valid);
	assert.ok(result.errors.some((e) => e.includes("folds")));
});

test("unknown fold statuses fail validation", () => {
	const artifact = makeValidQuantResult({ folds: [{ id: "f1", status: "best" }] });
	assert.equal(validateQuantResult(artifact).valid, false);
});

test("split method is restricted to declared methods", () => {
	const artifact = makeValidQuantResult({ split: { method: "guess" } });
	assert.equal(validateQuantResult(artifact).valid, false);
});

test("profile-specific optional fields are validated when present (stock-selection)", () => {
	const artifact = makeValidQuantResult();
	(artifact.universe as Record<string, unknown>).point_in_time = "yes"; // must be boolean or object
	const result = validateQuantResult(artifact, { profile: "quant-research/stock-selection" });
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.includes("point_in_time")));

	(artifact.universe as Record<string, unknown>).point_in_time = true;
	artifact.exposure = { industry: 0.4, market_cap: 0.3 };
	assert.equal(validateQuantResult(artifact, { profile: "quant-research/stock-selection" }).valid, true);

	// Not required for other profiles.
	const plain = validateQuantResult(makeValidQuantResult(), { profile: "generic" });
	assert.equal(plain.valid, true);
});

test("profile-specific optional fields are validated when present (market-timing)", () => {
	const artifact = makeValidQuantResult({
		regime: { states: ["bull", "bear"] },
		position_sizing: { method: "risk-parity", max_position: 0.5 },
	});
	assert.equal(validateQuantResult(artifact, { profile: "quant-research/market-timing" }).valid, true);

	const bad = makeValidQuantResult({ position_sizing: { method: "risk-parity", max_position: "large" } });
	assert.equal(validateQuantResult(bad, { profile: "quant-research/market-timing" }).valid, false);
});

test("root must be a JSON object", () => {
	assert.equal(validateQuantResult([1, 2, 3]).valid, false);
	assert.equal(validateQuantResult("result").valid, false);
	assert.equal(validateQuantResult(null).valid, false);
});
