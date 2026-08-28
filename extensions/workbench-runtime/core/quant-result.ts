/**
 * Quant result validation — the workbench's quant output contract.
 *
 * The workbench NEVER computes strategy metrics itself. It only validates
 * what the target project declares in its structured artifacts (by default
 * `results/quant-result.json`, per the project's recipes.yaml).
 *
 * The contract is documented as a machine-readable JSON Schema at
 * `schemas/quant-result.schema.json`; this module is the authoritative
 * enforcement of that contract:
 *
 *   - every number that appears must be a finite JSON number (NaN cannot be
 *     expressed in JSON, but `1e999` parses to Infinity and is rejected)
 *   - `folds` must be a non-empty array; EVERY fold is recorded in
 *     `fold_statuses`/`failed_folds` — failed folds are never filtered out
 *     (spec Q3/Q4: full trial reporting, failures must not be hidden)
 *   - profile-specific optional fields (stock-selection, market-timing) are
 *     validated when present and never required
 */

export interface QuantResultValidation {
	valid: boolean;
	errors: string[];
	warnings: string[];
	/** Every fold id → status (passed/failed/skipped/pending). Never filtered. */
	fold_statuses: Record<string, string>;
	/** Ids of folds whose status is "failed". Never filtered. */
	failed_folds: string[];
	/** Dot paths of fields that were verified. */
	checked: string[];
}

export const SPLIT_METHODS: readonly string[] = ["walk-forward", "train/validation/test", "time-series", "custom"];

export const FOLD_STATUSES: readonly string[] = ["passed", "failed", "skipped", "pending"];

export const RISK_ADJUSTED_METRICS: readonly string[] = ["sharpe", "sortino", "calmar", "information_ratio"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addError(v: QuantResultValidation, message: string): void {
	v.errors.push(message);
}

function checkString(v: QuantResultValidation, value: unknown, path: string): boolean {
	if (typeof value !== "string" || value.trim().length === 0) {
		addError(v, `${path} must be a non-empty string`);
		return false;
	}
	v.checked.push(path);
	return true;
}

function checkFiniteNumber(v: QuantResultValidation, value: unknown, path: string): boolean {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		addError(v, `${path} must be a finite number (got ${JSON.stringify(value)})`);
		return false;
	}
	v.checked.push(path);
	return true;
}

function checkOptionalNumber(v: QuantResultValidation, value: unknown, path: string): void {
	if (value === undefined) return;
	checkFiniteNumber(v, value, path);
}

function checkOptionalString(v: QuantResultValidation, value: unknown, path: string): void {
	if (value === undefined) return;
	checkString(v, value, path);
}

function checkOptionalObject(v: QuantResultValidation, value: unknown, path: string): value is Record<string, unknown> {
	if (!isRecord(value)) {
		addError(v, `${path} must be an object`);
		return false;
	}
	v.checked.push(path);
	return true;
}

/** Validate all number-like fields of an object that is expected to be a metrics block. */
function checkMetrics(v: QuantResultValidation, metrics: unknown, path: string, strict: boolean): void {
	if (!isRecord(metrics)) {
		addError(v, `${path} must be an object`);
		return;
	}
	const required = ["return", "volatility", "drawdown", "turnover", "exposure", "benchmark_delta"] as const;
	if (strict) {
		for (const key of required) {
			checkFiniteNumber(v, metrics[key], `${path}.${key}`);
		}
		const hasRiskAdjusted = RISK_ADJUSTED_METRICS.some((key) => metrics[key] !== undefined);
		if (!hasRiskAdjusted) {
			addError(v, `${path} needs at least one risk-adjusted metric: ${RISK_ADJUSTED_METRICS.join(", ")}`);
		} else {
			for (const key of RISK_ADJUSTED_METRICS) checkOptionalNumber(v, metrics[key], `${path}.${key}`);
		}
	} else {
		// Fold-level metrics are partial reports; only finiteness is enforced.
		for (const key of RISK_ADJUSTED_METRICS) checkOptionalNumber(v, metrics[key], `${path}.${key}`);
	}
	// Any other numeric field must be finite (pre/post cost, alpha, win_rate, ...).
	for (const [key, value] of Object.entries(metrics)) {
		if (strict && (required.includes(key as (typeof required)[number]) || RISK_ADJUSTED_METRICS.includes(key))) continue;
		if (typeof value === "number") checkFiniteNumber(v, value, `${path}.${key}`);
	}
}

