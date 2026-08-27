import assert from "node:assert/strict";
import test from "node:test";

import type { Usage } from "@earendil-works/pi-ai";

import {
	runAutomaticSemanticReview,
	type AutomaticSemanticReviewDependencies,
} from "../extensions/workbench-runtime/core/automatic-semantic-review-service.ts";
import type { DelegationReviewV2Result } from "../extensions/workbench-runtime/core/delegation-review-v2.ts";
import { missingRepairLineageStructuredPresentationPathsV2 } from "../extensions/workbench-runtime/core/delegation-review-v2.ts";
import type { ReviewRecord } from "../extensions/workbench-runtime/core/diff-review.ts";

const ID = "20260827-040404-auto";
const HASH = "a".repeat(64);
const PATH = "src/a.ts";

const usage: Usage = {
	input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
};

function record(complete: boolean): ReviewRecord {
	return {
		schema_version: 2,
		delegation_id: ID,
		reviewed_at: "2026-08-27T04:04:04.000Z",
		verdict: "PASS",
		bound_diff_hash: HASH,
		recorded_after_hash: HASH,
		mismatch: false,
		drift_paths: [],
		violations: [],
		allowed_paths: ["src/**"],
		checked_paths: [PATH],
		include_paths: [PATH],
		patch: [],
		patch_truncated: !complete,
		patch_paths: [],
		notes: [],
		displayed_paths: [PATH],
		remaining_paths: [],
		coverage_complete: true,
		fully_presented_paths: complete ? [PATH] : [],
		presentation_remaining_paths: complete ? [] : [PATH],
		presentation_complete: complete,
		presentation_progress: [{
			path: PATH,
			source: "file-content",
			stream_sha256: "b".repeat(64),
			next_byte: complete ? 2 : 1,
			total_bytes: 2,
			segments: complete
				? [{ start_byte: 0, end_byte: 1, page_sha256: "c".repeat(64) }, { start_byte: 1, end_byte: 2, page_sha256: "d".repeat(64) }]
				: [{ start_byte: 0, end_byte: 1, page_sha256: "c".repeat(64) }],
		}],
		semantic_review: "required",
		review_path: `.pi/workbench/delegations/${ID}/v2/review.json`,
		diff_identity_kind: "changeset-relevance-v2",
		relevance_binding: { schema_version: 2, diff_identity_kind: "changeset-relevance-v2", projection_hash: HASH },
		relevance_projection: {} as never,
		review_envelope: {} as never,
	};
}

function reviewResult(value: ReviewRecord, semanticAuthority?: "repair_required"): Extract<DelegationReviewV2Result, { ok: true }> {
	return {
		ok: true,
		review: { ok: true, record: value, lines: ["PASS"] },
		transaction: {} as never,
		review_hash: "e".repeat(64),
		review_path: value.review_path,
		finalized: false,
		...(semanticAuthority === undefined ? {} : { semantic_authority: semanticAuthority }),
	};
}

