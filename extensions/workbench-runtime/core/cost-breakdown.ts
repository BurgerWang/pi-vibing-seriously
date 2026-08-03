/**
 * Split session-cost observability (Unreleased) — pure, defensive.
 *
 * Mirrors Pi's default footer cost aggregation (dist/.../modes/interactive/
 * components/footer.js + dist/core/usage-totals.js) EXACTLY over session
 * entries, then splits the single running total into three buckets:
 *
 *   commander (S) — assistant message usage, additionally grouped per
 *                   `${provider}/${responseModel ?? model}` (same key Pi's
 *                   getUsageCostBreakdown uses)
 *   worker    (W) — toolResult usage whose toolName is
 *                   `workbench_delegate_worker`
 *   other     (O) — every other toolResult usage plus branch_summary and
 *                   compaction usage (Pi's "Tools/summaries" bucket)
 *
 * Pi's aggregation semantics, mirrored verbatim:
 *   - assistant message:            totals += usage (cost from usage.cost.total)
 *   - toolResult WITH usage:        totals += usage
 *   - branch_summary/compaction
 *     WITH usage:                   totals += usage
 *   - tokens = input + output + cacheRead + cacheWrite (Pi's
 *     getUsageCostBreakdown convention; usage.totalTokens is never used)
 *
 * The only deliberate differences are defensive:
 *   - missing/malformed usage contributes ZERO instead of crashing or
 *     producing NaN (Pi's footer assumes assistant usage exists)
 *   - non-finite (NaN/±Infinity) and negative numbers contribute zero
 *   - `total` is computed as `commander + worker + other`, so the
 *     reconciliation invariant holds EXACTLY by construction
 *
 * No Pi imports — pure logic, unit-testable with plain node:test.
 */

/** The tool whose toolResult usage is attributed to the worker bucket. */
export const WORKER_TOOL_NAME = "workbench_delegate_worker";

export type CostBucketName = "commander" | "worker" | "other";

