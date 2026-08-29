import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";

import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import type { ExecFn } from "../extensions/workbench-runtime/core/config.ts";
import {
	bindDelegationBoundedTaskContractV2,
	type DelegationBoundedTaskContractBindingV2,
} from "../extensions/workbench-runtime/core/delegation-transaction-artifacts.ts";
import {
	REVIEW_PAGE_BODY_MAX_BYTES,
	REVIEW_PAGE_BODY_MAX_LINES,
	collectStructuredReviewPresentationV1,
	preflightSemanticReviewEnvelopeV1,
	type ReviewAuthorityFacts,
} from "../extensions/workbench-runtime/core/diff-review.ts";
import {
	computeReviewRelevanceProjectionHashV2,
	type ReviewRelevanceBindingV2,
	type ReviewRelevanceProjectionV2,
} from "../extensions/workbench-runtime/core/review-relevance-v2.ts";
import {
	STRUCTURED_SOL_FINAL_TOOL_NAME,
	STRUCTURED_SOL_PAGE_TOOL_NAME,
	STRUCTURED_SOL_REVIEW_API,
	STRUCTURED_SOL_REVIEW_MODEL,
	STRUCTURED_SOL_REVIEW_PROVIDER,
	validateStructuredSolReviewReceipt,
} from "../extensions/workbench-runtime/core/structured-sol-review.ts";
import {
	coordinateStructuredSolReview,
	coordinateStructuredSolTerminalNegativeReview,
	deriveStructuredSolRepairAffectedPathsV2,
	type CoordinateStructuredSolReviewInput,
} from "../extensions/workbench-runtime/core/structured-sol-review-coordinator.ts";
import {
	buildSemanticReviewEnvelopeV1,
	estimateSemanticReviewRecordBytesV1,
	type SemanticReviewEnvelopeV1,
	type SemanticReviewStreamDescriptorV1,
} from "../extensions/workbench-runtime/core/semantic-review-envelope.ts";

const DELEGATION_ID = "20260827-020202-sc01";
const PATH = "src/a.ts";

test("V2 repair affected paths stay page-local unless a blocking finding has no path binding", () => {
	const assessments = new Map([
		["src/a.ts", [{ decision: "PASS" as const, findings: [] }]],
		["src/b.ts", [{
			decision: "REPAIR" as const,
			findings: [{ finding_id: "P2-F1", severity: "BLOCKING" as const }],
		}]],
	]);
	assert.deepEqual(deriveStructuredSolRepairAffectedPathsV2({
		status: "REPAIR",
		fresh_paths: ["src/a.ts", "src/b.ts"],
		assessments_by_path: assessments,
		blocking_finding_ids: ["P2-F1"],
		cross_blocking_finding_ids: [],
	}), ["src/b.ts"]);
	assert.deepEqual(deriveStructuredSolRepairAffectedPathsV2({
		status: "REPAIR",
		fresh_paths: ["src/a.ts", "src/b.ts"],
		assessments_by_path: assessments,
		blocking_finding_ids: ["X-F1"],
		cross_blocking_finding_ids: ["X-F1"],
	}), ["src/a.ts", "src/b.ts"]);
});

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function usage(seed = 0): Usage {
	return {
		input: 10 + seed,
		output: 5,
		cacheRead: 2,
		cacheWrite: 1,
		reasoning: 3,
		totalTokens: 18 + seed,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
	};
}

const MODEL: Model<Api> = {
	id: STRUCTURED_SOL_REVIEW_MODEL,
	name: "Sol",
	api: STRUCTURED_SOL_REVIEW_API,
	provider: STRUCTURED_SOL_REVIEW_PROVIDER,
	baseUrl: "https://chatgpt.com/backend-api/codex",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
};

function payload(context: Context): Record<string, unknown> {
	const message = context.messages[0];
	assert.equal(message?.role, "user");
	assert.ok(Array.isArray(message.content));
	const content = message.content[0];
	assert.equal(content?.type, "text");
	return JSON.parse(content.text) as Record<string, unknown>;
}

