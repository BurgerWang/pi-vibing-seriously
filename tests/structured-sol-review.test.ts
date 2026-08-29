import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";

import {
	STRUCTURED_SOL_FINAL_REPAIR_REVIEW_TOOL,
	STRUCTURED_SOL_FINAL_REVIEW_TOOL,
	STRUCTURED_SOL_FINAL_REVIEW_TOOL_V2,
	STRUCTURED_SOL_FINAL_TOOL_NAME,
	STRUCTURED_SOL_BATCH_REVIEW_TOOL,
	STRUCTURED_SOL_BATCH_REVIEW_TOOL_NAME,
	STRUCTURED_SOL_PAGE_REVIEW_TOOL,
	STRUCTURED_SOL_PAGE_TOOL_NAME,
	STRUCTURED_SOL_REVIEW_API,
	STRUCTURED_SOL_REVIEW_KIND,
	STRUCTURED_SOL_REVIEW_MAX_ASSESSMENT_AGGREGATE_BYTES,
	STRUCTURED_SOL_REVIEW_MODEL,
	STRUCTURED_SOL_REVIEW_PROVIDER,
	STRUCTURED_SOL_REVIEW_REQUEST_POLICY_HASH,
	STRUCTURED_SOL_REVIEW_BATCH_REQUEST_POLICY_HASH_V2,
	STRUCTURED_SOL_TERMINAL_NEGATIVE_REQUEST_POLICY_HASH,
	runStructuredSolReview,
	runStructuredSolReviewBatchedV2,
	validateSemanticReviewProgressV2,
	validateStructuredSolReviewReceipt,
	type RunStructuredSolReviewInput,
	type StructuredSolFinding,
} from "../extensions/workbench-runtime/core/structured-sol-review.ts";
import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import { bindDelegationBoundedTaskContractV2 } from "../extensions/workbench-runtime/core/delegation-transaction-artifacts.ts";
import { computeReviewRelevanceProjectionHashV2 } from "../extensions/workbench-runtime/core/review-relevance-v2.ts";
import { buildSemanticReviewEnvelopeV1 } from "../extensions/workbench-runtime/core/semantic-review-envelope.ts";

const DELEGATION_ID = "20260827-010101-sr01";

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

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function passBatch(context: Context): AssistantMessage {
	const payload = requestPayload(context);
	const pages = payload.pages as Array<{ review_page_index: number; page_binding_hash: string; page: { page_content_sha256: string } }>;
	return assistant(STRUCTURED_SOL_BATCH_REVIEW_TOOL_NAME, {
		assessments: pages.map(({ page, page_binding_hash }) => ({
			page_binding_hash,
			page_content_sha256: page.page_content_sha256,
			decision: "PASS",
			summary: "No blocking defect on this page.",
			findings: [],
		})),
	});
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

function assistant(
	toolName: string,
	args: Record<string, unknown>,
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
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
		responseId: "response-1",
		usage: usage(),
		stopReason: "toolUse",
		timestamp: 0,
		...overrides,
	};
}

function requestPayload(context: Context): Record<string, unknown> {
	const message = context.messages[0];
	assert.equal(message?.role, "user");
	assert.ok(Array.isArray(message.content));
	const content = message.content[0];
	assert.equal(content?.type, "text");
	return JSON.parse(content.text) as Record<string, unknown>;
}

interface RegistryCall {
	model: Model<Api>;
	context: Context;
	options: Record<string, unknown> | undefined;
}

function fakeRegistry(
	responder: (callIndex: number, context: Context) => AssistantMessage | Promise<AssistantMessage>,
	options: { auth?: boolean; model?: Model<Api> | undefined } = {},
): { registry: RunStructuredSolReviewInput["model_registry"]; calls: RegistryCall[] } {
	const calls: RegistryCall[] = [];
	const selectedModel = Object.hasOwn(options, "model") ? options.model : MODEL;
	const registry = {
		find(provider: string, modelId: string) {
			assert.equal(provider, STRUCTURED_SOL_REVIEW_PROVIDER);
			assert.equal(modelId, STRUCTURED_SOL_REVIEW_MODEL);
			return selectedModel;
		},
		hasConfiguredAuth(model: Model<Api>) {
			assert.equal(model, selectedModel);
			return options.auth ?? true;
		},
		async complete(model: Model<Api>, context: Context, requestOptions?: Record<string, unknown>) {
			const index = calls.length;
			calls.push({ model, context, options: requestOptions });
			return responder(index, context);
		},
	} as unknown as RunStructuredSolReviewInput["model_registry"];
	return { registry, calls };
}