/**
 * Validate a parsed quant-result artifact against the contract.
 * `value` must already be the result of JSON.parse (never model prose).
 */
export function validateQuantResult(value: unknown, options?: { profile?: string }): QuantResultValidation {
	const v: QuantResultValidation = { valid: true, errors: [], warnings: [], fold_statuses: {}, failed_folds: [], checked: [] };
	if (!isRecord(value)) {
		addError(v, "quant-result root must be a JSON object");
		v.valid = false;
		return v;
	}

	checkString(v, value.schema_version, "schema_version");
	checkString(v, value.run_id, "run_id");
	checkString(v, value.strategy_type, "strategy_type");
	checkString(v, value.frequency, "frequency");

	const universe = value.universe;
	if (typeof universe === "string") {
		checkString(v, universe, "universe");
	} else if (isRecord(universe)) {
		checkOptionalString(v, universe.name, "universe.name");
		v.checked.push("universe");
	} else {
		addError(v, "universe must be a string or an object");
	}

	const dataRange = value.data_range;
	if (!isRecord(dataRange)) {
		addError(v, "data_range must be an object { start, end }");
	} else {
		checkString(v, dataRange.start, "data_range.start");
		checkString(v, dataRange.end, "data_range.end");
	}

	const split = value.split;
	if (!isRecord(split)) {
		addError(v, "split must be an object with a method");
	} else {
		const method = split.method;
		if (typeof method !== "string" || !SPLIT_METHODS.includes(method)) {
			addError(v, `split.method must be one of ${SPLIT_METHODS.join(", ")}`);
		} else {
			v.checked.push("split.method");
		}
		if (split.train !== undefined && !checkOptionalObject(v, split.train, "split.train")) {
		}
		if (split.validation !== undefined && !checkOptionalObject(v, split.validation, "split.validation")) {
		}
		if (split.test !== undefined && !checkOptionalObject(v, split.test, "split.test")) {
		}
		if (split.walk_forward !== undefined && !checkOptionalObject(v, split.walk_forward, "split.walk_forward")) {
		}
	}

	const benchmark = value.benchmark;
	if (!isRecord(benchmark)) {
		addError(v, "benchmark must be an object with a name");
	} else {
		checkString(v, benchmark.name, "benchmark.name");
		checkOptionalNumber(v, benchmark.return, "benchmark.return");
	}

	const costs = value.costs;
	if (!isRecord(costs)) {
		addError(v, "costs must be an object");
	} else {
		for (const [key, item] of Object.entries(costs)) {
			if (typeof item === "number") checkFiniteNumber(v, item, `costs.${key}`);
		}
		v.checked.push("costs");
	}

	checkMetrics(v, value.metrics, "metrics", true);

	const folds = value.folds;
	if (!Array.isArray(folds) || folds.length === 0) {
		addError(v, "folds must be a non-empty array (full trial reporting)");
	} else {
		v.checked.push(`folds.length`);
		const seen = new Set<string>();
		folds.forEach((fold, index) => {
			const path = `folds[${index}]`;
			if (!isRecord(fold)) {
				addError(v, `${path} must be an object`);
				return;
			}
			const id = fold.id;
			if (typeof id !== "string" || id.trim().length === 0) {
				addError(v, `${path}.id must be a non-empty string`);
				return;
			}
			if (seen.has(id)) {
				addError(v, `${path}.id "${id}" is duplicated across folds`);
				return;
			}
			seen.add(id);
			const status = fold.status;
			if (typeof status !== "string" || !FOLD_STATUSES.includes(status)) {
				addError(v, `${path}.status must be one of ${FOLD_STATUSES.join(", ")}`);
				return;
			}
			// Every fold is recorded — including failed ones. Nothing is filtered.
			v.fold_statuses[id] = status;
			if (status === "failed") v.failed_folds.push(id);
			if (status === "passed" && fold.metrics === undefined) {
				addError(v, `${path}.metrics is required when status is "passed"`);
			}
			if (fold.period !== undefined && !checkOptionalObject(v, fold.period, `${path}.period`)) {
			}
			if (fold.parameters !== undefined && !checkOptionalObject(v, fold.parameters, `${path}.parameters`)) {
			}
			if (fold.metrics !== undefined) checkMetrics(v, fold.metrics, `${path}.metrics`, false);
		});
	}

	const parameters = value.parameters;
	if (!isRecord(parameters)) {
		addError(v, "parameters must be an object");
	} else {
		for (const [key, item] of Object.entries(parameters)) {
			if (typeof item === "number") checkFiniteNumber(v, item, `parameters.${key}`);
		}
		v.checked.push("parameters");
	}

	const artifacts = value.artifacts;
	if (!Array.isArray(artifacts) || artifacts.some((a) => typeof a !== "string" || a.trim().length === 0)) {
		addError(v, "artifacts must be an array of non-empty strings");
	} else {
		v.checked.push("artifacts");
	}

	if (value.warnings !== undefined) {
		if (!Array.isArray(value.warnings) || value.warnings.some((w) => typeof w !== "string")) {
			addError(v, "warnings must be an array of strings");
		} else {
			v.checked.push("warnings");
		}
	}

	if (value.semantics !== undefined) {
		if (checkOptionalObject(v, value.semantics, "semantics")) {
			for (const [key, item] of Object.entries(value.semantics)) {
				if (typeof item === "number") checkFiniteNumber(v, item, `semantics.${key}`);
			}
		}
	}

	// Profile-specific optional fields — validated when present, never required.
	const profile = options?.profile;
	if (profile === "quant-research/stock-selection") {
		if (isRecord(universe) && universe.point_in_time !== undefined) {
			const pit = universe.point_in_time;
			if (typeof pit !== "boolean" && !isRecord(pit)) {
				addError(v, "universe.point_in_time must be a boolean or object");
			} else {
				v.checked.push("universe.point_in_time");
			}
		}
		if (value.exposure !== undefined) {
			if (!isRecord(value.exposure)) {
				addError(v, "exposure must be an object");
			} else {
				checkOptionalNumber(v, value.exposure.industry, "exposure.industry");
				checkOptionalNumber(v, value.exposure.market_cap, "exposure.market_cap");
				v.checked.push("exposure");
			}
		}
		if (value.rebalance !== undefined && checkOptionalObject(v, value.rebalance, "rebalance")) {
			checkOptionalString(v, value.rebalance.frequency, "rebalance.frequency");
			checkOptionalNumber(v, value.rebalance.turnover_target, "rebalance.turnover_target");
		}
	} else if (profile === "quant-research/market-timing") {
		if (value.regime !== undefined && checkOptionalObject(v, value.regime, "regime")) {
			if (value.regime.states !== undefined && !Array.isArray(value.regime.states)) {
				addError(v, "regime.states must be an array");
			}
		}
		if (value.position_sizing !== undefined && checkOptionalObject(v, value.position_sizing, "position_sizing")) {
			checkOptionalString(v, value.position_sizing.method, "position_sizing.method");
			checkOptionalNumber(v, value.position_sizing.max_position, "position_sizing.max_position");
		}
	}

	v.valid = v.errors.length === 0;
	return v;
}