function response(toolName: string, args: Record<string, unknown>, responseUsage = usage()): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "bounded review" },
			{ type: "toolCall", id: "call-1", name: toolName, arguments: args },
		],
		api: STRUCTURED_SOL_REVIEW_API,
		provider: STRUCTURED_SOL_REVIEW_PROVIDER,
		model: STRUCTURED_SOL_REVIEW_MODEL,
		responseModel: STRUCTURED_SOL_REVIEW_MODEL,
		usage: responseUsage,
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function acceptingRegistry(
	onCall?: (index: number, context: Context) => void,
	finalDecision: "ACCEPT" | "REPAIR" = "ACCEPT",
): {
	registry: CoordinateStructuredSolReviewInput["model_registry"];
	calls: Context[];
} {
	const calls: Context[] = [];
	const registry = {
		find: () => MODEL,
		hasConfiguredAuth: () => true,
		async complete(_model: Model<Api>, context: Context) {
			const index = calls.length;
			calls.push(context);
			onCall?.(index, context);
			const request = payload(context);
			if (context.tools?.[0]?.name === STRUCTURED_SOL_PAGE_TOOL_NAME) {
				const page = request.page as Record<string, unknown>;
				return response(STRUCTURED_SOL_PAGE_TOOL_NAME, {
					page_content_sha256: page.page_content_sha256,
					decision: "PASS",
					summary: "This page satisfies the bounded contract.",
					findings: [],
				});
			}
			const assessments = request.page_assessments as unknown[];
			return response(STRUCTURED_SOL_FINAL_TOOL_NAME, {
				page_assessment_set_hash: request.page_assessment_set_hash,
				reviewed_page_count: assessments.length,
				decision: finalDecision,
				summary: finalDecision === "ACCEPT" ? "All complete pages are semantically acceptable." : "The terminal outcome requires a bounded repair.",
				repair_reason: finalDecision === "ACCEPT" ? null : "Repair the committed terminal-negative outcome.",
				blocking_finding_ids: [],
				cross_page_findings: [],
			});
		},
	} as unknown as CoordinateStructuredSolReviewInput["model_registry"];
	return { registry, calls };
}

test("terminal-negative coordinator exposes only a hash-bound REPAIR result", async (t) => {
	const fx = await fixture(t, "diff --git a/src/a.ts b/src/a.ts\n+terminal change\n");
	const fake = acceptingRegistry(undefined, "REPAIR");
	const result = await coordinateStructuredSolTerminalNegativeReview(coordinatorInput(fx, fake.registry));

	assert.equal(result.status, "REPAIR");
	assert.equal(fake.calls.length, fx.envelope.total_pages + 1);
	if (result.status === "REPAIR") {
		assert.equal(result.receipt.decision_constraint, "REPAIR_ONLY");
		assert.equal(result.receipt.decision, "REPAIR");
		assert.equal(validateStructuredSolReviewReceipt(result.receipt), true);
	}
});

test("terminal-negative coordinator turns a Sol ACCEPT attempt into retryable protocol failure", async (t) => {
	const fx = await fixture(t, "diff --git a/src/a.ts b/src/a.ts\n+terminal change\n");
	const fake = acceptingRegistry();
	const result = await coordinateStructuredSolTerminalNegativeReview(coordinatorInput(fx, fake.registry));

	assert.equal(result.status, "RETRYABLE_FAILURE");
	if (result.status === "RETRYABLE_FAILURE") {
		assert.equal(result.code, "INVALID_TOOL_RESPONSE");
		assert.equal(result.attempt_receipt?.decision_constraint, "REPAIR_ONLY");
		assert.equal(validateStructuredSolReviewReceipt(result.attempt_receipt), true);
	}
});

interface Fixture {
	root: string;
	contract: DelegationBoundedTaskContractBindingV2;
	projection: ReviewRelevanceProjectionV2;
	binding: ReviewRelevanceBindingV2;
	envelope: SemanticReviewEnvelopeV1;
	authority: ReviewAuthorityFacts;
	exec: ExecFn;
	setStream(value: string): void;
}