interface StreamFixture {
	path: string;
	parts: readonly string[];
}

function reviewInput(
	registry: RunStructuredSolReviewInput["model_registry"],
	streamFixtures: readonly StreamFixture[] = [{ path: "src/a.ts", parts: ["alpha\n", "beta\n"] }],
): RunStructuredSolReviewInput {
	const streams = streamFixtures.map(({ path, parts }) => {
		const content = parts.join("");
		return {
			path,
			source: "file-content" as const,
			stream_bytes: Buffer.byteLength(content, "utf8"),
			stream_sha256: sha256(content),
			page_count: parts.length,
		};
	});
	const pages = streamFixtures.flatMap(({ path, parts }, streamIndex) => {
		let offset = 0;
		return parts.map((content, pageIndex) => {
			const start = offset;
			offset += Buffer.byteLength(content, "utf8");
			return {
				path,
				source: "file-content" as const,
				stream_sha256: streams[streamIndex]!.stream_sha256,
				page_number: pageIndex + 1,
				page_count: parts.length,
				start_byte: start,
				end_byte: offset,
				total_bytes: streams[streamIndex]!.stream_bytes,
				page_content_sha256: sha256(content),
				content,
			};
		});
	});
	const contract = bindDelegationBoundedTaskContractV2({
		task_kind: "implementation",
		task: "Implement the exact bounded change and preserve existing behavior.",
		allowed_paths: ["src/**"],
		acceptance_criteria: ["Every requested behavior is implemented and verified."],
		verification: ["Run focused tests and inspect the complete diff."],
		timeout_seconds: 600,
		budget_profile: "standard",
	});
	if (!contract.ok) throw new Error(contract.error.message);
	const relevanceProjection = {
		schema_version: 2 as const,
		diff_identity_kind: "changeset-relevance-v2" as const,
		delegation_id: DELEGATION_ID,
		contract_hash: contract.value.contract_hash,
		change_set_hash: "a".repeat(64),
		worker_delta_hash: "b".repeat(64),
		git_head: "c".repeat(40),
		entries: streams.map((stream) => ({
			path: stream.path,
			roles: ["W"] as const,
			status: "M",
			full_identity: {
				schema_version: 2 as const,
				kind: "file" as const,
				path: stream.path,
				byte_size: stream.stream_bytes,
				sha256: stream.stream_sha256,
				stat: { dev: "1", ino: "1", mtime_ns: "1", ctime_ns: "1" },
			},
		})),
	};
	const diffHash = computeReviewRelevanceProjectionHashV2(relevanceProjection);
	const envelope = buildSemanticReviewEnvelopeV1({
		streams,
		projected_review_record_bytes: 1_024,
		relevance_projection_hash: diffHash,
	});
	if (!envelope.ok) throw new Error(envelope.code);
	return {
		delegation_id: DELEGATION_ID,
		contract_hash: contract.value.contract_hash,
		bound_diff_hash: diffHash,
		contract: contract.value,
		relevance_projection: relevanceProjection,
		semantic_envelope: envelope.value,
		streams,
		pages,
		model_registry: registry,
		now: () => new Date("2026-08-27T01:01:01.000Z"),
	};
}

function passPage(context: Context, responseUsage = usage()): AssistantMessage {
	const payload = requestPayload(context);
	const page = payload.page as Record<string, unknown>;
	return assistant(STRUCTURED_SOL_PAGE_TOOL_NAME, {
		page_content_sha256: page.page_content_sha256,
		decision: "PASS",
		summary: "No blocking defect on this page.",
		findings: [],
	}, { usage: responseUsage });
}