function harness(options: {
	decision?: "ACCEPT" | "REPAIR";
	retryCode?: "MODEL_UNAVAILABLE" | "PRESENTATION_DRIFT";
	lostResponse?: boolean;
	initialDecision?: "ACCEPT" | "REPAIR";
	pageCount?: number;
	resolveCode?: "LINEAGE_PRESENTATION_GAP";
	mechanicalFail?: boolean;
}) {
	let current = options.mechanicalFail
		? { ...record(false), verdict: "FAIL" as const, violations: [{ path: PATH, reason: "outside allowed scope" }] }
		: record(false);
	let durableDecision = options.initialDecision;
	let pageCalls = 0;
	let decisionCalls = 0;
	let coordinateCalls = 0;
	const generation = { state: { status: "PENDING_REVIEW", delegation_id: ID } } as never;
	const authority = () => ({
		state: { status: durableDecision === "ACCEPT" ? "REVIEWED" : "PENDING_REVIEW" },
		review: current,
		decision: durableDecision,
	} as never);
	const dependencies: AutomaticSemanticReviewDependencies = {
		readCommittedGeneration: async () => ({ ok: true, value: generation }),
		readReview: async () => ({ ok: true, value: authority() }),
		isSemanticAccepted: ((value: unknown) => (value as { decision?: string }).decision === "ACCEPT") as never,
		isSemanticRepair: ((value: unknown) => (value as { decision?: string }).decision === "REPAIR") as never,
		resolveCommittedAuthority: (() => options.resolveCode === undefined ? ({
			ok: true,
			value: { contract: {} as never, authority: {} as never, review: current },
		}) : ({ ok: false, code: options.resolveCode })) as never,
		collectPresentation: (async () => ({
			ok: true,
			value: {
				envelope_compatibility: "current",
				pages: Array.from({ length: options.pageCount ?? 2 }, () => ({})),
			},
		})) as never,
		review: (async (input: { semanticDecision?: "ACCEPT" | "REPAIR" }) => {
			if (input.semanticDecision === undefined) {
				pageCalls += 1;
				current = record(true);
				return reviewResult(current);
			}
			decisionCalls += 1;
			durableDecision = input.semanticDecision;
			if (options.lostResponse) throw new Error("response lost after durable publish");
			return reviewResult(current, input.semanticDecision === "REPAIR" ? "repair_required" : undefined);
		}) as never,
		coordinate: (async () => {
			coordinateCalls += 1;
			if (options.retryCode !== undefined) {
				return { status: "RETRYABLE_FAILURE", code: options.retryCode, usage };
			}
			return {
				status: options.decision ?? "ACCEPT",
				usage,
				receipt: {
					receipt_hash: "f".repeat(64),
					final_assessment: options.decision === "REPAIR" ? { repair_reason: "Fix the blocking defect." } : null,
				},
			};
		}) as never,
	};
	return {
		dependencies,
		facts: () => ({ pageCalls, decisionCalls, coordinateCalls }),
	};
}

function terminalHarness(options: {
	status?: "FAILED" | "INTERRUPTED";
	lostResponse?: boolean;
	initialDecision?: boolean;
	mechanicalFail?: boolean;
	resolveCode?: "LEGACY_REVIEW_REQUIRES_MIGRATION";
	legacyOutcome?: boolean;
	retryCode?: "MODEL_UNAVAILABLE" | "PRESENTATION_DRIFT";
	decisionPersistenceFailure?: boolean;
	initialReviewMissing?: boolean;
}) {
	let current = options.mechanicalFail
		? { ...record(true), verdict: "FAIL" as const, violations: [{ path: PATH, reason: "scope mismatch" }] }
		: record(false);
	let durableDecision = options.initialDecision ?? false;
	let pageCalls = 0;
	let decisionCalls = 0;
	let coordinateCalls = 0;
	let hasReview = !options.initialReviewMissing;
	const terminalOutcome = {
		schema_version: options.legacyOutcome ? 1 : 2,
		terminal_facts_complete: true,
		scope_complete: true,
		change_set_status: "ATTRIBUTED",
		changed_paths: [PATH],
		delta_hash: "9".repeat(64),
		...(options.legacyOutcome ? {} : { worker_success: false, worker_failure_code: "worker_failed" }),
	};
	const generation = {
		state: {
			task_kind: "implementation",
			status: options.status ?? "FAILED",
			revision: 3,
			delegation_id: ID,
			contract_hash: "8".repeat(64),
			allowed_paths: ["src/**"],
			committed_proof: { revision: 2, content_hash: "7".repeat(64) },
			review: null,
			terminal_outcome: terminalOutcome,
		},
	};
	const authority = () => ({
		state: generation.state,
		review: current,
		terminalDecision: durableDecision,
		terminal_negative_repair: durableDecision ? { decision: { decision: "REPAIR" } } : undefined,
		finalized: false,
	} as never);
	const dependencies: AutomaticSemanticReviewDependencies = {
		readCommittedGeneration: async () => ({ ok: true, value: generation as never }),
		readTerminalNegativeReview: (async () => hasReview
			? { ok: true, value: authority() }
			: { ok: false, error: { code: "not_found", message: "provisional packet absent" } }) as never,
		isTerminalNegativeRepair: ((value: unknown) => (value as { terminalDecision?: boolean }).terminalDecision === true) as never,
		resolveTerminalNegativeAuthority: (() => options.resolveCode === undefined ? ({
			ok: true,
			value: { contract: {} as never, authority: {} as never, review: current },
		}) : ({ ok: false, code: options.resolveCode })) as never,
		collectPresentation: (async () => ({
			ok: true,
			value: { envelope_compatibility: "current", pages: [{}, {}] },
		})) as never,
		review: (async (reviewInput: { semanticDecision?: "ACCEPT" | "REPAIR" }) => {
			if (reviewInput.semanticDecision === undefined) {
				pageCalls += 1;
				hasReview = true;
				current = record(true);
				return reviewResult(current);
			}
			assert.equal(reviewInput.semanticDecision, "REPAIR");
			decisionCalls += 1;
			if (options.decisionPersistenceFailure) {
				return { ok: false, error: { code: "storage_failure", message: "injected terminal sidecar failure" } } as never;
			}
			durableDecision = true;
			if (options.lostResponse) throw new Error("response lost after terminal sidecar publish");
			return { ...reviewResult(current), semantic_authority: "terminal_repair_required" } as never;
		}) as never,
		coordinateTerminalNegative: (async () => {
			coordinateCalls += 1;
			if (options.retryCode !== undefined) return { status: "RETRYABLE_FAILURE", code: options.retryCode, usage };
			return {
				status: "REPAIR",
				usage,
				receipt: {
					receipt_hash: "6".repeat(64),
					decision_constraint: "REPAIR_ONLY",
					final_assessment: { repair_reason: "Repair the failed worker outcome." },
				},
			};
		}) as never,
	};
	return { dependencies, facts: () => ({ pageCalls, decisionCalls, coordinateCalls }), generation };
}