async function fixture(t: test.TestContext, initialStream: string, roles: Array<"W" | "C"> = ["W"]): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "structured-sol-coordinator-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "src"), { recursive: true });
	const fileText = "export const value = 1;\n";
	await writeFile(join(root, PATH), fileText);
	const contract = bindDelegationBoundedTaskContractV2({
		task_kind: "implementation",
		task: "Implement the exact requested behavior.",
		allowed_paths: ["src/**"],
		acceptance_criteria: ["The implementation is correct and tested."],
		verification: ["Inspect the full diff and run focused tests."],
		timeout_seconds: 600,
		budget_profile: "standard",
	});
	if (!contract.ok) throw new Error(contract.error.message);
	const projection: ReviewRelevanceProjectionV2 = {
		schema_version: 2,
		diff_identity_kind: "changeset-relevance-v2",
		delegation_id: DELEGATION_ID,
		contract_hash: contract.value.contract_hash,
		change_set_hash: "a".repeat(64),
		worker_delta_hash: "b".repeat(64),
		...(roles.includes("C") ? { command_provenance_hash: "d".repeat(64) } : {}),
		git_head: "c".repeat(40),
		entries: [{
			path: PATH,
			roles,
			status: "M",
			full_identity: {
				schema_version: 2,
				kind: "file",
				path: PATH,
				byte_size: Buffer.byteLength(fileText, "utf8"),
				sha256: sha256(fileText),
				stat: { dev: "1", ino: "1", mtime_ns: "1", ctime_ns: "1" },
			},
		}],
	};
	const projectionHash = computeReviewRelevanceProjectionHashV2(projection);
	const binding: ReviewRelevanceBindingV2 = {
		schema_version: 2,
		diff_identity_kind: "changeset-relevance-v2",
		projection_hash: projectionHash,
	};
	let streamText = initialStream;
	const exec: ExecFn = async (_command, args) => ({
		stdout: args.includes("--cached") ? "" : streamText,
		stderr: "",
		code: 0,
		killed: false,
	});
	const after = {
		gitHead: projection.git_head,
		gitDirty: true,
		changedPaths: [PATH],
		pathStatuses: { [PATH]: "M" },
		pathDigests: { [PATH]: sha256(fileText) },
	};
	const preflight = await preflightSemanticReviewEnvelopeV1({
		projectRoot: root,
		workerPaths: [PATH],
		allowedPaths: contract.value.allowed_paths,
		afterDigests: after.pathDigests,
		pathStatuses: after.pathStatuses,
		relevanceProjection: projection,
		relevanceProjectionHash: projectionHash,
		exec,
	});
	if (!preflight.ok) throw new Error(preflight.code);
	const authority: ReviewAuthorityFacts = {
		delegation_id: DELEGATION_ID,
		allowed_paths: contract.value.allowed_paths,
		worker_paths: [PATH],
		recorded_after_hash: projectionHash,
		after,
		reported_paths: [PATH],
		current: structuredClone(after),
		current_diff_hash: projectionHash,
		drift_paths: [],
		relevance_binding: binding,
		relevance_projection: projection,
		review_envelope: preflight.value,
	};
	return {
		root,
		contract: contract.value,
		projection,
		binding,
		envelope: preflight.value,
		authority,
		exec,
		setStream(value) { streamText = value; },
	};
}

function coordinatorInput(
	fx: Fixture,
	registry: CoordinateStructuredSolReviewInput["model_registry"],
): CoordinateStructuredSolReviewInput {
	return {
		project_root: fx.root,
		delegation_id: DELEGATION_ID,
		contract: fx.contract,
		relevance_projection: fx.projection,
		semantic_envelope: fx.envelope,
		authority: fx.authority,
		model_registry: registry,
		exec: fx.exec,
		now: () => new Date("2026-08-27T02:02:02.000Z"),
	};
}

