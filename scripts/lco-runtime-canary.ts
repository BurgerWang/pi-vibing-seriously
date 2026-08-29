/** Deterministic WP7 synthetic canary for the loaded LCO V2 review protocol. */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";

import { bindDelegationBoundedTaskContractV2 } from "../extensions/workbench-runtime/core/delegation-transaction-artifacts.ts";
import { computeReviewRelevanceProjectionHashV2 } from "../extensions/workbench-runtime/core/review-relevance-v2.ts";
import { WORKBENCH_RUNTIME_BUILD_IDENTITY } from "../extensions/workbench-runtime/core/runtime-build-identity.ts";
import { buildSemanticReviewEnvelopeV1 } from "../extensions/workbench-runtime/core/semantic-review-envelope.ts";
import {
	STRUCTURED_SOL_BATCH_REVIEW_TOOL_NAME,
	STRUCTURED_SOL_FINAL_TOOL_NAME,
	STRUCTURED_SOL_REVIEW_API,
	STRUCTURED_SOL_REVIEW_MODEL,
	STRUCTURED_SOL_REVIEW_PROVIDER,
	runStructuredSolReviewBatchedV2,
	type RunStructuredSolReviewInput,
	type SemanticReviewProgressV2,
	type StructuredSolFinding,
} from "../extensions/workbench-runtime/core/structured-sol-review.ts";

interface Fixture {
	materializer: { payload_character: string; payload_bytes_per_page: number };
	streams: Array<{ stream_id: string; path: string; pages: number }>;
}

const DELEGATION_ID = "20260829-150000-LCO7";
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

function usage(): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 2,
		cacheWrite: 1,
		reasoning: 3,
		totalTokens: 18,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
	};
}

function requestPayload(context: Context): Record<string, unknown> {
	const message = context.messages[0];
	if (message?.role !== "user" || !Array.isArray(message.content) || message.content[0]?.type !== "text") {
		throw new Error("invalid canary request context");
	}
	return JSON.parse(message.content[0].text) as Record<string, unknown>;
}

function assistant(toolName: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "deterministic synthetic canary" },
			{ type: "toolCall", id: "lco-canary-call", name: toolName, arguments: args },
		],
		api: STRUCTURED_SOL_REVIEW_API,
		provider: STRUCTURED_SOL_REVIEW_PROVIDER,
		model: STRUCTURED_SOL_REVIEW_MODEL,
		responseModel: STRUCTURED_SOL_REVIEW_MODEL,
		responseId: "lco-canary-response",
		usage: usage(),
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function passBatch(context: Context): AssistantMessage {
	const payload = requestPayload(context);
	const pages = payload.pages as Array<{ page_binding_hash: string; page: { page_content_sha256: string } }>;
	return assistant(STRUCTURED_SOL_BATCH_REVIEW_TOOL_NAME, {
		assessments: pages.map(({ page_binding_hash, page }) => ({
			page_binding_hash,
			page_content_sha256: page.page_content_sha256,
			decision: "PASS",
			summary: "Synthetic page passed deterministic review.",
			findings: [],
		})),
	});
}

function finalAssessment(context: Context): AssistantMessage {
	const payload = requestPayload(context);
	const assessments = payload.page_assessments as Array<{ findings: StructuredSolFinding[] }>;
	const blocking = assessments.flatMap((assessment) => assessment.findings)
		.filter((finding) => finding.severity === "BLOCKING")
		.map((finding) => finding.finding_id)
		.sort();
	return assistant(STRUCTURED_SOL_FINAL_TOOL_NAME, {
		page_assessment_set_hash: payload.page_assessment_set_hash,
		reviewed_page_count: assessments.length,
		decision: "ACCEPT",
		summary: "All synthetic streams passed deterministic cross-file review.",
		repair_reason: null,
		blocking_finding_ids: blocking,
		cross_page_findings: [],
	});
}

function registry(
	responder: (index: number, context: Context) => AssistantMessage | Promise<AssistantMessage>,
): { model_registry: RunStructuredSolReviewInput["model_registry"]; contexts: Context[] } {
	const contexts: Context[] = [];
	const model_registry = {
		find(provider: string, modelId: string) {
			return provider === STRUCTURED_SOL_REVIEW_PROVIDER && modelId === STRUCTURED_SOL_REVIEW_MODEL ? MODEL : undefined;
		},
		hasConfiguredAuth(model: Model<Api>) { return model === MODEL; },
		async complete(_model: Model<Api>, context: Context) {
			const index = contexts.length;
			contexts.push(context);
			return responder(index, context);
		},
	} as unknown as RunStructuredSolReviewInput["model_registry"];
	return { model_registry, contexts };
}

