/**
 * Pinned worker cumulative delegation-spend policy tests (pure module —
 * Phase 1 of the approved worker token-budget repair; policy only, NOT
 * wired into the runtime).
 *
 * Covers: the exact immutable profile constants (all 18 numbers), profile
 * selection (strict validation vs. standard default), per-message total
 * normalization (reused `workerContextTokens` semantics) and independent
 * output extraction, immutable cumulative accumulation, malformed
 * counters/usage (never NaN, never a throw), the `>=` boundary matrix for
 * every soft/hard dimension of every profile, hard-over-soft precedence,
 * the fixed reason order `turns`, `total_tokens`, `output_tokens`, the
 * deterministic steer/hard-stop/summary formatters, and the hard-coded
 * 17-record audit replay of the confirmed SCALPER baseline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	EMPTY_WORKER_SPEND_STATE,
	WORKER_SPEND_DEFAULT_PROFILE,
	WORKER_SPEND_LIMITS,
	WORKER_SPEND_POLICY_ID,
	WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE,
	addWorkerSpendUsage,
	formatWorkerSpendHardStop,
	formatWorkerSpendSteerText,
	formatWorkerSpendSummary,
	isWorkerSpendProfile,
	normalizeWorkerSpendState,
	resolveWorkerSpendProfile,
	workerSpendBand,
	workerSpendDimensionFlags,
	workerSpendOutputTokens,
	workerSpendReasons,
} from "../extensions/workbench-runtime/core/worker-spend.ts";
import type { WorkerSpendProfile, WorkerSpendState } from "../extensions/workbench-runtime/core/worker-spend.ts";

const PROFILES: WorkerSpendProfile[] = ["low", "standard", "extended"];

test("spend profile constants: all 18 numbers exact, immutable, ordered", () => {
	// Exact approved limits (plan §4.3) — six numbers per profile.
	assert.deepEqual(WORKER_SPEND_LIMITS.low, {
		soft: { turns: 8, totalTokens: 816_000, outputTokens: 50_000 },
		hard: { turns: 16, totalTokens: 1_632_000, outputTokens: 100_000 },
	});
	assert.deepEqual(WORKER_SPEND_LIMITS.standard, {
		soft: { turns: 32, totalTokens: 5_440_000, outputTokens: 160_000 },
		hard: { turns: 64, totalTokens: 10_880_000, outputTokens: 320_000 },
	});
	assert.deepEqual(WORKER_SPEND_LIMITS.extended, {
		soft: { turns: 64, totalTokens: 10_880_000, outputTokens: 320_000 },
		hard: { turns: 96, totalTokens: 17_408_000, outputTokens: 512_000 },
	});

	// Immutable at runtime (frozen at every level).
	assert.ok(Object.isFrozen(WORKER_SPEND_LIMITS));
	for (const profile of PROFILES) {
		assert.ok(Object.isFrozen(WORKER_SPEND_LIMITS[profile]));
		assert.ok(Object.isFrozen(WORKER_SPEND_LIMITS[profile].soft));
		assert.ok(Object.isFrozen(WORKER_SPEND_LIMITS[profile].hard));
	}

	// soft < hard per dimension, low < standard < extended per dimension.
	for (const profile of PROFILES) {
		const limits = WORKER_SPEND_LIMITS[profile];
		assert.ok(limits.soft.turns < limits.hard.turns, `${profile} turns soft < hard`);
		assert.ok(limits.soft.totalTokens < limits.hard.totalTokens, `${profile} total soft < hard`);
		assert.ok(limits.soft.outputTokens < limits.hard.outputTokens, `${profile} output soft < hard`);
	}
	assert.ok(WORKER_SPEND_LIMITS.low.soft.turns < WORKER_SPEND_LIMITS.standard.soft.turns);
	assert.ok(WORKER_SPEND_LIMITS.standard.soft.turns < WORKER_SPEND_LIMITS.extended.soft.turns);
	assert.ok(WORKER_SPEND_LIMITS.low.hard.turns < WORKER_SPEND_LIMITS.standard.hard.turns);
	assert.ok(WORKER_SPEND_LIMITS.standard.hard.turns < WORKER_SPEND_LIMITS.extended.hard.turns);
	assert.ok(WORKER_SPEND_LIMITS.low.soft.totalTokens < WORKER_SPEND_LIMITS.standard.soft.totalTokens);
	assert.ok(WORKER_SPEND_LIMITS.standard.soft.totalTokens < WORKER_SPEND_LIMITS.extended.soft.totalTokens);
	assert.ok(WORKER_SPEND_LIMITS.low.hard.totalTokens < WORKER_SPEND_LIMITS.standard.hard.totalTokens);
	assert.ok(WORKER_SPEND_LIMITS.standard.hard.totalTokens < WORKER_SPEND_LIMITS.extended.hard.totalTokens);
	assert.ok(WORKER_SPEND_LIMITS.low.soft.outputTokens < WORKER_SPEND_LIMITS.standard.soft.outputTokens);
	assert.ok(WORKER_SPEND_LIMITS.standard.soft.outputTokens < WORKER_SPEND_LIMITS.extended.soft.outputTokens);
	assert.ok(WORKER_SPEND_LIMITS.low.hard.outputTokens < WORKER_SPEND_LIMITS.standard.hard.outputTokens);
	assert.ok(WORKER_SPEND_LIMITS.standard.hard.outputTokens < WORKER_SPEND_LIMITS.extended.hard.outputTokens);

	// standard is the exported default; steer message type is pinned.
	assert.equal(WORKER_SPEND_DEFAULT_PROFILE, "standard");
	assert.equal(WORKER_SPEND_POLICY_ID, "gpt-5.6-luna-xhigh-continuation-v1");
	assert.equal(WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE, "workbench-worker-spend-soft-steer");
	assert.deepEqual(EMPTY_WORKER_SPEND_STATE, { turns: 0, totalTokens: 0, outputTokens: 0 });
	assert.ok(Object.isFrozen(EMPTY_WORKER_SPEND_STATE));
});

test("profile selection: strict validation rejects unknown, resolve defaults to standard", () => {
	assert.equal(isWorkerSpendProfile("low"), true);
	assert.equal(isWorkerSpendProfile("standard"), true);
	assert.equal(isWorkerSpendProfile("extended"), true);
	assert.equal(isWorkerSpendProfile(undefined), false);
	assert.equal(isWorkerSpendProfile(null), false);
	assert.equal(isWorkerSpendProfile(""), false);
	assert.equal(isWorkerSpendProfile("LOW"), false);
	assert.equal(isWorkerSpendProfile("Standard"), false);
	assert.equal(isWorkerSpendProfile("premium"), false);
	assert.equal(isWorkerSpendProfile(42), false);
	assert.equal(isWorkerSpendProfile({}), false);

	assert.equal(resolveWorkerSpendProfile("low"), "low");
	assert.equal(resolveWorkerSpendProfile("standard"), "standard");
	assert.equal(resolveWorkerSpendProfile("extended"), "extended");
	assert.equal(resolveWorkerSpendProfile(undefined), "standard");
	assert.equal(resolveWorkerSpendProfile(null), "standard");
	assert.equal(resolveWorkerSpendProfile(""), "standard");
	assert.equal(resolveWorkerSpendProfile("bogus"), "standard");
	assert.equal(resolveWorkerSpendProfile(42), "standard");
});

test("per-message total normalization reuses workerContextTokens semantics", () => {
	// Positive totalTokens is authoritative.
	assert.deepEqual(
		addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, { totalTokens: 123_456, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
		{ turns: 1, totalTokens: 123_456, outputTokens: 2 },
	);
	// 0 / negative / NaN / Infinity / string totalTokens → fallback sum.
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, { totalTokens: 0, input: 100, output: 200, cacheRead: 300, cacheWrite: 400 }), {
		turns: 1,
		totalTokens: 1000,
		outputTokens: 200,
	});
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, { totalTokens: -5, input: 100, output: 200, cacheRead: 300, cacheWrite: 400 }), {
		turns: 1,
		totalTokens: 1000,
		outputTokens: 200,
	});
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, { totalTokens: Number.NaN, input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }), {
		turns: 1,
		totalTokens: 100,
		outputTokens: 20,
	});
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, { totalTokens: Infinity, input: 5 }), { turns: 1, totalTokens: 5, outputTokens: 0 });
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, { totalTokens: "big" }), { turns: 1, totalTokens: 0, outputTokens: 0 });
	// Fallback sums only non-negative finite components; cacheRead counts.
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }), {
		turns: 1,
		totalTokens: 100,
		outputTokens: 20,
	});
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, { input: 10, output: 20 }), { turns: 1, totalTokens: 30, outputTokens: 20 });
	// Negative / NaN / Infinity / string components contribute zero.
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, { input: -10, output: "x", cacheRead: Infinity, cacheWrite: 7 }), {
		turns: 1,
		totalTokens: 7,
		outputTokens: 0,
	});
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, { input: -1, output: -1, cacheRead: -1, cacheWrite: -1 }), {
		turns: 1,
		totalTokens: 0,
		outputTokens: 0,
	});
	// Fractional finite values are accepted.
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, { input: Number.NaN, output: 1.5, cacheRead: 2.5, cacheWrite: 0 }), {
		turns: 1,
		totalTokens: 4,
		outputTokens: 1.5,
	});
	// Empty / malformed / non-object usage contributes zero — never throws.
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, {}), { turns: 1, totalTokens: 0, outputTokens: 0 });
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, null), { turns: 1, totalTokens: 0, outputTokens: 0 });
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, undefined), { turns: 1, totalTokens: 0, outputTokens: 0 });
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, "usage"), { turns: 1, totalTokens: 0, outputTokens: 0 });
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, 42), { turns: 1, totalTokens: 0, outputTokens: 0 });
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, []), { turns: 1, totalTokens: 0, outputTokens: 0 });
});

test("output component: independent non-negative finite extraction, malformed → 0", () => {
	assert.equal(workerSpendOutputTokens({ output: 42 }), 42);
	assert.equal(workerSpendOutputTokens({ output: 0 }), 0);
	assert.equal(workerSpendOutputTokens({ output: -5 }), 0);
	assert.equal(workerSpendOutputTokens({ output: Number.NaN }), 0);
	assert.equal(workerSpendOutputTokens({ output: Infinity }), 0);
	assert.equal(workerSpendOutputTokens({ output: "42" }), 0);
	assert.equal(workerSpendOutputTokens({}), 0);
	assert.equal(workerSpendOutputTokens(null), 0);
	assert.equal(workerSpendOutputTokens(undefined), 0);
	assert.equal(workerSpendOutputTokens("x"), 0);
	assert.equal(workerSpendOutputTokens(42), 0);
	assert.equal(workerSpendOutputTokens([]), 0);
	// Independent of which path the per-message total took.
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, { totalTokens: 5_000_000, output: 42 }), {
		turns: 1,
		totalTokens: 5_000_000,
		outputTokens: 42,
	});
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, { input: 100, output: 42 }), { turns: 1, totalTokens: 142, outputTokens: 42 });
	assert.deepEqual(addWorkerSpendUsage(EMPTY_WORKER_SPEND_STATE, { totalTokens: 10, output: -5 }), { turns: 1, totalTokens: 10, outputTokens: 0 });
});

test("cumulative update is immutable and deterministic", () => {
	const before: WorkerSpendState = { turns: 2, totalTokens: 500, outputTokens: 50 };
	const snapshot = { ...before };
	const next = addWorkerSpendUsage(before, { totalTokens: 100, output: 10 });
	assert.deepEqual(before, snapshot, "input state is never mutated");
	assert.notEqual(next, before, "a new state object is returned");
	assert.deepEqual(next, { turns: 3, totalTokens: 600, outputTokens: 60 });

	// Same inputs always produce the same accumulated state.
	let state: WorkerSpendState = { ...EMPTY_WORKER_SPEND_STATE };
	state = addWorkerSpendUsage(state, { totalTokens: 1000, output: 100 });
	state = addWorkerSpendUsage(state, { totalTokens: 0, input: 5, cacheRead: 10, output: 7 });
	state = addWorkerSpendUsage(state, { totalTokens: 0, input: 0, output: 0 });
	assert.deepEqual(state, { turns: 3, totalTokens: 1022, outputTokens: 107 });
	assert.deepEqual(addWorkerSpendUsage(state, {}), { turns: 4, totalTokens: 1022, outputTokens: 107 });
});

test("malformed counters and usage normalize to zero — never NaN, never a throw", () => {
	assert.deepEqual(addWorkerSpendUsage(null, {}), { turns: 1, totalTokens: 0, outputTokens: 0 });
	assert.deepEqual(addWorkerSpendUsage(undefined, {}), { turns: 1, totalTokens: 0, outputTokens: 0 });
	assert.deepEqual(addWorkerSpendUsage("state", {}), { turns: 1, totalTokens: 0, outputTokens: 0 });
	assert.deepEqual(addWorkerSpendUsage(42, {}), { turns: 1, totalTokens: 0, outputTokens: 0 });
	assert.deepEqual(addWorkerSpendUsage([], {}), { turns: 1, totalTokens: 0, outputTokens: 0 });
	assert.deepEqual(addWorkerSpendUsage({ turns: Number.NaN, totalTokens: -5, outputTokens: "x" }, { totalTokens: 100 }), {
		turns: 1,
		totalTokens: 100,
		outputTokens: 0,
	});
	assert.deepEqual(addWorkerSpendUsage({ turns: Infinity, totalTokens: 10, outputTokens: 10 }, { totalTokens: 5 }), {
		turns: 1,
		totalTokens: 15,
		outputTokens: 10,
	});
	const neverNaN = addWorkerSpendUsage(
		{ turns: Number.NaN, totalTokens: Number.NaN, outputTokens: Number.NaN },
		{ totalTokens: Number.NaN, output: Number.NaN },
	);
	assert.ok(Number.isFinite(neverNaN.turns) && Number.isFinite(neverNaN.totalTokens) && Number.isFinite(neverNaN.outputTokens));

	assert.deepEqual(normalizeWorkerSpendState(null), { turns: 0, totalTokens: 0, outputTokens: 0 });
	assert.deepEqual(normalizeWorkerSpendState({ turns: 3, totalTokens: 100, outputTokens: 10 }), { turns: 3, totalTokens: 100, outputTokens: 10 });
	assert.deepEqual(normalizeWorkerSpendState({ turns: Number.NaN, totalTokens: -1, outputTokens: "x" }), {
		turns: 0,
		totalTokens: 0,
		outputTokens: 0,
	});
	assert.deepEqual(normalizeWorkerSpendState({ turns: 2.5, totalTokens: 0.5, outputTokens: 0 }), { turns: 2.5, totalTokens: 0.5, outputTokens: 0 });
});

test("band evaluation boundary matrix: below/at/above every soft/hard dimension of every profile", () => {
	const dimensions = [
		{ key: "turns" },
		{ key: "totalTokens" },
		{ key: "outputTokens" },
	] as const;
	for (const profile of PROFILES) {
		const limits = WORKER_SPEND_LIMITS[profile];
		for (const dim of dimensions) {
			const soft = limits.soft[dim.key];
			const hard = limits.hard[dim.key];
			const at = (value: number): Record<string, number> => ({ turns: 0, totalTokens: 0, outputTokens: 0, [dim.key]: value });
			assert.equal(workerSpendBand(at(soft - 1), profile), "ok", `${profile} ${dim.key} one below soft`);
			assert.equal(workerSpendBand(at(soft), profile), "soft", `${profile} ${dim.key} exactly at soft`);
			assert.equal(workerSpendBand(at(hard - 1), profile), "soft", `${profile} ${dim.key} one below hard`);
			assert.equal(workerSpendBand(at(hard), profile), "hard", `${profile} ${dim.key} exactly at hard`);
			assert.equal(workerSpendBand(at(hard + 1), profile), "hard", `${profile} ${dim.key} one above hard`);
		}
	}
	// Zero state is ok for every profile; malformed state is ok.
	for (const profile of PROFILES) {
		assert.equal(workerSpendBand(EMPTY_WORKER_SPEND_STATE, profile), "ok");
		assert.equal(workerSpendBand(null, profile), "ok");
		assert.equal(workerSpendBand("state", profile), "ok");
		assert.equal(workerSpendBand([], profile), "ok");
		assert.equal(workerSpendBand({ turns: Number.NaN, totalTokens: -1, outputTokens: Infinity }, profile), "ok");
	}
	// All dimensions at their soft limit → soft; at their hard limit → hard.
	assert.equal(workerSpendBand({ turns: 32, totalTokens: 5_440_000, outputTokens: 160_000 }, "standard"), "soft");
	assert.equal(workerSpendBand({ turns: 64, totalTokens: 10_880_000, outputTokens: 320_000 }, "standard"), "hard");
});

test("band precedence: any hard dimension wins over soft, always", () => {
	// hard+soft mix → hard.
	assert.equal(workerSpendBand({ turns: 70, totalTokens: 100_000, outputTokens: 50_000 }, "standard"), "hard");
	// hard+hard → hard.
	assert.equal(workerSpendBand({ turns: 70, totalTokens: 11_000_000, outputTokens: 0 }, "standard"), "hard");
	// multi-soft → soft.
	assert.equal(workerSpendBand({ turns: 32, totalTokens: 5_440_000, outputTokens: 0 }, "standard"), "soft");
	// output-only soft trigger.
	assert.equal(workerSpendBand({ turns: 0, totalTokens: 0, outputTokens: 160_000 }, "standard"), "soft");
	// total-only hard trigger.
	assert.equal(workerSpendBand({ turns: 0, totalTokens: 10_880_000, outputTokens: 0 }, "standard"), "hard");
	// low profile: turns above soft but below hard.
	assert.equal(workerSpendBand({ turns: 15, totalTokens: 0, outputTokens: 0 }, "low"), "soft");
	assert.equal(workerSpendBand({ turns: 16, totalTokens: 0, outputTokens: 0 }, "low"), "hard");
});

test("reason ordering is always turns, total_tokens, output_tokens", () => {
	assert.deepEqual(workerSpendReasons({ turns: 32, totalTokens: 5_440_000, outputTokens: 160_000 }, "standard"), [
		"turns",
		"total_tokens",
		"output_tokens",
	]);
	// Output-only and total-only triggers.
	assert.deepEqual(workerSpendReasons({ turns: 0, totalTokens: 0, outputTokens: 160_000 }, "standard"), ["output_tokens"]);
	assert.deepEqual(workerSpendReasons({ turns: 0, totalTokens: 5_440_000, outputTokens: 0 }, "standard"), ["total_tokens"]);
	// Turns-only trigger; below-soft state has no reasons.
	assert.deepEqual(workerSpendReasons({ turns: 32, totalTokens: 0, outputTokens: 0 }, "standard"), ["turns"]);
	assert.deepEqual(workerSpendReasons({ turns: 31, totalTokens: 0, outputTokens: 0 }, "standard"), []);
	assert.deepEqual(workerSpendReasons(EMPTY_WORKER_SPEND_STATE, "standard"), []);
	// Hard band lists only the hard-triggered dimensions, in fixed order.
	assert.deepEqual(workerSpendReasons({ turns: 64, totalTokens: 0, outputTokens: 160_000 }, "standard"), ["turns"]);
	assert.deepEqual(workerSpendReasons({ turns: 70, totalTokens: 11_000_000, outputTokens: 330_000 }, "standard"), [
		"turns",
		"total_tokens",
		"output_tokens",
	]);
	assert.deepEqual(workerSpendReasons({ turns: 70, totalTokens: 0, outputTokens: 330_000 }, "standard"), ["turns", "output_tokens"]);
	assert.deepEqual(workerSpendReasons({ turns: 10, totalTokens: 1_700_000, outputTokens: 0 }, "low"), ["total_tokens"]);
});

test("soft steer text is deterministic and names profile, reasons, and current/soft values", () => {
	const steer = formatWorkerSpendSteerText({ turns: 32, totalTokens: 5_440_000, outputTokens: 100_000 }, "standard");
	assert.equal(steer, formatWorkerSpendSteerText({ turns: 32, totalTokens: 5_440_000, outputTokens: 100_000 }, "standard"));
	assert.match(steer, /profile standard/);
	assert.ok(steer.includes("turns 32/32"), "steer names the triggered turn dimension with current/soft values");
	assert.ok(steer.includes("total_tokens 5440000/5440000"), "steer names the triggered total dimension with current/soft values");
	assert.ok(!steer.includes("output_tokens"), "untriggered dimensions are not named");
	assert.match(steer, /continuation reserve/i);
	assert.match(steer, /Stop starting unrelated work/i);
	assert.match(steer, /handoff/i);
	assert.match(steer, /remaining work/i);
	assert.match(steer, /current Sol session/i);
	assert.match(steer, /never ask the user to open a new Sol session/i);
	assert.ok(steer.length < 1000, "steer stays small and bounded");

	// All three dimensions triggered → fixed order in the facts line.
	const steerAll = formatWorkerSpendSteerText({ turns: 32, totalTokens: 5_440_000, outputTokens: 160_000 }, "standard");
	assert.ok(steerAll.includes("turns 32/32, total_tokens 5440000/5440000, output_tokens 160000/160000"));

	// Profile is named per profile; low-profile boundaries render correctly.
	const steerLow = formatWorkerSpendSteerText({ turns: 8, totalTokens: 0, outputTokens: 0 }, "low");
	assert.match(steerLow, /profile low/);
	assert.ok(steerLow.includes("turns 8/8"));
	const steerExtended = formatWorkerSpendSteerText({ turns: 64, totalTokens: 0, outputTokens: 0 }, "extended");
	assert.match(steerExtended, /profile extended/);
	assert.ok(steerExtended.includes("turns 64/64"));

	// Deterministic degenerate form when nothing is at a soft limit.
	assert.equal(
		formatWorkerSpendSteerText({ turns: 10, totalTokens: 100_000, outputTokens: 5_000 }, "standard"),
		formatWorkerSpendSteerText({ turns: 10, totalTokens: 100_000, outputTokens: 5_000 }, "standard"),
	);
	assert.ok(formatWorkerSpendSteerText(EMPTY_WORKER_SPEND_STATE, "standard").includes("no dimension at its soft limit"));
});

test("hard-stop text is deterministic and names winning dimensions with current/hard values", () => {
	const action = " Continue with a bounded follow-up delegation in the current Sol session after reviewing any partial delta; do not request a new Sol session.";
	assert.equal(
		formatWorkerSpendHardStop({ turns: 64, totalTokens: 10_880_000, outputTokens: 0 }, "standard"),
		`Worker cumulative spend hard budget reached (profile standard): turns 64/64, total_tokens 10880000/10880000.${action}`,
	);
	assert.equal(
		formatWorkerSpendHardStop({ turns: 70, totalTokens: 100_000, outputTokens: 330_000 }, "standard"),
		`Worker cumulative spend hard budget reached (profile standard): turns 70/64, output_tokens 330000/320000.${action}`,
	);
	assert.equal(
		formatWorkerSpendHardStop({ turns: 10, totalTokens: 1_700_000, outputTokens: 0 }, "low"),
		`Worker cumulative spend hard budget reached (profile low): total_tokens 1700000/1632000.${action}`,
	);
	assert.equal(
		formatWorkerSpendHardStop({ turns: 96, totalTokens: 17_408_000, outputTokens: 512_000 }, "extended"),
		`Worker cumulative spend hard budget reached (profile extended): turns 96/96, total_tokens 17408000/17408000, output_tokens 512000/512000.${action}`,
	);
	assert.equal(
		formatWorkerSpendHardStop(EMPTY_WORKER_SPEND_STATE, "standard"),
		`Worker cumulative spend hard budget reached (profile standard): no dimension at its hard limit.${action}`,
	);
	// Deterministic: same inputs, same string.
	assert.equal(
		formatWorkerSpendHardStop({ turns: 70, totalTokens: 100_000, outputTokens: 330_000 }, "standard"),
		formatWorkerSpendHardStop({ turns: 70, totalTokens: 100_000, outputTokens: 330_000 }, "standard"),
	);
});

test("hard-stop text derives reasons strictly from hard flags; soft-only states render the degenerate form", () => {
	const action = " Continue with a bounded follow-up delegation in the current Sol session after reviewing any partial delta; do not request a new Sol session.";
	// Soft-only states (at/above soft, below every hard limit) must never
	// reuse soft-band reasons with hard denominators — one dimension at a time.
	assert.equal(
		formatWorkerSpendHardStop({ turns: 40, totalTokens: 0, outputTokens: 0 }, "standard"),
		`Worker cumulative spend hard budget reached (profile standard): no dimension at its hard limit.${action}`,
	);
	assert.equal(
		formatWorkerSpendHardStop({ turns: 0, totalTokens: 8_000_000, outputTokens: 0 }, "standard"),
		`Worker cumulative spend hard budget reached (profile standard): no dimension at its hard limit.${action}`,
	);
	assert.equal(
		formatWorkerSpendHardStop({ turns: 0, totalTokens: 0, outputTokens: 200_000 }, "standard"),
		`Worker cumulative spend hard budget reached (profile standard): no dimension at its hard limit.${action}`,
	);
	// Multiple soft dimensions at once: still no dimension at its hard limit.
	assert.equal(
		formatWorkerSpendHardStop({ turns: 40, totalTokens: 8_000_000, outputTokens: 200_000 }, "standard"),
		`Worker cumulative spend hard budget reached (profile standard): no dimension at its hard limit.${action}`,
	);
	// Exactly at a soft limit (below hard) stays degenerate; other profiles too.
	assert.equal(
		formatWorkerSpendHardStop({ turns: 32, totalTokens: 0, outputTokens: 0 }, "standard"),
		`Worker cumulative spend hard budget reached (profile standard): no dimension at its hard limit.${action}`,
	);
	assert.equal(
		formatWorkerSpendHardStop({ turns: 10, totalTokens: 0, outputTokens: 0 }, "low"),
		`Worker cumulative spend hard budget reached (profile low): no dimension at its hard limit.${action}`,
	);
	assert.equal(
		formatWorkerSpendHardStop({ turns: 80, totalTokens: 0, outputTokens: 0 }, "extended"),
		`Worker cumulative spend hard budget reached (profile extended): no dimension at its hard limit.${action}`,
	);
	// Mixed soft+hard: only the hard-triggered dimension is named, with the
	// hard denominator — never a soft reason with a hard denominator.
	assert.equal(
		formatWorkerSpendHardStop({ turns: 40, totalTokens: 10_880_000, outputTokens: 0 }, "standard"),
		`Worker cumulative spend hard budget reached (profile standard): total_tokens 10880000/10880000.${action}`,
	);
	assert.equal(
		formatWorkerSpendHardStop({ turns: 70, totalTokens: 8_000_000, outputTokens: 200_000 }, "standard"),
		`Worker cumulative spend hard budget reached (profile standard): turns 70/64.${action}`,
	);
	// workerSpendReasons keeps current-band semantics: soft-only states still
	// list their soft reasons there — formatter and band reasons stay distinct.
	assert.deepEqual(workerSpendReasons({ turns: 40, totalTokens: 0, outputTokens: 0 }, "standard"), ["turns"]);
	assert.deepEqual(workerSpendReasons({ turns: 40, totalTokens: 8_000_000, outputTokens: 200_000 }, "standard"), [
		"turns",
		"total_tokens",
		"output_tokens",
	]);
});

test("spend summary formatter is deterministic with hard-limit denominators", () => {
	assert.equal(
		formatWorkerSpendSummary({ turns: 12, totalTokens: 1_500_000, outputTokens: 60_000 }, "standard"),
		"spend budget : turns 12/64 | total 1500000/10880000 | output 60000/320000 | profile standard",
	);
	assert.equal(
		formatWorkerSpendSummary({ turns: 5, totalTokens: 400_000, outputTokens: 20_000 }, "low"),
		"spend budget : turns 5/16 | total 400000/1632000 | output 20000/100000 | profile low",
	);
	assert.equal(
		formatWorkerSpendSummary({ turns: 50, totalTokens: 9_000_000, outputTokens: 250_000 }, "extended"),
		"spend budget : turns 50/96 | total 9000000/17408000 | output 250000/512000 | profile extended",
	);
	assert.equal(
		formatWorkerSpendSummary(EMPTY_WORKER_SPEND_STATE, "standard"),
		"spend budget : turns 0/64 | total 0/10880000 | output 0/320000 | profile standard",
	);
	// Malformed state renders zeros — never NaN, never a throw.
	assert.equal(
		formatWorkerSpendSummary(Number.NaN, "standard"),
		"spend budget : turns 0/64 | total 0/10880000 | output 0/320000 | profile standard",
	);
	assert.equal(
		formatWorkerSpendSummary(null, "low"),
		"spend budget : turns 0/16 | total 0/1632000 | output 0/100000 | profile low",
	);
});

/**
 * Audit replay (plan §6.1): the confirmed 17-record SCALPER baseline,
 * hard-coded as (turns, total_tokens, output_tokens) tuples from each
 * delegation's `usage.json` (verified 2026-08-05; the post-baseline
 * `20260805-085409-m7t4` record is excluded, as is the later
 * `20260805-092032-mwm8`).
 *
 * The historical corpus remains useful as a regression benchmark for the
 * Luna continuation policy: it proves the new standard profile reduces
 * hard stops from the old 10/17 to 7/17 while still stopping every extreme
 * 64-turn/10.88M-token runaway.
 */