test("preflight counts actual iterative pages when long-line and short-line pressure occur in disjoint regions", async (t) => {
	const longRegion = "L".repeat(REVIEW_PAGE_BODY_MAX_BYTES * 2);
	const shortRegion = Array.from({ length: REVIEW_PAGE_BODY_MAX_LINES * 2 }, () => "x").join("\n");
	const stream = `${longRegion}\n${shortRegion}`;
	const fx = await fixture(t, stream);
	const legacyCount = Math.max(
		Math.ceil(Buffer.byteLength(stream, "utf8") / REVIEW_PAGE_BODY_MAX_BYTES),
		Math.ceil(stream.split("\n").length / REVIEW_PAGE_BODY_MAX_LINES),
	);
	assert.ok(fx.envelope.total_pages > legacyCount, "the old independent-ceil formula underestimates sequential slicing");

	const collected = await collectStructuredReviewPresentationV1({
		projectRoot: fx.root,
		authority: fx.authority,
		exec: fx.exec,
	});
	assert.equal(collected.ok, true);
	if (!collected.ok) return;
	assert.equal(collected.value.envelope_compatibility, "current");
	assert.equal(collected.value.pages.length, fx.envelope.total_pages);
	assert.equal(collected.value.pages.map((page) => page.content).join(""), stream);
	assert.equal(collected.value.pages[0]?.start_byte, 0);
	assert.equal(collected.value.pages.at(-1)?.end_byte, Buffer.byteLength(stream, "utf8"));
	assert.equal(Object.isFrozen(collected.value.pages[0]), true);
});

test("collector recognizes the old max-ceil envelope only as historical validation compatibility", async (t) => {
	const longRegion = "L".repeat(REVIEW_PAGE_BODY_MAX_BYTES * 2);
	const shortRegion = Array.from({ length: REVIEW_PAGE_BODY_MAX_LINES * 2 }, () => "x").join("\n");
	const stream = `${longRegion}\n${shortRegion}`;
	const fx = await fixture(t, stream);
	const legacyCount = Math.max(
		Math.ceil(Buffer.byteLength(stream, "utf8") / REVIEW_PAGE_BODY_MAX_BYTES),
		Math.ceil(stream.split("\n").length / REVIEW_PAGE_BODY_MAX_LINES),
	);
	const legacyStreams: SemanticReviewStreamDescriptorV1[] = [{
		path: PATH,
		source: "git-diff",
		stream_bytes: Buffer.byteLength(stream, "utf8"),
		stream_sha256: sha256(stream),
		page_count: legacyCount,
	}];
	const projectedBytes = estimateSemanticReviewRecordBytesV1({
		worker_paths: [PATH],
		allowed_paths: fx.contract.allowed_paths,
		streams: legacyStreams,
		relevance_projection: fx.projection,
	});
	assert.notEqual(projectedBytes, undefined);
	const legacyEnvelope = buildSemanticReviewEnvelopeV1({
		streams: legacyStreams,
		projected_review_record_bytes: projectedBytes!,
		relevance_projection_hash: fx.binding.projection_hash,
	});
	assert.equal(legacyEnvelope.ok, true);
	if (!legacyEnvelope.ok) return;
	const authority = { ...fx.authority, review_envelope: legacyEnvelope.value };
	const collected = await collectStructuredReviewPresentationV1({ projectRoot: fx.root, authority, exec: fx.exec });
	assert.equal(collected.ok, true);
	if (collected.ok) {
		assert.equal(collected.value.envelope_compatibility, "legacy-page-count-v1");
		assert.ok(collected.value.pages.length > legacyEnvelope.value.total_pages);
	}
});

test("coordinator returns ACCEPT only after the post-review presentation matches byte-for-byte", async (t) => {
	const fx = await fixture(t, "diff --git a/src/a.ts b/src/a.ts\n+export const value = 1;\n");
	const model = acceptingRegistry();
	const result = await coordinateStructuredSolReview(coordinatorInput(fx, model.registry));
	assert.equal(result.status, "ACCEPT");
	assert.equal(model.calls.length, fx.envelope.total_pages + 1);
	assert.equal(result.usage.input, model.calls.length * 10);
	if (result.status === "ACCEPT") assert.equal(validateStructuredSolReviewReceipt(result.receipt), true);
});