async function inputFor(model_registry: RunStructuredSolReviewInput["model_registry"]) {
	const fixture = JSON.parse(await readFile(new URL("../tests/fixtures/lco-long-chain-replay-v1.json", import.meta.url), "utf8")) as Fixture;
	const payload = fixture.materializer.payload_character.repeat(fixture.materializer.payload_bytes_per_page);
	const materialized = fixture.streams.map((stream, streamIndex) => ({
		path: stream.path,
		parts: Array.from({ length: stream.pages }, (_, pageIndex) =>
			`SYNTHETIC_LCO_STREAM_${streamIndex + 1}_PAGE_${pageIndex + 1}\n${payload}\n`),
	})).sort((left, right) => Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")));
	const streams = materialized.map(({ path, parts }) => {
		const content = parts.join("");
		return {
			path,
			source: "file-content" as const,
			stream_bytes: Buffer.byteLength(content, "utf8"),
			stream_sha256: sha256(content),
			page_count: parts.length,
		};
	});
	const pages = materialized.flatMap(({ path, parts }, streamIndex) => {
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
		task: "Run the deterministic LCO synthetic runtime canary.",
		allowed_paths: ["synthetic/**"],
		acceptance_criteria: ["Every synthetic page is reviewed exactly once."],
		verification: ["Verify resume and final assessment invariants."],
		timeout_seconds: 600,
		budget_profile: "standard",
	});
	if (!contract.ok) throw new Error("canary contract failed");
	const relevance_projection = {
		schema_version: 2 as const,
		diff_identity_kind: "changeset-relevance-v2" as const,
		delegation_id: DELEGATION_ID,
		contract_hash: contract.value.contract_hash,
		change_set_hash: "a".repeat(64),
		worker_delta_hash: "b".repeat(64),
		git_head: "c".repeat(40),
		entries: streams.map((stream, index) => ({
			path: stream.path,
			roles: ["W"] as const,
			status: "M",
			full_identity: {
				schema_version: 2 as const,
				kind: "file" as const,
				path: stream.path,
				byte_size: stream.stream_bytes,
				sha256: stream.stream_sha256,
				stat: { dev: "1", ino: String(index + 1), mtime_ns: "1", ctime_ns: "1" },
			},
		})),
	};
	const bound_diff_hash = computeReviewRelevanceProjectionHashV2(relevance_projection);
	const semantic_envelope = buildSemanticReviewEnvelopeV1({
		streams,
		projected_review_record_bytes: 1_024,
		relevance_projection_hash: bound_diff_hash,
	});
	if (!semantic_envelope.ok) throw new Error("canary envelope failed");
	return {
		fixture,
		review: {
			delegation_id: DELEGATION_ID,
			generation: 1,
			contract_hash: contract.value.contract_hash,
			bound_diff_hash,
			contract: contract.value,
			relevance_projection,
			semantic_envelope: semantic_envelope.value,
			streams,
			pages,
			model_registry,
			now: () => new Date("2026-08-29T08:00:00.000Z"),
		},
	};
}

async function main(): Promise<void> {
	const started = performance.now();
	const interruptedRegistry = registry((index, context) => {
		if (index === 2) throw new Error("synthetic provider interruption at page 17");
		return passBatch(context);
	});
	const firstInput = await inputFor(interruptedRegistry.model_registry);
	const interrupted = await runStructuredSolReviewBatchedV2(firstInput.review);
	if (interrupted.status !== "RETRYABLE_FAILURE" || interrupted.code !== "MODEL_ERROR") {
		throw new Error("synthetic interruption did not fail retryably");
	}

	const resumedRegistry = registry((index, context) => index < 4 ? passBatch(context) : finalAssessment(context));
	const resumedInput = await inputFor(resumedRegistry.model_registry);
	const completed = await runStructuredSolReviewBatchedV2({
		...resumedInput.review,
		resume_progress: interrupted.progress as Readonly<SemanticReviewProgressV2>,
	});
	if (completed.status !== "ACCEPT") throw new Error(`synthetic resume ended ${completed.status}`);
	const resumedOrdinals = resumedRegistry.contexts.slice(0, -1).map((context) => Number(requestPayload(context).batch_ordinal));
	const finalPrompt = JSON.stringify(requestPayload(resumedRegistry.contexts.at(-1)!));
	const summary = {
		schema_version: 1,
		kind: "lco-runtime-canary-result-v1",
		runtime_identity: WORKBENCH_RUNTIME_BUILD_IDENTITY,
		fixture: { streams: resumedInput.fixture.streams.length, pages: resumedInput.review.pages.length },
		interruption: {
			at_first_page: 17,
			calls_before_return: interruptedRegistry.contexts.length,
			completed_batches: interrupted.progress.batches.filter((batch) => batch.status === "COMPLETED").length,
		},
		resume: {
			batch_ordinals: resumedOrdinals,
			calls: resumedRegistry.contexts.length,
			completed_batch_replay_count: resumedOrdinals.filter((ordinal) => ordinal < 3).length,
			final_calls: 1,
			decision: completed.status,
			raw_page_content_in_final: finalPrompt.includes("SYNTHETIC_LCO_STREAM_"),
		},
		quality: {
			unique_page_assessments: new Set(completed.page_assessments.map((assessment) => assessment.page_content_sha256)).size,
			blocking_findings: completed.final_assessment.blocking_finding_ids.length,
		},
		usage: completed.usage,
		wall_ms: Math.round((performance.now() - started) * 1000) / 1000,
	};
	if (summary.fixture.streams !== 42 || summary.fixture.pages !== 47
		|| summary.resume.completed_batch_replay_count !== 0 || summary.resume.final_calls !== 1
		|| summary.resume.raw_page_content_in_final || summary.quality.unique_page_assessments !== 47) {
		throw new Error("synthetic canary invariant failed");
	}
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

await main();