function finalFromContext(context: Context, decision: "ACCEPT" | "REPAIR" = "ACCEPT"): AssistantMessage {
	const payload = requestPayload(context);
	const assessments = payload.page_assessments as Array<{ findings: StructuredSolFinding[] }>;
	const blocking = assessments.flatMap((entry) => entry.findings)
		.filter((finding) => finding.severity === "BLOCKING")
		.map((finding) => finding.finding_id)
		.sort();
	return assistant(STRUCTURED_SOL_FINAL_TOOL_NAME, {
		page_assessment_set_hash: payload.page_assessment_set_hash,
		reviewed_page_count: assessments.length,
		decision,
		summary: decision === "ACCEPT" ? "All pages are semantically acceptable." : "Blocking findings require repair.",
		repair_reason: decision === "ACCEPT" ? null : "Resolve every blocking finding.",
		blocking_finding_ids: blocking,
		cross_page_findings: [],
	});
}

test("automatic Sol review assesses every hash-bound page, uses the official complete API, and produces an immutable ACCEPT receipt", async () => {
	const fake = fakeRegistry((index, context) => index < 2 ? passPage(context, usage(index)) : finalFromContext(context));
	const result = await runStructuredSolReview(reviewInput(fake.registry));

	assert.equal(result.ok, true);
	assert.equal(result.decision, "ACCEPT");
	assert.equal(fake.calls.length, 3);
	for (const [index, call] of fake.calls.entries()) {
		assert.equal(call.model, MODEL);
		assert.equal(call.context.tools?.length, 1);
		assert.equal(call.context.tools?.[0], index < 2 ? STRUCTURED_SOL_PAGE_REVIEW_TOOL : STRUCTURED_SOL_FINAL_REVIEW_TOOL);
		assert.deepEqual(call.context.tools?.[0]?.constrainedSampling, { type: "json_schema", strict: "require" });
		assert.equal((call.context.tools?.[0]?.parameters as { additionalProperties?: boolean }).additionalProperties, false);
		assert.equal(call.options?.reasoningEffort, "xhigh");
		assert.equal(call.options?.toolChoice, "required");
		assert.equal(call.options?.cacheRetention, "none");
	}
	const firstPayload = requestPayload(fake.calls[0]!.context);
	assert.equal((firstPayload.contract as Record<string, unknown>).task, "Implement the exact bounded change and preserve existing behavior.");
	assert.equal((firstPayload.relevance_projection as Record<string, unknown>).delegation_id, DELEGATION_ID);
	assert.equal(validateStructuredSolReviewReceipt(result.receipt), true);
	assert.equal(result.receipt.calls.length, 3);
	assert.equal(result.receipt.pages.length, 2);
	assert.equal(result.receipt.page_assessments.length, 2);
	assert.equal(result.receipt.terminal_code, null);
	assert.equal(result.usage.input, usage(0).input + usage(1).input + usage(0).input);
	assert.equal(result.usage.reasoning, 9);
	assert.equal(Object.isFrozen(result.receipt), true);
	assert.equal(Object.isFrozen(result.receipt.calls[0]), true);
	assert.equal(Object.isFrozen(result.receipt.pages), true);
});

test("terminal-negative protocol binds a REPAIR-only final schema and rejects a Sol ACCEPT attempt", async (t) => {
	await t.test("REPAIR is accepted and hash-bound", async () => {
		const fake = fakeRegistry((index, context) => index < 2 ? passPage(context) : finalFromContext(context, "REPAIR"));
		const input = reviewInput(fake.registry);
		input.decision_constraint = "REPAIR_ONLY";
		const result = await runStructuredSolReview(input);

		assert.equal(result.ok, true);
		assert.equal(result.decision, "REPAIR");
		assert.equal(result.receipt.decision_constraint, "REPAIR_ONLY");
		assert.equal(result.receipt.request_policy_hash, STRUCTURED_SOL_TERMINAL_NEGATIVE_REQUEST_POLICY_HASH);
		assert.equal(fake.calls.at(-1)?.context.tools?.[0], STRUCTURED_SOL_FINAL_REPAIR_REVIEW_TOOL);
		assert.deepEqual((fake.calls.at(-1)?.context.tools?.[0]?.parameters as { properties?: { decision?: { const?: string } } }).properties?.decision, {
			const: "REPAIR",
			type: "string",
		});
		assert.equal(validateStructuredSolReviewReceipt(result.receipt), true);
	});

	await t.test("ACCEPT is rejected by the closed TypeBox protocol", async () => {
		const fake = fakeRegistry((index, context) => index < 2 ? passPage(context) : finalFromContext(context, "ACCEPT"));
		const input = reviewInput(fake.registry);
		input.decision_constraint = "REPAIR_ONLY";
		const result = await runStructuredSolReview(input);

		assert.equal(result.ok, false);
		assert.equal(result.code, "INVALID_TOOL_RESPONSE");
		assert.equal(result.receipt?.decision_constraint, "REPAIR_ONLY");
		assert.equal(result.receipt?.completed, false);
		assert.equal(result.receipt?.calls.at(-1)?.outcome, "INVALID_TOOL_RESPONSE");
		assert.equal(validateStructuredSolReviewReceipt(result.receipt), true);
	});
});