const input = {
	project_root: "/project",
	delegation_id: ID,
	exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
	model_registry: {} as never,
	now: () => new Date("2026-08-27T04:04:04.000Z"),
};

test("automatic service durably pages an incomplete multi-page presentation before ACCEPT", async () => {
	const h = harness({ decision: "ACCEPT" });
	const result = await runAutomaticSemanticReview(input, h.dependencies);
	assert.equal(result.status, "ACCEPT");
	assert.equal(result.mechanical_page_calls, 1);
	assert.equal(result.receipt_hash, "f".repeat(64));
	assert.deepEqual(h.facts(), { pageCalls: 1, decisionCalls: 1, coordinateCalls: 1 });
});

test("automatic service persists a semantic REPAIR and exposes exact q-repair route", async () => {
	const h = harness({ decision: "REPAIR" });
	const result = await runAutomaticSemanticReview(input, h.dependencies);
	assert.equal(result.status, "REPAIR");
	assert.equal(result.next_action, `call workbench_repair_delegation with delegation_id=${ID}`);
	assert.equal(result.nested_usage.totalTokens, usage.totalTokens);
});

test("model unavailability and presentation drift remain retryable PENDING outcomes", async () => {
	for (const code of ["MODEL_UNAVAILABLE", "PRESENTATION_DRIFT"] as const) {
		const h = harness({ retryCode: code });
		const result = await runAutomaticSemanticReview(input, h.dependencies);
		assert.equal(result.status, "RETRYABLE_FAILURE");
		if (result.status === "RETRYABLE_FAILURE") assert.equal(result.code, code);
		assert.equal(result.next_action, `call workbench_review_worker_diff with delegation_id=${ID}`);
		assert.equal(h.facts().decisionCalls, 0);
	}
});

test("a lost decision response is recovered by durable readback and replay never reruns Sol", async () => {
	const lost = harness({ decision: "ACCEPT", lostResponse: true });
	const result = await runAutomaticSemanticReview(input, lost.dependencies);
	assert.equal(result.status, "ACCEPT");
	assert.equal(lost.facts().decisionCalls, 1);

	const replay = harness({ initialDecision: "ACCEPT" });
	const replayed = await runAutomaticSemanticReview(input, replay.dependencies);
	assert.equal(replayed.status, "ACCEPT");
	if (replayed.status === "ACCEPT") assert.equal(replayed.replayed, true);
	assert.deepEqual(replay.facts(), { pageCalls: 0, decisionCalls: 0, coordinateCalls: 0 });
});