const AUDIT_DELEGATIONS: ReadonlyArray<{
	readonly id: string;
	readonly turns: number;
	readonly totalTokens: number;
	readonly outputTokens: number;
}> = [
	{ id: "20260804-180256-t1rd", turns: 109, totalTokens: 19_427_073, outputTokens: 118_877 },
	{ id: "20260804-182145-8wrv", turns: 31, totalTokens: 1_667_988, outputTokens: 22_350 },
	{ id: "20260804-182626-21cf", turns: 13, totalTokens: 789_239, outputTokens: 23_994 },
	{ id: "20260804-182943-0n4y", turns: 11, totalTokens: 481_029, outputTokens: 25_442 },
	{ id: "20260804-183251-7ip9", turns: 9, totalTokens: 329_442, outputTokens: 9_084 },
	{ id: "20260804-183534-0gys", turns: 21, totalTokens: 1_301_910, outputTokens: 34_229 },
	{ id: "20260804-183931-axom", turns: 9, totalTokens: 312_187, outputTokens: 17_793 },
	{ id: "20260804-184225-rk0f", turns: 10, totalTokens: 411_430, outputTokens: 10_603 },
	{ id: "20260804-190302-nulo", turns: 70, totalTokens: 13_676_291, outputTokens: 172_385 },
	{ id: "20260804-194211-2m0s", turns: 56, totalTokens: 7_577_942, outputTokens: 68_379 },
	{ id: "20260804-195733-hyou", turns: 74, totalTokens: 13_836_909, outputTokens: 129_163 },
	{ id: "20260804-201526-zegk", turns: 49, totalTokens: 7_848_377, outputTokens: 154_002 },
	{ id: "20260804-204126-exm6", turns: 92, totalTokens: 33_996_212, outputTokens: 193_852 },
	{ id: "20260804-214758-efnk", turns: 71, totalTokens: 11_977_424, outputTokens: 122_567 },
	{ id: "20260804-221545-1oi4", turns: 95, totalTokens: 20_099_595, outputTokens: 185_279 },
	{ id: "20260804-224356-3jal", turns: 43, totalTokens: 5_199_324, outputTokens: 66_022 },
	{ id: "20260805-073945-agdo", turns: 132, totalTokens: 37_300_941, outputTokens: 177_413 },
];