test("global review-page ordinals keep findings unique when two streams both have page_number 1", async () => {
	const fake = fakeRegistry((index, context) => {
		if (index < 2) {
			const payload = requestPayload(context);
			const page = payload.page as Record<string, unknown>;
			return assistant(STRUCTURED_SOL_PAGE_TOOL_NAME, {
				page_content_sha256: page.page_content_sha256,
				decision: "REPAIR",
				summary: `Blocking defect on global page ${index + 1}.`,
				findings: [{
					finding_id: `P${index + 1}-F1`, severity: "BLOCKING", category: "CORRECTNESS",
					title: "Incorrect behavior", evidence: "The page contradicts the contract.", recommendation: "Repair the behavior.",
				}],
			});
		}
		return finalFromContext(context, "REPAIR");
	});
	const input = reviewInput(fake.registry, [
		{ path: "src/a.ts", parts: ["a\n"] },
		{ path: "src/b.ts", parts: ["b\n"] },
	]);
	assert.deepEqual(input.pages.map((page) => page.page_number), [1, 1]);

	const result = await runStructuredSolReview(input);
	assert.equal(result.ok, true);
	assert.equal(result.decision, "REPAIR");
	assert.equal(result.receipt.terminal_code, "SEMANTIC_REPAIR_REQUIRED");
	assert.deepEqual(result.receipt.final_assessment?.blocking_finding_ids, ["P1-F1", "P2-F1"]);
	assert.equal(validateStructuredSolReviewReceipt(result.receipt), true);
});

test("a page REPAIR can never be converted into final ACCEPT", async () => {
	const fake = fakeRegistry((index, context) => {
		if (index === 0) {
			const payload = requestPayload(context);
			const page = payload.page as Record<string, unknown>;
			return assistant(STRUCTURED_SOL_PAGE_TOOL_NAME, {
				page_content_sha256: page.page_content_sha256,
				decision: "REPAIR",
				summary: "A blocking defect exists.",
				findings: [{
					finding_id: "P1-F1", severity: "BLOCKING", category: "SECURITY",
					title: "Unsafe input", evidence: "Input reaches an unsafe sink.", recommendation: "Validate input first.",
				}],
			});
		}
		if (index === 1) return passPage(context);
		const response = finalFromContext(context, "ACCEPT");
		const call = response.content.find((entry) => entry.type === "toolCall");
		assert.equal(call?.type, "toolCall");
		if (call?.type === "toolCall") call.arguments.blocking_finding_ids = ["P1-F1"];
		return response;
	});

	const result = await runStructuredSolReview(reviewInput(fake.registry));
	assert.equal(result.ok, false);
	assert.equal(result.code, "INVALID_TOOL_RESPONSE");
	assert.equal(result.decision, "REPAIR");
	assert.equal(result.receipt?.completed, false);
	assert.equal(result.receipt?.calls.at(-1)?.stage, "final");
	assert.equal(result.receipt?.calls.at(-1)?.outcome, "INVALID_TOOL_RESPONSE");
	assert.equal(validateStructuredSolReviewReceipt(result.receipt), true);
});