test("an unreadable durable review readback is an authority error, never an operational retry", async () => {
	let reads = 0;
	let writes = 0;
	const result = await runAutomaticSemanticReview(input, {
		readCommittedGeneration: async () => ({ ok: true, value: { state: { status: "PENDING_REVIEW", delegation_id: ID } } as never }),
		readReview: (async () => {
			reads += 1;
			return reads === 1
				? { ok: false, error: { code: "not_found", message: "absent" } }
				: { ok: false, error: { code: "invalid_record", message: "corrupt" } };
		}) as never,
		review: (async () => { writes += 1; return reviewResult(record(false)); }) as never,
	});
	assert.equal(result.status, "AUTHORITY_ERROR");
	if (result.status === "AUTHORITY_ERROR") assert.equal(result.code, "DURABLE_REVIEW_INVALID");
	assert.equal(writes, 1);
});

test("more than 32 pages invokes neither paging nor Sol and remains PENDING", async () => {
	const h = harness({ decision: "ACCEPT", pageCount: 33 });
	const result = await runAutomaticSemanticReview(input, h.dependencies);
	assert.equal(result.status, "RETRYABLE_FAILURE");
	if (result.status === "RETRYABLE_FAILURE") assert.equal(result.code, "REVIEW_TOO_LARGE");
	assert.deepEqual(h.facts(), { pageCalls: 0, decisionCalls: 0, coordinateCalls: 0 });
});

test("repair lineage carried path omitted from W/C fails closed before paging or Sol", async () => {
	const h = harness({ resolveCode: "LINEAGE_PRESENTATION_GAP" });
	const result = await runAutomaticSemanticReview(input, h.dependencies);
	assert.equal(result.status, "RETRYABLE_FAILURE");
	if (result.status === "RETRYABLE_FAILURE") assert.equal(result.code, "LINEAGE_PRESENTATION_GAP");
	assert.deepEqual(h.facts(), { pageCalls: 0, decisionCalls: 0, coordinateCalls: 0 });
});

test("mechanical scope/integrity FAIL never invokes paging or Sol and exposes only the manual repair route", async () => {
	const h = harness({ mechanicalFail: true });
	const result = await runAutomaticSemanticReview(input, h.dependencies);
	assert.equal(result.status, "RETRYABLE_FAILURE");
	if (result.status === "RETRYABLE_FAILURE") {
		assert.equal(result.code, "MECHANICAL_SCOPE_INTEGRITY_FAILED");
		assert.match(result.next_action, /workbench_review_worker_diff/u);
	}
	assert.deepEqual(h.facts(), { pageCalls: 0, decisionCalls: 0, coordinateCalls: 0 });
});

test("lineage gap detector distinguishes carried rejected D from paths actually presented by W/C", () => {
	const identity = (path: string) => ({
		schema_version: 2 as const,
		kind: "file" as const,
		path,
		byte_size: 1,
		sha256: "1".repeat(64),
		stat: { dev: "1", ino: "1", mtime_ns: "1", ctime_ns: "1" },
	});
	const projection = {
		schema_version: 2 as const,
		diff_identity_kind: "changeset-relevance-v2" as const,
		delegation_id: ID,
		contract_hash: "2".repeat(64),
		change_set_hash: "3".repeat(64),
		worker_delta_hash: "4".repeat(64),
		git_head: "5".repeat(40),
		entries: [
			{ path: "src/a.ts", roles: ["W"] as ["W"], status: "M", full_identity: identity("src/a.ts") },
			{ path: "src/b.ts", roles: ["D"] as ["D"], status: "M", full_identity: identity("src/b.ts") },
		],
	};
	const lineage = { carried_paths: ["src/a.ts", "src/b.ts"] } as never;
	assert.deepEqual(missingRepairLineageStructuredPresentationPathsV2(lineage, projection), ["src/b.ts"]);
	const fullyPresented = {
		...projection,
		command_provenance_hash: "6".repeat(64),
		entries: [
			projection.entries[0]!,
			{ ...projection.entries[1]!, roles: ["C", "D"] as ["C", "D"] },
		],
	};
	assert.deepEqual(missingRepairLineageStructuredPresentationPathsV2(lineage, fullyPresented), []);
});