type TimeRange = { start: number; end: number };

function strictTimeRange(v: QuantResultValidation, value: unknown, path: string): TimeRange | null {
	if (!isRecord(value) || typeof value.start !== "string" || typeof value.end !== "string") {
		addError(v, `${path} must be an object with string start/end timestamps`);
		return null;
	}
	const start = Date.parse(value.start);
	const end = Date.parse(value.end);
	if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
		addError(v, `${path} must have parseable start < end timestamps`);
		return null;
	}
	v.checked.push(`${path}.start`, `${path}.end`);
	return { start, end };
}

function strictLeakageControl(v: QuantResultValidation, value: unknown, path: string): void {
	if (value === null) {
		v.checked.push(path);
		return;
	}
	if (!isRecord(value) || typeof value.periods !== "number" || !Number.isSafeInteger(value.periods) || value.periods < 0 ||
		typeof value.unit !== "string" || value.unit.trim().length === 0) {
		addError(v, `${path} must be null (not applicable) or { periods: non-negative integer, unit: non-empty string }`);
		return;
	}
	v.checked.push(`${path}.periods`, `${path}.unit`);
}

/**
 * WP5 Q4 machine contract. It builds on the base result contract, then proves
 * explicit chronological train/validation/test ordering for the overall split
 * and every retained fold, ordered non-overlapping fold tests, declared
 * gap/embargo applicability, and content-addressed parameter-stability refs.
 */