test("semantic findings return REPAIR, but a provider failure is RETRYABLE_FAILURE", async (t) => {
	const fx = await fixture(t, "diff --git a/src/a.ts b/src/a.ts\n+unsafe();\n");
	let calls = 0;
	const repairRegistry = {
		find: () => MODEL,
		hasConfiguredAuth: () => true,
		async complete(_model: Model<Api>, context: Context) {
			calls += 1;
			const request = payload(context);
			if (context.tools?.[0]?.name === STRUCTURED_SOL_PAGE_TOOL_NAME) {
				const page = request.page as Record<string, unknown>;
				return response(STRUCTURED_SOL_PAGE_TOOL_NAME, {
					page_content_sha256: page.page_content_sha256,
					decision: "REPAIR",
					summary: "Unsafe behavior is blocking.",
					findings: [{
						finding_id: "P1-F1", severity: "BLOCKING", category: "SECURITY",
						title: "Unsafe call", evidence: "The page invokes unsafe().", recommendation: "Remove the unsafe call.",
					}],
				});
			}
			return response(STRUCTURED_SOL_FINAL_TOOL_NAME, {
				page_assessment_set_hash: request.page_assessment_set_hash,
				reviewed_page_count: 1,
				decision: "REPAIR",
				summary: "A blocking security finding remains.",
				repair_reason: "Remove the unsafe call.",
				blocking_finding_ids: ["P1-F1"],
				cross_page_findings: [],
			});
		},
	} as unknown as CoordinateStructuredSolReviewInput["model_registry"];
	const repair = await coordinateStructuredSolReview(coordinatorInput(fx, repairRegistry));
	assert.equal(repair.status, "REPAIR");
	assert.equal(calls, 2);

	let providerCalls = 0;
	const failingRegistry = {
		find: () => MODEL,
		hasConfiguredAuth: () => true,
		async complete(_model: Model<Api>, context: Context) {
			providerCalls += 1;
			if (providerCalls === 1) return acceptingRegistry().registry.complete(MODEL, context);
			throw new Error("provider unavailable");
		},
	} as unknown as CoordinateStructuredSolReviewInput["model_registry"];
	const failed = await coordinateStructuredSolReview(coordinatorInput(fx, failingRegistry));
	assert.equal(failed.status, "RETRYABLE_FAILURE");
	if (failed.status === "RETRYABLE_FAILURE") {
		assert.equal(failed.code, "MODEL_ERROR");
		assert.notEqual(failed.attempt_receipt, undefined);
		assert.equal(failed.usage.input, 10, "usage from the completed page call is retained");
	}
});

test("post-review stream drift suppresses an otherwise valid ACCEPT receipt", async (t) => {
	const initial = "diff --git a/src/a.ts b/src/a.ts\n+export const value = 1;\n";
	const fx = await fixture(t, initial);
	const model = acceptingRegistry((_index, context) => {
		if (context.tools?.[0]?.name === STRUCTURED_SOL_FINAL_TOOL_NAME) {
			fx.setStream(`${initial}+drift();\n`);
		}
	});
	const result = await coordinateStructuredSolReview(coordinatorInput(fx, model.registry));
	assert.equal(result.status, "RETRYABLE_FAILURE");
	if (result.status === "RETRYABLE_FAILURE") {
		assert.equal(result.code, "PRESENTATION_DRIFT");
		assert.equal(result.presentation_error, "SEMANTIC_ENVELOPE_MISMATCH");
		assert.notEqual(result.attempt_receipt, undefined, "the attempt remains auditable but has no semantic authority");
	}
});