test("text beside the tool call, multiple calls, and wrong tool arguments all fail closed", async (t) => {
	for (const fault of ["text", "multiple", "arguments"] as const) {
		await t.test(fault, async () => {
			const fake = fakeRegistry((_index, context) => {
				const valid = passPage(context);
				if (fault === "text") valid.content.unshift({ type: "text", text: "looks good" });
				if (fault === "multiple") valid.content.push({
					type: "toolCall", id: "call-2", name: STRUCTURED_SOL_PAGE_TOOL_NAME, arguments: {},
				});
				if (fault === "arguments") {
					const call = valid.content.find((entry) => entry.type === "toolCall");
					if (call?.type === "toolCall") call.arguments.extra = true;
				}
				return valid;
			});
			const result = await runStructuredSolReview(reviewInput(fake.registry, [{ path: "src/a.ts", parts: ["a\n"] }]));
			assert.equal(result.ok, false);
			assert.equal(result.code, "INVALID_TOOL_RESPONSE");
			assert.equal(fake.calls.length, 1);
			assert.equal(validateStructuredSolReviewReceipt(result.receipt), true);
		});
	}
});

test("response identity drift fails closed while preserving nested usage evidence", async () => {
	const fake = fakeRegistry((_index, context) => passPage(context, usage(7)));
	const originalComplete = fake.registry.complete.bind(fake.registry);
	fake.registry.complete = (async (...args: Parameters<typeof originalComplete>) => {
		const response = await originalComplete(...args);
		return { ...response, model: "gpt-5.6-not-sol" };
	}) as typeof fake.registry.complete;
	const result = await runStructuredSolReview(reviewInput(fake.registry, [{ path: "src/a.ts", parts: ["a\n"] }]));

	assert.equal(result.ok, false);
	assert.equal(result.code, "INVALID_MODEL_IDENTITY");
	assert.equal(result.usage.input, 17);
	assert.equal(result.receipt?.calls[0]?.outcome, "INVALID_MODEL_IDENTITY");
	assert.equal(validateStructuredSolReviewReceipt(result.receipt), true);
});

test("model error on a later page returns a receipt with all prior usage and the failed call", async () => {
	const fake = fakeRegistry((index, context) => {
		if (index === 0) return passPage(context, usage(4));
		throw new Error("provider stream disconnected");
	});
	const result = await runStructuredSolReview(reviewInput(fake.registry));

	assert.equal(result.ok, false);
	assert.equal(result.code, "MODEL_ERROR");
	assert.equal(result.usage.input, 14);
	assert.equal(result.receipt?.calls.length, 2);
	assert.equal(result.receipt?.calls[1]?.outcome, "MODEL_ERROR");
	assert.match(result.receipt?.calls[1]?.error_hash ?? "", /^[0-9a-f]{64}$/u);
	assert.equal(validateStructuredSolReviewReceipt(result.receipt), true);
});

test("missing pages and more than 512 pages are rejected before any model call", async () => {
	const fake = fakeRegistry((_index, context) => passPage(context));
	const incomplete = reviewInput(fake.registry);
	incomplete.pages = incomplete.pages.slice(0, 1);
	const missing = await runStructuredSolReview(incomplete);
	assert.equal(missing.ok, false);
	assert.equal(missing.code, "PRESENTATION_INCOMPLETE");
	assert.equal(fake.calls.length, 0);

	const over = reviewInput(fake.registry, [{ path: "src/large.ts", parts: Array.from({ length: 513 }, () => "x") }]);
	const oversized = await runStructuredSolReview(over);
	assert.equal(oversized.ok, false);
	assert.equal(oversized.code, "PRESENTATION_OUT_OF_BOUNDS");
	assert.equal(fake.calls.length, 0);
});