/** Per-bucket accumulated facts. `cost` is the sum of usage.cost.total. */
export interface CostTotals {
	cost: number;
	/** input + output + cacheRead + cacheWrite (Pi's token convention). */
	tokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Commander usage grouped by `${provider}/${responseModel ?? model}`. */
export interface ModelCostEntry {
	key: string;
	cost: number;
	tokens: number;
}

export interface CostBreakdown {
	commander: CostTotals;
	worker: CostTotals;
	other: CostTotals;
	/** EXACTLY commander + worker + other (field by field). */
	total: CostTotals;
	/**
	 * Commander usage per model, cost-descending (stable sort — equal costs
	 * keep first-seen entry order, like Pi's getUsageCostBreakdown); only
	 * entries with cost > 0 or tokens > 0 are listed.
	 */
	commanderByModel: ModelCostEntry[];
}

/** Clamped, validated usage facts extracted from an entry (zero-filled). */
interface UsageFacts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface ClassifiedEntry {
	bucket: CostBucketName;
	/** Commander model key (assistant entries only). */
	key?: string;
	/** Clamped usage facts, or null when the entry carries no usage object. */
	usage: UsageFacts | null;
}

export function emptyCostTotals(): CostTotals {
	return { cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Defensive number: only finite, non-negative numbers contribute. */
function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Extract + clamp `container.usage` (mirrors Pi's presence checks). */
function extractUsage(container: Record<string, unknown>): UsageFacts | null {
	const usage = container.usage;
	if (typeof usage !== "object" || usage === null) return null;
	const u = usage as Record<string, unknown>;
	const cost = u.cost;
	const costTotal = typeof cost === "object" && cost !== null ? (cost as Record<string, unknown>).total : undefined;
	return {
		input: finiteNonNegative(u.input),
		output: finiteNonNegative(u.output),
		cacheRead: finiteNonNegative(u.cacheRead),
		cacheWrite: finiteNonNegative(u.cacheWrite),
		cost: finiteNonNegative(costTotal),
	};
}

/**
 * Classify one session entry into a cost bucket, mirroring Pi's footer
 * loop exactly (assistant message / toolResult with usage /
 * branch_summary|compaction with usage); anything else is ignored.
 * Malformed entries never throw.
 */
function classifyEntry(entry: unknown): ClassifiedEntry | null {
	if (typeof entry !== "object" || entry === null) return null;
	const e = entry as Record<string, unknown>;
	if (e.type !== "message") {
		if (e.type !== "branch_summary" && e.type !== "compaction") return null;
		return { bucket: "other", usage: extractUsage(e) };
	}
	const message = e.message;
	if (typeof message !== "object" || message === null) return null;
	const m = message as Record<string, unknown>;
	if (m.role === "assistant") {
		const provider = typeof m.provider === "string" ? m.provider : "unknown";
		const model = typeof m.model === "string" ? m.model : "unknown";
		const responseModel = typeof m.responseModel === "string" ? m.responseModel : undefined;
		return { bucket: "commander", key: `${provider}/${responseModel ?? model}`, usage: extractUsage(m) };
	}
	if (m.role === "toolResult") {
		const usage = extractUsage(m);
		// Pi counts a toolResult only when it carries usage.
		if (!usage) return null;
		return { bucket: m.toolName === WORKER_TOOL_NAME ? "worker" : "other", usage };
	}
	return null;
}

/** Add clamped usage facts to a bucket (mirrors Pi's addUsageToTotals). */
function addUsage(totals: CostTotals, usage: UsageFacts): void {
	totals.cost += usage.cost;
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Return true when an entry already contains the pending event message. */
function entryContainsMessage(entry: unknown, pendingMessage: unknown): boolean {
	if (typeof entry !== "object" || entry === null || typeof pendingMessage !== "object" || pendingMessage === null) return false;
	const e = entry as Record<string, unknown>;
	if (e.type !== "message" || typeof e.message !== "object" || e.message === null) return false;
	if (e.message === pendingMessage) return true;
	const stored = e.message as Record<string, unknown>;
	const pending = pendingMessage as Record<string, unknown>;
	return pending.timestamp !== undefined && stored.timestamp === pending.timestamp && stored.role === pending.role;
}

/**
 * Build the split cost breakdown over session entries. Accepts any input
 * (defensive): malformed entries contribute zero and never throw. An optional
 * pending message is included exactly once for pre-persistence message_end
 * refreshes.
 */
export function buildCostBreakdown(entries: readonly unknown[], pendingMessage?: unknown): CostBreakdown {
	const commander = emptyCostTotals();
	const worker = emptyCostTotals();
	const other = emptyCostTotals();
	const byModel = new Map<string, CostTotals>();

	const consume = (entry: unknown): void => {
		const classified = classifyEntry(entry);
		if (!classified || !classified.usage) return;
		const bucket = classified.bucket === "commander" ? commander : classified.bucket === "worker" ? worker : other;
		addUsage(bucket, classified.usage);
		if (classified.bucket === "commander" && classified.key) {
			let modelTotals = byModel.get(classified.key);
			if (!modelTotals) {
				modelTotals = emptyCostTotals();
				byModel.set(classified.key, modelTotals);
			}
			addUsage(modelTotals, classified.usage);
		}
	};

	for (const entry of entries) consume(entry);

	// Pi 0.83 emits message_end before appending the finished message to the
	// session. The caller may supply that event message so a status refresh is
	// current rather than one message behind. Identity or timestamp+role
	// matching prevents double counting if a future Pi version persists first.
	if (pendingMessage && !entries.some((entry) => entryContainsMessage(entry, pendingMessage))) {
		consume({ type: "message", message: pendingMessage });
	}

	// Exact by construction: total is the sum of the three buckets.
	const total: CostTotals = {
		cost: commander.cost + worker.cost + other.cost,
		tokens: commander.tokens + worker.tokens + other.tokens,
		input: commander.input + worker.input + other.input,
		output: commander.output + worker.output + other.output,
		cacheRead: commander.cacheRead + worker.cacheRead + other.cacheRead,
		cacheWrite: commander.cacheWrite + worker.cacheWrite + other.cacheWrite,
	};

	// Same filter and sort as Pi's getUsageCostBreakdown: only entries with
	// cost > 0 or tokens > 0, sorted by cost descending (stable — equal
	// costs keep first-seen entry order).
	const commanderByModel: ModelCostEntry[] = Array.from(byModel, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.tokens,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);

	return { commander, worker, other, total, commanderByModel };
}

/**
 * Deterministic cost formatting: `$${value.toFixed(3)}` — the same format
 * Pi's footer uses for the session cost. Non-finite input renders $0.000.
 */
export function formatCost(value: number): string {
	return Number.isFinite(value) ? `$${value.toFixed(3)}` : "$0.000";
}

/**
 * Token formatting mirroring Pi's footer `formatTokens` exactly
 * (< 1k raw, < 10k one decimal k, < 1M rounded k, < 10M one decimal M,
 * else rounded M). Defensive: non-finite/negative counts render "0".
 */
export function formatTokens(count: number): string {
	if (!Number.isFinite(count) || count < 0) count = 0;
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Compact status segment, e.g. "COST S:$19.195 W:$0.063 O:$0.424".
 * Deterministic: S and W are always shown once the session has any cost
 * facts (cost > 0 or tokens > 0 in any bucket); O is omitted when its cost
 * is zero. Returns undefined when the session has no usage facts at all.
 */
export function costStatusSegment(breakdown: CostBreakdown): string | undefined {
	const hasFacts =
		breakdown.commander.cost > 0 ||
		breakdown.commander.tokens > 0 ||
		breakdown.worker.cost > 0 ||
		breakdown.worker.tokens > 0 ||
		breakdown.other.cost > 0 ||
		breakdown.other.tokens > 0;
	if (!hasFacts) return undefined;
	const parts = [`S:${formatCost(breakdown.commander.cost)}`, `W:${formatCost(breakdown.worker.cost)}`];
	if (breakdown.other.cost > 0) parts.push(`O:${formatCost(breakdown.other.cost)}`);
	return `COST ${parts.join(" ")}`;
}

/**
 * Deterministic text rendering for /q-cost-status: exact commander, worker,
 * other and total amounts (plus token totals) and the per-model commander
 * breakdown. ASCII-only, works in TUI and print/json modes.
 */
export function renderCostBreakdown(breakdown: CostBreakdown): string[] {
	const row = (label: string, totals: CostTotals, note: string): string =>
		`  ${label.padEnd(10)} ${formatCost(totals.cost).padStart(9)} ${formatTokens(totals.tokens).padStart(10)} tokens  ${note}`;
	const lines = [
		"session cost breakdown (from session entries):",
		row("commander", breakdown.commander, "(assistant usage)"),
		row("worker", breakdown.worker, "(workbench_delegate_worker tool results)"),
		row("other", breakdown.other, "(other tool results + branch summaries/compaction)"),
		row("total", breakdown.total, "(commander + worker + other, exact)"),
		"commander by model:",
	];
	if (breakdown.commanderByModel.length === 0) {
		lines.push("  (no assistant usage)");
	} else {
		for (const entry of breakdown.commanderByModel) {
			lines.push(`  ${entry.key.padEnd(30)} ${formatCost(entry.cost).padStart(9)} ${formatTokens(entry.tokens).padStart(10)} tokens`);
		}
	}
	return lines;
}