test("command-only ignored exact output is included in collector and can receive ACCEPT or REPAIR", async (t) => {
	const fx = await fixture(t, "", ["C"]);
	const collected = await collectStructuredReviewPresentationV1({ projectRoot: fx.root, authority: fx.authority, exec: fx.exec });
	assert.equal(collected.ok, true);
	if (!collected.ok) return;
	assert.deepEqual(collected.value.streams.map((stream) => stream.path), [PATH]);
	assert.equal(collected.value.streams[0]?.source, "file-content", "ignored command output is read from its exact file path");

	const accepted = acceptingRegistry();
	const accept = await coordinateStructuredSolReview(coordinatorInput(fx, accepted.registry));
	assert.equal(accept.status, "ACCEPT");

	const repairRegistry = {
		find: () => MODEL,
		hasConfiguredAuth: () => true,
		async complete(_model: Model<Api>, context: Context) {
			const request = payload(context);
			if (context.tools?.[0]?.name === STRUCTURED_SOL_PAGE_TOOL_NAME) {
				const page = request.page as Record<string, unknown>;
				return response(STRUCTURED_SOL_PAGE_TOOL_NAME, {
					page_content_sha256: page.page_content_sha256,
					decision: "REPAIR",
					summary: "The exact generated output is semantically invalid.",
					findings: [{
						finding_id: "P1-F1", severity: "BLOCKING", category: "CORRECTNESS",
						title: "Invalid generated value", evidence: "The exact output contains the wrong value.", recommendation: "Regenerate the exact output.",
					}],
				});
			}
			return response(STRUCTURED_SOL_FINAL_TOOL_NAME, {
				page_assessment_set_hash: request.page_assessment_set_hash,
				reviewed_page_count: 1,
				decision: "REPAIR",
				summary: "The command-only output requires repair.",
				repair_reason: "Regenerate the exact command output.",
				blocking_finding_ids: ["P1-F1"],
				cross_page_findings: [],
			});
		},
	} as unknown as CoordinateStructuredSolReviewInput["model_registry"];
	const repair = await coordinateStructuredSolReview(coordinatorInput(fx, repairRegistry));
	assert.equal(repair.status, "REPAIR");
});

test("automatic coordinator refuses more than 32 pages before any model call", async (t) => {
	const stream = Array.from({ length: REVIEW_PAGE_BODY_MAX_LINES * 33 }, (_, index) => `line-${index}`).join("\n");
	const fx = await fixture(t, stream);
	let calls = 0;
	const model = acceptingRegistry(() => { calls += 1; });
	const result = await coordinateStructuredSolReview(coordinatorInput(fx, model.registry));
	assert.equal(result.status, "RETRYABLE_FAILURE");
	if (result.status === "RETRYABLE_FAILURE") assert.equal(result.code, "REVIEW_TOO_LARGE");
	assert.equal(calls, 0);
});

test("final Sol call receives every raw page and can detect a defect spanning two pages", async (t) => {
	const stream = [
		"BEGIN_UNSAFE_PAIR",
		...Array.from({ length: REVIEW_PAGE_BODY_MAX_LINES + 20 }, (_, index) => `safe-${index}`),
		"END_UNSAFE_PAIR",
	].join("\n");
	const fx = await fixture(t, stream);
	assert.ok(fx.envelope.total_pages >= 2);
	let sawRawPages = false;
	const registry = {
		find: () => MODEL,
		hasConfiguredAuth: () => true,
		async complete(_model: Model<Api>, context: Context) {
			const request = payload(context);
			if (context.tools?.[0]?.name === STRUCTURED_SOL_PAGE_TOOL_NAME) {
				const page = request.page as Record<string, unknown>;
				return response(STRUCTURED_SOL_PAGE_TOOL_NAME, {
					page_content_sha256: page.page_content_sha256,
					decision: "PASS",
					summary: "No page-local defect is independently visible.",
					findings: [],
				});
			}
			const rawPages = request.pages as Array<{ page_content: string }>;
			sawRawPages = rawPages.length >= 2
				&& rawPages.some((page) => page.page_content.includes("BEGIN_UNSAFE_PAIR"))
				&& rawPages.some((page) => page.page_content.includes("END_UNSAFE_PAIR"));
			return response(STRUCTURED_SOL_FINAL_TOOL_NAME, {
				page_assessment_set_hash: request.page_assessment_set_hash,
				reviewed_page_count: rawPages.length,
				decision: "REPAIR",
				summary: "The raw pages expose a cross-page unsafe pair.",
				repair_reason: "Remove the cross-page unsafe pair.",
				blocking_finding_ids: [],
				cross_page_findings: [{
					finding_id: "X-F1", severity: "BLOCKING", category: "CORRECTNESS",
					title: "Cross-page unsafe pair", evidence: "BEGIN and END markers occur on different raw pages.", recommendation: "Remove the paired behavior.",
				}],
			});
		},
	} as unknown as CoordinateStructuredSolReviewInput["model_registry"];
	const result = await coordinateStructuredSolReview(coordinatorInput(fx, registry));
	assert.equal(sawRawPages, true);
	assert.equal(result.status, "REPAIR", JSON.stringify(result));
});