test("receipt validation rejects reviewer-field impersonation and hash-bound tampering", async () => {
	assert.equal(validateStructuredSolReviewReceipt({
		reviewer: { provider: STRUCTURED_SOL_REVIEW_PROVIDER, model: STRUCTURED_SOL_REVIEW_MODEL, api: STRUCTURED_SOL_REVIEW_API },
		decision: "ACCEPT",
	}), false);

	const fake = fakeRegistry((index, context) => index < 2 ? passPage(context) : finalFromContext(context));
	const result = await runStructuredSolReview(reviewInput(fake.registry));
	assert.equal(result.ok, true);
	const changedPage = structuredClone(result.receipt) as unknown as { pages: Array<{ page_content_sha256: string }> };
	changedPage.pages[0]!.page_content_sha256 = "e".repeat(64);
	assert.equal(validateStructuredSolReviewReceipt(changedPage), false);
	const changedUsage = structuredClone(result.receipt) as unknown as { nested_usage: Usage };
	changedUsage.nested_usage.input += 1;
	assert.equal(validateStructuredSolReviewReceipt(changedUsage), false);

	const earlyFinal = structuredClone(result.receipt) as unknown as Record<string, unknown>;
	const pageAssessmentSetHash = canonicalHash([]);
	const semanticEnvelope = earlyFinal.semantic_envelope as Record<string, unknown>;
	earlyFinal.calls = [{
		call_index: 1,
		stage: "final",
		page_number: null,
		request_hash: canonicalHash({
			protocol: STRUCTURED_SOL_REVIEW_KIND,
			stage: "final",
			request_policy_hash: STRUCTURED_SOL_REVIEW_REQUEST_POLICY_HASH,
			delegation_id: earlyFinal.delegation_id,
			contract_hash: earlyFinal.contract_hash,
			bound_diff_hash: earlyFinal.bound_diff_hash,
			stream_set_hash: semanticEnvelope.stream_set_hash,
			relevance_projection_hash: semanticEnvelope.relevance_projection_hash,
			page_assessment_set_hash: pageAssessmentSetHash,
			reviewed_page_count: 0,
		}),
		outcome: "MODEL_ERROR",
		response: null,
		response_hash: null,
		usage: null,
		usage_hash: null,
		assessment_hash: null,
		error_hash: "e".repeat(64),
	}];
	earlyFinal.page_assessments = [];
	earlyFinal.page_assessment_set_hash = pageAssessmentSetHash;
	earlyFinal.final_assessment = null;
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	earlyFinal.nested_usage = zero;
	earlyFinal.nested_usage_hash = canonicalHash(zero);
	earlyFinal.completed = false;
	earlyFinal.decision = "REPAIR";
	earlyFinal.terminal_code = "MODEL_ERROR";
	const { receipt_hash: _oldHash, ...earlyFinalUnsigned } = earlyFinal;
	earlyFinal.receipt_hash = canonicalHash(earlyFinalUnsigned);
	assert.equal(validateStructuredSolReviewReceipt(earlyFinal), false, "a final call cannot occur before every page assessment");
});

