/** Strict, pure ABBA canary report for Sol/Luna development experiments. */

export const WORKER_CANARY_SCHEMA = "workbench-sol-luna-abba-v1" as const;
/** Four trials/block yield two trials/arm; 12 blocks = 24 stratified tasks/arm. */
export const WORKER_CANARY_MIN_COMPLETE_BLOCKS = 12 as const;

export interface CanaryIdentitySide {
	provider: string | null;
	model: string | null;
	reasoning: string | null;
}

export interface CanaryIdentityPair {
	requested: CanaryIdentitySide;
	effective: CanaryIdentitySide;
}

export interface WorkerCanaryTrial {
	block_id: string;
	position: 1 | 2 | 3 | 4;
	arm: "A" | "B";
	task_family: string;
	commander: CanaryIdentityPair;
	worker: CanaryIdentityPair;
	elapsed_ms: number | null;
	first_accepted: boolean | null;
	repair_depth: number | null;
	review_bytes: number | null;
	/** True only for an untruncated packet or completed compact/segmented presentation. */
	review_presentation_complete: boolean | null;
	regressions: number | null;
	critical_defects: number | null;
	scope_defects: number | null;
	authority_defects: number | null;
	commander_tokens: number | null;
	worker_tokens: number | null;
}

export interface WorkerCanaryManifest {
	schema: typeof WORKER_CANARY_SCHEMA;
	variants: { A: string; B: string };
	trials: WorkerCanaryTrial[];
}

export interface CanaryMetricSummary {
	known: number;
	unknown: number;
	median: number | null;
	p90: number | null;
	total: number | null;
}

export interface CanaryRateSummary {
	known: number;
	unknown: number;
	positive: number;
	rate: number | null;
}

export interface CanaryArmSummary {
	trials: number;
	elapsed_ms: CanaryMetricSummary;
	first_accepted: CanaryRateSummary;
	repair_depth: CanaryMetricSummary;
	review_bytes: CanaryMetricSummary;
	review_presentation_complete: CanaryRateSummary;
	regressions: CanaryMetricSummary;
	critical_defects: CanaryMetricSummary;
	scope_defects: CanaryMetricSummary;
	authority_defects: CanaryMetricSummary;
	commander_tokens: CanaryMetricSummary;
	worker_tokens: CanaryMetricSummary;
	commander_identity_known: number;
	commander_identity_unknown: number;
	worker_identity_known: number;
	worker_identity_unknown: number;
}

export interface WorkerCanaryReport {
	schema: typeof WORKER_CANARY_SCHEMA;
	authority: "DESCRIPTIVE_ONLY";
	variants: { A: string; B: string };
	trial_count: number;
	complete_abba_blocks: number;
	incomplete_or_invalid_blocks: number;
	minimum_complete_blocks: typeof WORKER_CANARY_MIN_COMPLETE_BLOCKS;
	arms: { A: CanaryArmSummary; B: CanaryArmSummary };
	differences: {
		elapsed_ratio_b_over_a: number | null;
		first_accepted_rate_delta_b_minus_a: number | null;
		review_presentation_rate_delta_b_minus_a: number | null;
		regression_total_delta_b_minus_a: number | null;
		elapsed_p90_ratio_b_over_a: number | null;
	};
	decision: "NOT_EVALUABLE" | "TARGET_MET" | "TARGET_NOT_MET";
	reasons: string[];
}

const MANIFEST_KEYS = ["schema", "variants", "trials"] as const;
const VARIANT_KEYS = ["A", "B"] as const;
const TRIAL_KEYS = [
	"block_id", "position", "arm", "task_family", "commander", "worker", "elapsed_ms", "first_accepted",
	"repair_depth", "review_bytes", "review_presentation_complete", "regressions", "critical_defects", "scope_defects",
	"authority_defects", "commander_tokens", "worker_tokens",
] as const;
const PAIR_KEYS = ["requested", "effective"] as const;
const SIDE_KEYS = ["provider", "model", "reasoning"] as const;

function plainExact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const actual = Object.keys(value as object);
	return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function boundedLabel(value: unknown, max = 160): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function nullableLabel(value: unknown): value is string | null {
	return value === null || boundedLabel(value, 256);
}

