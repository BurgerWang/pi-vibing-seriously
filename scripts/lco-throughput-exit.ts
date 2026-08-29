import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const LCO_THROUGHPUT_EXIT_VERSION = 1 as const;

interface Baseline {
	classification: {
		requests: readonly { category: string; requests: number; cost_usd: number }[];
	};
	wall_clock: { phases: readonly { category: string; minutes: number }[] };
	long_chain: {
		raw_tool_text_bytes_approx: number;
		raw_review_output_share: number;
		recipe_runs: number;
		recipe_process_seconds: number;
	};
}

interface Observation {
	runtime_source_hash: string;
	full_review: {
		review_wall_seconds: number;
		commander_requests: number;
		parent_visible_review_tool_calls: number;
		parent_visible_tool_result_text_bytes: number;
		commander_cost_usd: number;
		semantic_review_cost_usd: number;
		page_batches: number;
		final_model_calls: number;
		raw_page_bytes_in_final: number;
	};
	incremental_review: {
		review_wall_seconds: number;
		commander_requests: number;
		parent_visible_review_tool_calls: number;
		parent_visible_tool_result_text_bytes: number;
		commander_cost_usd: number;
		child_semantic_review_cost_usd: number;
		fresh_streams: number;
		inherited_streams: number;
	};
	lifecycle_snapshot: { serialized_utf8_bytes: number; limit_bytes: number };
	same_topology_replay: {
		ordinary_delegation_review_actions: number;
		no_worker_repair_calls: number;
		workbench_defect_repair_minutes: number;
		preserve_product_worker_minutes: boolean;
		preserve_orientation_status_coordination_minutes: boolean;
		preserve_recipe_count_and_process_time: boolean;
		checkpoint_continuation_repeated_review_count: number;
		evidence_class: string;
	};
}

const replacedRequestCategories = new Set(["DIFF_REVIEW", "STATUS", "DELEGATION_REPAIR"]);

function round(value: number, digits: number): number {
	return Number(value.toFixed(digits));
}

function phaseMinutes(baseline: Baseline, category: string): number {
	const row = baseline.wall_clock.phases.find((candidate) => candidate.category === category);
	if (!row) throw new Error(`missing baseline phase: ${category}`);
	return row.minutes;
}

export function computeLcoThroughputExitV1(baseline: Baseline, observation: Observation) {
	if (!observation.same_topology_replay.preserve_product_worker_minutes
		|| !observation.same_topology_replay.preserve_orientation_status_coordination_minutes
		|| !observation.same_topology_replay.preserve_recipe_count_and_process_time) {
		throw new Error("same-topology replay must preserve product work, coordination, and recipe workload");
	}
	const preservedRequests = baseline.classification.requests
		.filter((row) => !replacedRequestCategories.has(row.category))
		.reduce((sum, row) => sum + row.requests, 0);
	const preservedCommanderCost = baseline.classification.requests
		.filter((row) => !replacedRequestCategories.has(row.category))
		.reduce((sum, row) => sum + row.cost_usd, 0);
	const reviewWallMinutes = (observation.full_review.review_wall_seconds
		+ observation.incremental_review.review_wall_seconds) / 60;
	const wallMinutes = phaseMinutes(baseline, "PRODUCT_WORKER")
		+ phaseMinutes(baseline, "ORIENTATION_STATUS_COORDINATION")
		+ observation.same_topology_replay.workbench_defect_repair_minutes
		+ reviewWallMinutes;
	const commanderRequests = preservedRequests
		+ observation.full_review.commander_requests
		+ observation.incremental_review.commander_requests;
	const currentReviewBytes = observation.full_review.parent_visible_tool_result_text_bytes
		+ observation.incremental_review.parent_visible_tool_result_text_bytes;
	const preservedNonReviewBytes = Math.round(
		baseline.long_chain.raw_tool_text_bytes_approx * (1 - baseline.long_chain.raw_review_output_share),
	);
	const commanderToolTextBytes = preservedNonReviewBytes + currentReviewBytes;
	const reviewOutputShare = currentReviewBytes / commanderToolTextBytes;
	const reviewCommanderCost = observation.full_review.semantic_review_cost_usd
		+ observation.incremental_review.child_semantic_review_cost_usd
		+ observation.full_review.commander_cost_usd
		+ observation.incremental_review.commander_cost_usd;
	const commanderTotalCost = preservedCommanderCost + reviewCommanderCost;
	return Object.freeze({
		schema_version: LCO_THROUGHPUT_EXIT_VERSION,
		kind: "pi-workbench-lco-same-topology-throughput-exit-v1",
		evidence_class: observation.same_topology_replay.evidence_class,
		runtime_source_hash: observation.runtime_source_hash,
		preserved_workload: Object.freeze({
			product_worker_minutes: phaseMinutes(baseline, "PRODUCT_WORKER"),
			orientation_status_coordination_minutes: phaseMinutes(baseline, "ORIENTATION_STATUS_COORDINATION"),
			recipe_runs: baseline.long_chain.recipe_runs,
			recipe_process_seconds: baseline.long_chain.recipe_process_seconds,
		}),
		metrics: Object.freeze({
			wall_minutes: round(wallMinutes, 3),
			commander_requests: commanderRequests,
			commander_review_tool_calls: observation.full_review.parent_visible_review_tool_calls
				+ observation.incremental_review.parent_visible_review_tool_calls,
			ordinary_delegation_review_actions: observation.same_topology_replay.ordinary_delegation_review_actions,
			review_page_batches: observation.full_review.page_batches,
			final_model_calls: observation.full_review.final_model_calls,
			commander_tool_text_bytes: commanderToolTextBytes,
			review_output_share: round(reviewOutputShare, 6),
			active_review_snapshot_bytes: observation.lifecycle_snapshot.serialized_utf8_bytes,
			no_worker_repair_calls: observation.same_topology_replay.no_worker_repair_calls,
			review_commander_cost_usd: round(reviewCommanderCost, 6),
			commander_total_cost_usd: round(commanderTotalCost, 6),
			raw_page_bytes_in_final: observation.full_review.raw_page_bytes_in_final,
			checkpoint_continuation_repeated_review_count:
				observation.same_topology_replay.checkpoint_continuation_repeated_review_count,
		}),
	});
}

async function main(argv: readonly string[]): Promise<void> {
	const option = (name: string): string | undefined => {
		const index = argv.indexOf(name);
		return index < 0 ? undefined : argv[index + 1];
	};
	const baselinePath = option("--baseline");
	const observationsPath = option("--observations");
	if (!baselinePath || !observationsPath) {
		throw new Error("usage: lco-throughput-exit --baseline <json> --observations <json>");
	}
	const [baselineText, observationsText] = await Promise.all([
		readFile(resolve(baselinePath), "utf8"),
		readFile(resolve(observationsPath), "utf8"),
	]);
	process.stdout.write(`${JSON.stringify(computeLcoThroughputExitV1(
		JSON.parse(baselineText) as Baseline,
		JSON.parse(observationsText) as Observation,
	), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
	await main(process.argv.slice(2));
}