export function validateQuantResearchEvidence(value: unknown, options?: { profile?: string }): QuantResultValidation {
	const v = validateQuantResult(value, options);
	if (!isRecord(value)) return v;
	const split = value.split;
	if (!isRecord(split)) {
		v.valid = false;
		return v;
	}
	const train = strictTimeRange(v, split.train, "split.train");
	const validation = split.validation === undefined ? null : strictTimeRange(v, split.validation, "split.validation");
	const test = strictTimeRange(v, split.test, "split.test");
	if (train && test) {
		if (validation) {
			if (train.end >= validation.start || validation.end >= test.start) addError(v, "split chronology must be train < validation < test with no overlap");
		} else if (train.end >= test.start) {
			addError(v, "split chronology must be train < test with no overlap");
		}
	}
	if (!("gap" in split)) addError(v, "split.gap must explicitly declare a control or null when not applicable");
	else strictLeakageControl(v, split.gap, "split.gap");
	if (!("embargo" in split)) addError(v, "split.embargo must explicitly declare a control or null when not applicable");
	else strictLeakageControl(v, split.embargo, "split.embargo");

	let previousTestEnd: number | undefined;
	if (Array.isArray(value.folds)) {
		if (value.folds.length < 2) addError(v, "folds must contain at least two time-ordered out-of-sample folds");
		value.folds.forEach((fold, index) => {
			if (!isRecord(fold)) return;
			const path = `folds[${index}].period`;
			if (!isRecord(fold.period)) {
				addError(v, `${path} must bind train/test time ranges`);
				return;
			}
			const foldTrain = strictTimeRange(v, fold.period.train, `${path}.train`);
			const foldValidation = fold.period.validation === undefined ? null : strictTimeRange(v, fold.period.validation, `${path}.validation`);
			const foldTest = strictTimeRange(v, fold.period.test, `${path}.test`);
			if (foldTrain && foldTest) {
				if (foldValidation) {
					if (foldTrain.end >= foldValidation.start || foldValidation.end >= foldTest.start) addError(v, `${path} chronology must be train < validation < test with no overlap`);
				} else if (foldTrain.end >= foldTest.start) {
					addError(v, `${path} chronology must be train < test with no overlap`);
				}
			}
			if (foldTest) {
				if (previousTestEnd !== undefined && previousTestEnd >= foldTest.start) addError(v, `${path}.test must follow the prior fold test without overlap`);
				previousTestEnd = foldTest.end;
			}
		});
	}

	const stability = value.parameter_stability;
	if (!isRecord(stability) || !Array.isArray(stability.references) || stability.references.length === 0) {
		addError(v, "parameter_stability.references must be a non-empty array of content-addressed evidence refs");
	} else {
		for (let index = 0; index < stability.references.length; index += 1) {
			const reference = stability.references[index];
			const path = `parameter_stability.references[${index}]`;
			if (!isRecord(reference) || typeof reference.path !== "string" || reference.path.length === 0 ||
				reference.path.startsWith("/") || reference.path.split("/").includes("..") ||
				typeof reference.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(reference.sha256)) {
				addError(v, `${path} must contain a safe project-relative path and 64-hex sha256`);
			} else {
				v.checked.push(`${path}.path`, `${path}.sha256`);
			}
		}
	}
	v.valid = v.errors.length === 0;
	return v;
}