function metric(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function positiveMetric(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function identitySide(value: unknown): value is CanaryIdentitySide {
	return plainExact(value, SIDE_KEYS)
		&& nullableLabel(value.provider) && nullableLabel(value.model) && nullableLabel(value.reasoning);
}

function identityPair(value: unknown): value is CanaryIdentityPair {
	return plainExact(value, PAIR_KEYS) && identitySide(value.requested) && identitySide(value.effective);
}

function trial(value: unknown): value is WorkerCanaryTrial {
	if (!plainExact(value, TRIAL_KEYS)) return false;
	return boundedLabel(value.block_id) && boundedLabel(value.task_family)
		&& (value.position === 1 || value.position === 2 || value.position === 3 || value.position === 4)
		&& (value.arm === "A" || value.arm === "B")
		&& identityPair(value.commander) && identityPair(value.worker)
		&& positiveMetric(value.elapsed_ms) && (value.first_accepted === null || typeof value.first_accepted === "boolean")
		&& metric(value.repair_depth) && metric(value.review_bytes)
		&& (value.review_presentation_complete === null || typeof value.review_presentation_complete === "boolean")
		&& metric(value.regressions) && metric(value.critical_defects) && metric(value.scope_defects)
		&& metric(value.authority_defects) && metric(value.commander_tokens) && metric(value.worker_tokens);
}

export function parseWorkerCanaryManifest(value: unknown): WorkerCanaryManifest | undefined {
	if (!plainExact(value, MANIFEST_KEYS) || value.schema !== WORKER_CANARY_SCHEMA) return undefined;
	if (!plainExact(value.variants, VARIANT_KEYS)
		|| !boundedLabel(value.variants.A, 500) || !boundedLabel(value.variants.B, 500)) return undefined;
	if (!Array.isArray(value.trials) || value.trials.length > 1_000 || !value.trials.every(trial)) return undefined;
	return structuredClone(value) as unknown as WorkerCanaryManifest;
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function p90(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)] ?? null;
}

function metricSummary(values: readonly (number | null)[]): CanaryMetricSummary {
	const known = values.filter((value): value is number => value !== null);
	return {
		known: known.length,
		unknown: values.length - known.length,
		median: median(known),
		p90: p90(known),
		total: known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0),
	};
}

function rateSummary(values: readonly (boolean | null)[]): CanaryRateSummary {
	const known = values.filter((value): value is boolean => value !== null);
	const positive = known.filter(Boolean).length;
	return { known: known.length, unknown: values.length - known.length, positive, rate: known.length === 0 ? null : positive / known.length };
}

function identityKnown(pair: CanaryIdentityPair): boolean {
	return [pair.requested.provider, pair.requested.model, pair.requested.reasoning,
		pair.effective.provider, pair.effective.model, pair.effective.reasoning].every((value) => value !== null);
}

function armSummary(rows: readonly WorkerCanaryTrial[]): CanaryArmSummary {
	const commanderKnown = rows.filter((row) => identityKnown(row.commander)).length;
	const workerKnown = rows.filter((row) => identityKnown(row.worker)).length;
	return {
		trials: rows.length,
		elapsed_ms: metricSummary(rows.map((row) => row.elapsed_ms)),
		first_accepted: rateSummary(rows.map((row) => row.first_accepted)),
		repair_depth: metricSummary(rows.map((row) => row.repair_depth)),
		review_bytes: metricSummary(rows.map((row) => row.review_bytes)),
		review_presentation_complete: rateSummary(rows.map((row) => row.review_presentation_complete)),
		regressions: metricSummary(rows.map((row) => row.regressions)),
		critical_defects: metricSummary(rows.map((row) => row.critical_defects)),
		scope_defects: metricSummary(rows.map((row) => row.scope_defects)),
		authority_defects: metricSummary(rows.map((row) => row.authority_defects)),
		commander_tokens: metricSummary(rows.map((row) => row.commander_tokens)),
		worker_tokens: metricSummary(rows.map((row) => row.worker_tokens)),
		commander_identity_known: commanderKnown,
		commander_identity_unknown: rows.length - commanderKnown,
		worker_identity_known: workerKnown,
		worker_identity_unknown: rows.length - workerKnown,
	};
}

function ratio(numerator: number | null, denominator: number | null): number | null {
	return numerator === null || denominator === null || denominator <= 0 ? null : numerator / denominator;
}

function difference(left: number | null, right: number | null): number | null {
	return left === null || right === null ? null : left - right;
}