test("usage aggregation overflow remains fail-closed and preserves the offending call in a valid receipt", async () => {
	const first: Usage = {
		input: Number.MAX_SAFE_INTEGER - 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: Number.MAX_SAFE_INTEGER - 5,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const second: Usage = {
		input: 20,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 25,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const fake = fakeRegistry((index, context) => passPage(context, index === 0 ? first : second));
	const result = await runStructuredSolReview(reviewInput(fake.registry));

	assert.equal(result.ok, false);
	assert.equal(result.code, "INVALID_USAGE");
	assert.equal(result.usage.input, first.input);
	assert.equal(result.receipt?.calls.length, 2);
	assert.equal(result.receipt?.calls[1]?.outcome, "INVALID_USAGE");
	assert.deepEqual(result.receipt?.calls[1]?.usage, second);
	assert.equal(validateStructuredSolReviewReceipt(result.receipt), true);
});

test("page assessment aggregation is byte-bounded before the final model call", async () => {
	const pageCount = 512;
	const fake = fakeRegistry((index, context) => {
		const payload = requestPayload(context);
		const page = payload.page as Record<string, unknown>;
		return assistant(STRUCTURED_SOL_PAGE_TOOL_NAME, {
			page_content_sha256: page.page_content_sha256,
			decision: "REPAIR",
			summary: "s".repeat(400),
			findings: [{
				finding_id: `P${index + 1}-F1`,
				severity: "BLOCKING",
				category: "OTHER",
				title: "t".repeat(160),
				evidence: "e".repeat(800),
				recommendation: "r".repeat(800),
			}],
		});
	});
	const input = reviewInput(fake.registry, [{ path: "src/large.ts", parts: Array.from({ length: pageCount }, () => "x") }]);
	const result = await runStructuredSolReview(input);

	assert.equal(result.ok, false);
	assert.equal(result.code, "ASSESSMENT_AGGREGATE_LIMIT");
	assert.equal(fake.calls.length, pageCount, "the final model call is never opened");
	assert.equal(result.receipt?.calls.length, pageCount);
	assert.equal(validateStructuredSolReviewReceipt(result.receipt), true);
	assert.ok(Buffer.byteLength(JSON.stringify(result.receipt?.page_assessments), "utf8") > STRUCTURED_SOL_REVIEW_MAX_ASSESSMENT_AGGREGATE_BYTES);
});

test("V2 batches 47 pages into six bounded calls plus one raw-free final call", async () => {
	const fake = fakeRegistry((index, context) => index < 6 ? passBatch(context) : finalFromContext(context));
	const base = reviewInput(fake.registry, [{ path: "src/long.ts", parts: Array.from({ length: 47 }, (_, index) => `page-${index + 1}\n`) }]);
	const progress: unknown[] = [];
	const result = await runStructuredSolReviewBatchedV2({
		...base,
		generation: 1,
		on_progress: (value) => { progress.push(structuredClone(value)); },
	});

	assert.equal(result.status, "ACCEPT");
	assert.equal(fake.calls.length, 7);
	assert.equal(fake.calls.slice(0, 6).every((call) => call.context.tools?.[0] === STRUCTURED_SOL_BATCH_REVIEW_TOOL), true);
	assert.equal(fake.calls.at(-1)?.context.tools?.[0], STRUCTURED_SOL_FINAL_REVIEW_TOOL_V2);
	assert.equal(result.progress.batches.length, 6);
	assert.deepEqual(result.progress.batches.map((batch) => batch.assessments.length), [8, 8, 8, 8, 8, 7]);
	assert.equal(result.page_assessments.length, 47);
	assert.equal(new Set(result.page_assessments.map((assessment) => assessment.page_content_sha256)).size, 47);
	assert.equal(validateSemanticReviewProgressV2(result.progress), true);
	assert.equal(progress.every(validateSemanticReviewProgressV2), true);
	const firstBatchPayload = requestPayload(fake.calls[0]!.context);
	assert.match(String(firstBatchPayload.instruction), /W is attributed worker delta/u);
	assert.match(String(firstBatchPayload.instruction), /D\/S-only entries are read-only context/u);
	assert.match(String(firstBatchPayload.instruction), /must never be reported as worker changes or scope violations/u);
	const finalPayload = requestPayload(fake.calls.at(-1)!.context);
	assert.equal(JSON.stringify(finalPayload).includes("page-1\\n"), false, "raw page content is absent from final context");
	assert.match(STRUCTURED_SOL_REVIEW_BATCH_REQUEST_POLICY_HASH_V2, /^[0-9a-f]{64}$/u);
});

test("V2 resume after the batch containing page 17 skips every completed batch", async () => {
	const first = fakeRegistry((index, context) => {
		if (index === 2) throw new Error("provider unavailable after page 16");
		return passBatch(context);
	});
	const fixture = [{ path: "src/long.ts", parts: Array.from({ length: 47 }, (_, index) => `segment-${index}\n`) }];
	const interrupted = await runStructuredSolReviewBatchedV2({ ...reviewInput(first.registry, fixture), generation: 1 });
	assert.equal(interrupted.status, "RETRYABLE_FAILURE");
	assert.equal(first.calls.length, 3);
	assert.deepEqual(interrupted.progress.batches.map((batch) => batch.status).slice(0, 3), ["COMPLETED", "COMPLETED", "RETRYABLE_FAILURE"]);

	const resumed = fakeRegistry((index, context) => index < 4 ? passBatch(context) : finalFromContext(context));
	const completed = await runStructuredSolReviewBatchedV2({
		...reviewInput(resumed.registry, fixture),
		generation: 1,
		resume_progress: interrupted.progress,
	});
	assert.equal(completed.status, "ACCEPT");
	assert.equal(resumed.calls.length, 5, "only batches 3-6 and one fresh final call run");
	assert.equal(completed.progress.batches.every((batch) => batch.status === "COMPLETED"), true);
});

test("V2 inherited-only review performs zero page calls and one fresh cross-file final call", async () => {
	const fake = fakeRegistry((_index, context) => finalFromContext(context));
	const base = reviewInput(fake.registry, [{ path: "src/stable.ts", parts: ["stable\n"] }]);
	const result = await runStructuredSolReviewBatchedV2({
		...base,
		generation: 2,
		fresh_paths: [],
		inherited_proof_summary: {
			parent_evidence_hash: "a".repeat(64),
			inherited_stream_count: 1,
			inherited_stream_set_hash: "b".repeat(64),
			dependency_closure_hash: "c".repeat(64),
		},
	});
	assert.equal(result.status, "ACCEPT");
	assert.equal(fake.calls.length, 1);
	assert.equal(result.progress.batches.length, 0);
	assert.equal("page_assessments" in result ? result.page_assessments.length : -1, 0);
});

test("V2 accepts carried D streams while reviewing only the fresh W delta", async () => {
	const fake = fakeRegistry((index, context) => index === 0 ? passBatch(context) : finalFromContext(context));
	const base = reviewInput(fake.registry, [
		{ path: "src/inherited.ts", parts: ["stable\n"] },
		{ path: "src/repaired.ts", parts: ["fixed\n"] },
	]);
	const relevanceProjection = {
		...base.relevance_projection,
		entries: base.relevance_projection.entries.map((entry) => ({
			...entry,
			roles: entry.path === "src/inherited.ts" ? ["D" as const] : ["W" as const],
		})),
	};
	const boundDiffHash = computeReviewRelevanceProjectionHashV2(relevanceProjection);
	const envelope = buildSemanticReviewEnvelopeV1({
		streams: base.streams,
		projected_review_record_bytes: base.semantic_envelope.projected_review_record_bytes,
		relevance_projection_hash: boundDiffHash,
	});
	assert.equal(envelope.ok, true);
	if (!envelope.ok) return;
	const result = await runStructuredSolReviewBatchedV2({
		...base,
		generation: 2,
		bound_diff_hash: boundDiffHash,
		relevance_projection: relevanceProjection,
		semantic_envelope: envelope.value,
		fresh_paths: ["src/repaired.ts"],
		inherited_proof_summary: {
			parent_evidence_hash: "a".repeat(64),
			inherited_stream_count: 1,
			inherited_stream_set_hash: "b".repeat(64),
			dependency_closure_hash: "c".repeat(64),
		},
	});
	assert.equal(result.status, "ACCEPT");
	assert.equal(fake.calls.length, 2, "one fresh batch plus one raw-free final call");
	assert.equal("page_assessments" in result ? result.page_assessments.length : -1, 1);
});

test("V2 rejects duplicate batch coverage and returns SPLIT_REQUIRED above the explicit large ceiling", async () => {
	const duplicate = fakeRegistry((_index, context) => {
		const payload = requestPayload(context);
		const pages = payload.pages as Array<{ page_binding_hash: string; page: { page_content_sha256: string } }>;
		return assistant(STRUCTURED_SOL_BATCH_REVIEW_TOOL_NAME, {
			assessments: pages.map((page) => ({
				page_binding_hash: page.page_binding_hash,
				page_content_sha256: pages[0]!.page.page_content_sha256,
				decision: "PASS",
				summary: "Duplicate response.",
				findings: [],
			})),
		});
	});
	const invalid = await runStructuredSolReviewBatchedV2({
		...reviewInput(duplicate.registry, [{ path: "src/a.ts", parts: ["a", "b"] }]),
		generation: 1,
	});
	assert.equal(invalid.status, "RETRYABLE_FAILURE");
	assert.equal(invalid.code, "INVALID_TOOL_RESPONSE");

	const unused = fakeRegistry((_index, context) => passBatch(context));
	const oversized = await runStructuredSolReviewBatchedV2({
		...reviewInput(unused.registry, [{ path: "src/huge.ts", parts: Array.from({ length: 129 }, () => "x") }]),
		generation: 1,
		capacity: "large",
	});
	assert.equal(oversized.status, "SPLIT_REQUIRED");
	assert.equal(unused.calls.length, 0);
});