test("eligible terminal-negative service completes paging, publishes only REPAIR, and strict readback recovers a lost response", async () => {
	for (const status of ["FAILED", "INTERRUPTED"] as const) {
		const h = terminalHarness({ status, lostResponse: true });
		const result = await runAutomaticSemanticReview(input, h.dependencies);
		assert.equal(result.status, "REPAIR");
		assert.equal(result.next_action, `call workbench_repair_delegation with delegation_id=${ID}`);
		assert.equal(result.receipt_hash, "6".repeat(64));
		assert.deepEqual(h.facts(), { pageCalls: 1, decisionCalls: 1, coordinateCalls: 1 });
		assert.equal((h.generation.state as { status: string }).status, status, "service never rewrites the terminal parent");
	}
});

test("terminal q-review service creates a missing durable provisional packet before invoking Sol", async () => {
	const h = terminalHarness({ status: "FAILED", initialReviewMissing: true });
	const result = await runAutomaticSemanticReview(input, h.dependencies);
	assert.equal(result.status, "REPAIR");
	assert.deepEqual(h.facts(), { pageCalls: 1, decisionCalls: 1, coordinateCalls: 1 });
});

test("terminal-negative replay reads the immutable sidecar without paging or rerunning Sol", async () => {
	const h = terminalHarness({ initialDecision: true });
	const result = await runAutomaticSemanticReview(input, h.dependencies);
	assert.equal(result.status, "REPAIR");
	if (result.status === "REPAIR") assert.equal(result.replayed, true);
	assert.deepEqual(h.facts(), { pageCalls: 0, decisionCalls: 0, coordinateCalls: 0 });
});

test("terminal mechanical FAIL and legacy diff schema refuse Sol without changing terminal state", async () => {
	const mechanical = terminalHarness({ mechanicalFail: true });
	const failed = await runAutomaticSemanticReview(input, mechanical.dependencies);
	assert.equal(failed.status, "RETRYABLE_FAILURE");
	if (failed.status === "RETRYABLE_FAILURE") assert.equal(failed.code, "MECHANICAL_SCOPE_INTEGRITY_FAILED");
	assert.deepEqual(mechanical.facts(), { pageCalls: 0, decisionCalls: 0, coordinateCalls: 0 });

	const legacyDiff = terminalHarness({ resolveCode: "LEGACY_REVIEW_REQUIRES_MIGRATION" });
	const refused = await runAutomaticSemanticReview(input, legacyDiff.dependencies);
	assert.equal(refused.status, "RETRYABLE_FAILURE");
	if (refused.status === "RETRYABLE_FAILURE") assert.equal(refused.code, "LEGACY_ENVELOPE_REQUIRES_MIGRATION");
	assert.deepEqual(legacyDiff.facts(), { pageCalls: 0, decisionCalls: 0, coordinateCalls: 0 });
});

test("historical FAILED outcome without fresh worker fields remains eligible for terminal REPAIR review", async () => {
	const legacy = terminalHarness({ legacyOutcome: true });
	const result = await runAutomaticSemanticReview(input, legacy.dependencies);
	assert.equal(result.status, "REPAIR");
	assert.deepEqual(legacy.facts(), { pageCalls: 1, decisionCalls: 1, coordinateCalls: 1 });
});

test("terminal model and sidecar persistence failures remain retryable without rewriting the terminal parent", async () => {
	const model = terminalHarness({ status: "INTERRUPTED", retryCode: "MODEL_UNAVAILABLE" });
	const modelFailure = await runAutomaticSemanticReview(input, model.dependencies);
	assert.equal(modelFailure.status, "RETRYABLE_FAILURE");
	if (modelFailure.status === "RETRYABLE_FAILURE") assert.equal(modelFailure.code, "MODEL_UNAVAILABLE");
	assert.deepEqual(model.facts(), { pageCalls: 1, decisionCalls: 0, coordinateCalls: 1 });
	assert.equal(model.generation.state.status, "INTERRUPTED");

	const persistence = terminalHarness({ status: "FAILED", decisionPersistenceFailure: true });
	const persistenceFailure = await runAutomaticSemanticReview(input, persistence.dependencies);
	assert.equal(persistenceFailure.status, "RETRYABLE_FAILURE");
	if (persistenceFailure.status === "RETRYABLE_FAILURE") assert.equal(persistenceFailure.code, "DECISION_PERSISTENCE_FAILED");
	assert.deepEqual(persistence.facts(), { pageCalls: 1, decisionCalls: 1, coordinateCalls: 1 });
	assert.equal(persistence.generation.state.status, "FAILED");
});