export function buildWorkerCanaryReport(manifest: WorkerCanaryManifest): WorkerCanaryReport {
	const blocks = new Map<string, WorkerCanaryTrial[]>();
	for (const row of manifest.trials) blocks.set(row.block_id, [...(blocks.get(row.block_id) ?? []), row]);
	let completeBlocks = 0;
	const eligible: WorkerCanaryTrial[] = [];
	for (const rows of blocks.values()) {
		const ordered = [...rows].sort((left, right) => left.position - right.position);
		const valid = ordered.length === 4
			&& ordered.map((row) => row.position).join(",") === "1,2,3,4"
			&& ordered.map((row) => row.arm).join("") === "ABBA"
			&& new Set(ordered.map((row) => row.task_family)).size === 1;
		if (!valid) continue;
		completeBlocks += 1;
		eligible.push(...ordered);
	}
	const A = armSummary(eligible.filter((row) => row.arm === "A"));
	const B = armSummary(eligible.filter((row) => row.arm === "B"));
	const elapsedRatio = ratio(B.elapsed_ms.median, A.elapsed_ms.median);
	const firstDelta = difference(B.first_accepted.rate, A.first_accepted.rate);
	const presentationDelta = difference(B.review_presentation_complete.rate, A.review_presentation_complete.rate);
	const regressionDelta = difference(B.regressions.total, A.regressions.total);
	const p90Ratio = ratio(B.elapsed_ms.p90, A.elapsed_ms.p90);
	const reasons: string[] = [];
	const primaryComplete = [A, B].every((arm) => arm.elapsed_ms.unknown === 0
		&& arm.first_accepted.unknown === 0 && arm.review_presentation_complete.unknown === 0
		&& arm.repair_depth.unknown === 0 && arm.review_bytes.unknown === 0 && arm.regressions.unknown === 0
		&& arm.critical_defects.unknown === 0 && arm.scope_defects.unknown === 0 && arm.authority_defects.unknown === 0
		&& arm.commander_tokens.unknown === 0 && arm.worker_tokens.unknown === 0
		&& arm.commander_identity_unknown === 0 && arm.worker_identity_unknown === 0);
	let decision: WorkerCanaryReport["decision"] = "NOT_EVALUABLE";
	if (completeBlocks < WORKER_CANARY_MIN_COMPLETE_BLOCKS) reasons.push("insufficient_complete_abba_blocks");
	if (blocks.size !== completeBlocks) reasons.push("incomplete_or_invalid_abba_blocks");
	if (!primaryComplete) reasons.push("unknown_primary_or_identity_facts");
	if (completeBlocks >= WORKER_CANARY_MIN_COMPLETE_BLOCKS && blocks.size === completeBlocks && primaryComplete
		&& elapsedRatio !== null && p90Ratio !== null && firstDelta !== null && presentationDelta !== null && regressionDelta !== null) {
		if (elapsedRatio > 0.80) reasons.push("median_elapsed_improvement_below_20pct");
		if (p90Ratio > 1.10) reasons.push("elapsed_p90_regression_above_10pct");
		if (firstDelta < 0.10) reasons.push("first_accepted_gain_below_10pp");
		if (presentationDelta < 0) reasons.push("review_presentation_quality_regressed");
		if (regressionDelta > 0) reasons.push("regression_count_increased");
		if (B.critical_defects.total !== 0) reasons.push("critical_defect_observed");
		if (B.scope_defects.total !== 0) reasons.push("scope_defect_observed");
		if (B.authority_defects.total !== 0) reasons.push("authority_defect_observed");
		decision = reasons.length === 0 ? "TARGET_MET" : "TARGET_NOT_MET";
	}
	return {
		schema: WORKER_CANARY_SCHEMA,
		authority: "DESCRIPTIVE_ONLY",
		variants: { ...manifest.variants },
		trial_count: manifest.trials.length,
		complete_abba_blocks: completeBlocks,
		incomplete_or_invalid_blocks: blocks.size - completeBlocks,
		minimum_complete_blocks: WORKER_CANARY_MIN_COMPLETE_BLOCKS,
		arms: { A, B },
		differences: {
			elapsed_ratio_b_over_a: elapsedRatio,
			first_accepted_rate_delta_b_minus_a: firstDelta,
			review_presentation_rate_delta_b_minus_a: presentationDelta,
			regression_total_delta_b_minus_a: regressionDelta,
			elapsed_p90_ratio_b_over_a: p90Ratio,
		},
		decision,
		reasons,
	};
}