test("historical 17-record replay demonstrates the Luna continuation reserve without removing runaway ceilings", () => {
	// The tuples are exactly the 17 baseline records; m7t4 and mwm8 excluded.
	assert.equal(AUDIT_DELEGATIONS.length, 17);
	assert.ok(!AUDIT_DELEGATIONS.some((d) => d.totalTokens === 13_386_322), "post-baseline 20260805-085409-m7t4 is excluded");
	assert.ok(!AUDIT_DELEGATIONS.some((d) => d.totalTokens === 1_571_213), "20260805-092032-mwm8 is not part of the baseline");

	// The tuples reproduce the confirmed baseline sums.
	assert.equal(AUDIT_DELEGATIONS.reduce((acc, d) => acc + d.turns, 0), 895);
	assert.equal(AUDIT_DELEGATIONS.reduce((acc, d) => acc + d.totalTokens, 0), 176_233_313);
	assert.equal(AUDIT_DELEGATIONS.reduce((acc, d) => acc + d.outputTokens, 0), 1_531_434);

	const flags = (d: (typeof AUDIT_DELEGATIONS)[number]): ReturnType<typeof workerSpendDimensionFlags> =>
		workerSpendDimensionFlags(d, "standard");

	// Exactly 7/17 extreme runs reach hard — the same seven for turns and total_tokens.
	const hardIds = AUDIT_DELEGATIONS.filter((d) => workerSpendBand(d, "standard") === "hard").map((d) => d.id);
	assert.deepEqual(hardIds, [
		"20260804-180256-t1rd",
		"20260804-190302-nulo",
		"20260804-195733-hyou",
		"20260804-204126-exm6",
		"20260804-214758-efnk",
		"20260804-221545-1oi4",
		"20260805-073945-agdo",
	]);
	assert.deepEqual(
		AUDIT_DELEGATIONS.filter((d) => flags(d).hard.turns).map((d) => d.id),
		hardIds,
		"the same seven delegations reach hard on turns",
	);
	assert.deepEqual(
		AUDIT_DELEGATIONS.filter((d) => flags(d).hard.totalTokens).map((d) => d.id),
		hardIds,
		"the same seven delegations reach hard on total_tokens",
	);
	assert.equal(AUDIT_DELEGATIONS.filter((d) => flags(d).hard.outputTokens).length, 0, "no delegation reaches hard on output");
	assert.equal(Math.max(...AUDIT_DELEGATIONS.map((d) => d.outputTokens)), 193_852, "max observed output is below the 320,000 hard limit");

	// Soft counts under the Luna policy: 10/17 turns, 9/17 total, 4/17 output.
	assert.equal(AUDIT_DELEGATIONS.filter((d) => flags(d).soft.turns).length, 10);
	assert.equal(AUDIT_DELEGATIONS.filter((d) => flags(d).soft.totalTokens).length, 9);
	assert.deepEqual(
		AUDIT_DELEGATIONS.filter((d) => flags(d).soft.outputTokens).map((d) => d.id),
		["20260804-190302-nulo", "20260804-204126-exm6", "20260804-221545-1oi4", "20260805-073945-agdo"],
	);

	// Every current soft-output record, with its exact value.
	for (const [id, output] of [
		["20260804-190302-nulo", 172_385],
		["20260804-204126-exm6", 193_852],
		["20260804-221545-1oi4", 185_279],
		["20260805-073945-agdo", 177_413],
	] as const) {
		const record = AUDIT_DELEGATIONS.find((d) => d.id === id);
		assert.ok(record, `baseline record ${id} present`);
		assert.equal(record.outputTokens, output, `${id} output value`);
	}

	// Every hard delegation lists exactly the hard-triggered reasons in the
	// fixed order; moderate historical runs now remain in the continuation reserve.
	for (const d of AUDIT_DELEGATIONS) {
		if (workerSpendBand(d, "standard") === "hard") {
			assert.deepEqual(workerSpendReasons(d, "standard"), ["turns", "total_tokens"], `${d.id} hard reasons in fixed order`);
		}
	}
	const softOnly = AUDIT_DELEGATIONS.find((d) => d.id === "20260804-194211-2m0s");
	assert.ok(softOnly);
	assert.equal(workerSpendBand(softOnly, "standard"), "soft");
	assert.deepEqual(workerSpendReasons(softOnly, "standard"), ["turns", "total_tokens"]);
	const formerlySoft = AUDIT_DELEGATIONS.find((d) => d.id === "20260804-182145-8wrv");
	assert.ok(formerlySoft);
	assert.equal(workerSpendBand(formerlySoft, "standard"), "ok", "31-turn ordinary work no longer enters the handoff reserve");
});
