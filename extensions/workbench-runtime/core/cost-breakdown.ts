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
 *   worker    (W) — toolResult usage whose toolName is a worker-launching
 *                   delegate or exact-repair tool
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
 * P0 additions (commander-token-optimization plan, additive + backward
 * compatible — the cost/token buckets above are byte-for-byte unchanged):
 *   - `commanderRequests` — exact count of commander assistant messages
 *     (turns), usage-independent
 *   - `compactions` — exact count of `compaction` session entries
 *   - `renderCostBreakdown` emits the exact, unabridged commander
 *     gross-token facts: full-digit gross (`input + output + cacheRead +
 *     cacheWrite`, never k/M-compacted), exact component counts, and the
 *     deterministic cacheRead share (`cacheRead / gross`, one-decimal
 *     percent, explicit `N/A` when gross is zero). Defensive: malformed /
 *     non-finite / negative hand-crafted counts normalize to zero, counts
 *     above MAX_COMMANDER_COUNT_DISPLAY clamp with an explicit note, and
 *     output is always finite, deterministic and bounded (never
 *     NaN/Infinity)
 *   - `toolTextBytes` — deterministic per-tool inline TEXT byte
 *     attribution over session toolResult entries: grouped by toolName
 *     (stable, toolName-sorted), entry counts, UTF-8 text bytes, and a
 *     total. Only textual content that actually enters context is
 *     counted (string `content` or `content[]` items of type "text");
 *     malformed/non-text content contributes zero and never throws.
 *     Tool arguments are never inspected; the inline TEXT of a result is
 *     inspected ONLY to count its bytes and is never stored, rendered or
 *     otherwise surfaced by this attribution. This attribution is
 *     descriptive only — it never claims causal token savings.
 *
 * No Pi imports — pure logic, unit-testable with plain node:test.
 */

/** The tool whose toolResult usage is attributed to the worker bucket. */
export const WORKER_TOOL_NAME = "workbench_delegate_worker";
export const WORKER_TOOL_NAMES: ReadonlySet<string> = new Set([
	WORKER_TOOL_NAME,
	"workbench_repair_delegation",
]);

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
	/**
	 * P0: exact commander assistant-request count (turns) — every assistant
	 * message entry counts exactly once, independent of usage presence.
	 */
	commanderRequests: number;
	/** P0: exact count of `compaction` session entries (usage-independent). */
	compactions: number;
	/**
	 * P0: per-tool inline TEXT byte attribution over session toolResult
	 * entries, sorted by toolName (code-unit order — deterministic and
	 * independent of entry order). Malformed toolResults group under
	 * "(unknown)" and never throw.
	 */
	toolTextBytes: ToolTextBytesEntry[];
	/** P0: total toolResult entries counted across all tools. */
	toolResultEntries: number;
	/** P0: total UTF-8 inline TEXT bytes across all toolResults. */
	toolTextBytesTotal: number;
}

/** P0: per-tool inline TEXT byte attribution over session toolResult entries. */
export interface ToolTextBytesEntry {
	toolName: string;
	/** Number of toolResult session entries for this toolName. */
	count: number;
	/** UTF-8 bytes of inline textual content (string content / content[] text items). */
	textBytes: number;
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
	/** True for `type: "compaction"` entries (P0 count, usage-independent). */
	compaction: boolean;
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
		return { bucket: "other", usage: extractUsage(e), compaction: e.type === "compaction" };
	}
	const message = e.message;
	if (typeof message !== "object" || message === null) return null;
	const m = message as Record<string, unknown>;
	if (m.role === "assistant") {
		const provider = typeof m.provider === "string" ? m.provider : "unknown";
		const model = typeof m.model === "string" ? m.model : "unknown";
		const responseModel = typeof m.responseModel === "string" ? m.responseModel : undefined;
		return { bucket: "commander", key: `${provider}/${responseModel ?? model}`, usage: extractUsage(m), compaction: false };
	}
	if (m.role === "toolResult") {
		const usage = extractUsage(m);
		// Pi counts a toolResult only when it carries usage.
		if (!usage) return null;
		return { bucket: typeof m.toolName === "string" && WORKER_TOOL_NAMES.has(m.toolName) ? "worker" : "other", usage, compaction: false };
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

/** Add two independently aggregated, disjoint entry windows without rescanning either window. */
export function mergeCostBreakdowns(left: CostBreakdown, right: CostBreakdown): CostBreakdown {
	const totals = (a: CostTotals, b: CostTotals): CostTotals => ({
		cost: a.cost + b.cost,
		tokens: a.tokens + b.tokens,
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
	});
	const commander = totals(left.commander, right.commander);
	const worker = totals(left.worker, right.worker);
	const other = totals(left.other, right.other);
	const modelMap = new Map<string, ModelCostEntry>();
	for (const item of [...left.commanderByModel, ...right.commanderByModel]) {
		const prior = modelMap.get(item.key);
		modelMap.set(item.key, prior
			? { key: item.key, cost: prior.cost + item.cost, tokens: prior.tokens + item.tokens }
			: { ...item });
	}
	const toolMap = new Map<string, ToolTextBytesEntry>();
	for (const item of [...left.toolTextBytes, ...right.toolTextBytes]) {
		const prior = toolMap.get(item.toolName);
		toolMap.set(item.toolName, prior
			? { toolName: item.toolName, count: prior.count + item.count, textBytes: prior.textBytes + item.textBytes }
			: { ...item });
	}
	return {
		commander,
		worker,
		other,
		total: totals(totals(commander, worker), other),
		commanderByModel: [...modelMap.values()]
			.filter((item) => item.cost > 0 || item.tokens > 0)
			.sort((a, b) => b.cost - a.cost),
		commanderRequests: left.commanderRequests + right.commanderRequests,
		compactions: left.compactions + right.compactions,
		toolTextBytes: [...toolMap.values()].sort((a, b) => a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0),
		toolResultEntries: left.toolResultEntries + right.toolResultEntries,
		toolTextBytesTotal: left.toolTextBytesTotal + right.toolTextBytesTotal,
	};
}

/**
 * Build the split cost breakdown over session entries. Accepts any input
 * (defensive): malformed entries contribute zero and never throw. An optional
 * pending message is included exactly once for pre-persistence message_end
 * refreshes.
 */
const UNKNOWN_TOOL_NAME = "(unknown)";

/**
 * P0: UTF-8 bytes of the inline textual content of one toolResult message
 * — exactly the text that enters context: a string `content`, or `content[]`
 * items of type "text" with a string `text`. Malformed/non-text content
 * contributes zero and never throws. Tool arguments are never inspected;
 * the text inspected here is counted as bytes only and is never stored or
 * rendered by this attribution.
 */
export function toolResultTextBytes(entry: unknown): number {
	if (typeof entry !== "object" || entry === null) return 0;
	const e = entry as Record<string, unknown>;
	if (e.type !== "message" || typeof e.message !== "object" || e.message === null) return 0;
	const m = e.message as Record<string, unknown>;
	if (m.role !== "toolResult") return 0;
	const content = m.content;
	if (typeof content === "string") return new TextEncoder().encode(content).length;
	if (!Array.isArray(content)) return 0;
	let bytes = 0;
	for (const item of content) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") {
			bytes += new TextEncoder().encode(record.text).length;
		}
	}
	return bytes;
}

/** P0: deterministic toolName for a toolResult message (never throws). */
function toolNameOf(entry: unknown): string {
	if (typeof entry !== "object" || entry === null) return UNKNOWN_TOOL_NAME;
	const e = entry as Record<string, unknown>;
	if (e.type !== "message" || typeof e.message !== "object" || e.message === null) return UNKNOWN_TOOL_NAME;
	const name = (e.message as Record<string, unknown>).toolName;
	return typeof name === "string" && name.length > 0 ? name : UNKNOWN_TOOL_NAME;
}

export function buildCostBreakdown(entries: readonly unknown[], pendingMessage?: unknown): CostBreakdown {
	const commander = emptyCostTotals();
	const worker = emptyCostTotals();
	const other = emptyCostTotals();
	const byModel = new Map<string, CostTotals>();
	// P0 counters (additive — the cost/token semantics above are untouched).
	let commanderRequests = 0;
	let compactions = 0;
	let toolResultEntries = 0;
	let toolTextBytesTotal = 0;
	const toolBytes = new Map<string, { count: number; bytes: number }>();

	const consume = (entry: unknown): void => {
		// P0 per-tool inline TEXT attribution runs for EVERY toolResult entry
		// (usage-independent — an entry that enters context counts even when
		// Pi attached no usage facts to it).
		if (typeof entry === "object" && entry !== null) {
			const e = entry as Record<string, unknown>;
			const m = e.message as Record<string, unknown> | undefined;
			if (e.type === "message" && m?.role === "toolResult") {
				const name = toolNameOf(entry);
				const bytes = toolResultTextBytes(entry);
				const slot = toolBytes.get(name) ?? { count: 0, bytes: 0 };
				slot.count += 1;
				slot.bytes += bytes;
				toolBytes.set(name, slot);
				toolResultEntries += 1;
				toolTextBytesTotal += bytes;
			}
		}
		const classified = classifyEntry(entry);
		if (!classified) return;
		// P0 exact counts are usage-independent (a turn/compaction happened
		// even when usage facts are missing).
		if (classified.compaction) compactions++;
		if (classified.bucket === "commander") commanderRequests++;
		if (!classified.usage) return;
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

	// P0: deterministic per-tool attribution — toolName code-unit order,
	// independent of entry order. Exact counts and UTF-8 text bytes.
	const toolTextBytes: ToolTextBytesEntry[] = Array.from(toolBytes, ([toolName, slot]) => ({
		toolName,
		count: slot.count,
		textBytes: slot.bytes,
	})).sort((a, b) => (a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0));

	return {
		commander,
		worker,
		other,
		total,
		commanderByModel,
		commanderRequests,
		compactions,
		toolTextBytes,
		toolResultEntries,
		toolTextBytesTotal,
	};
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

/** P0: exact UTF-8 byte rendering (raw counts, ASCII). */
export function formatBytes(count: number): string {
	return Number.isFinite(count) && count >= 0 ? `${Math.round(count)}` : "0";
}

export interface CostBreakdownRenderOptions {
	/**
	 * P0: max per-tool text-byte rows rendered (default 12). Malformed
	 * values (non-number, NaN/±Infinity, negative) resolve to the default;
	 * valid values clamp to [0, MAX_TOOL_ROWS] — a malformed option can
	 * never produce unbounded output. Remaining tools are collapsed into
	 * one explicit omission line — the exact per-tool facts always stay
	 * available in `breakdown.toolTextBytes`.
	 */
	maxToolRows?: number;
}

/**
 * P0 rendering bounds (display only — the exact structured facts in
 * `breakdown.toolTextBytes` / `breakdown.commanderByModel` are never
 * altered by these):
 *   - MAX_TOOL_NAME_BYTES: UTF-8 byte budget for a rendered per-tool name;
 *     control characters (including newlines — a name must never inject
 *     extra lines) are replaced by a single space and byte truncation is
 *     code-point safe with an explicit "…" marker
 *   - MAX_MODEL_KEY_BYTES: same bounded-display treatment for commander
 *     per-model keys (`${provider}/${model}` derives from session entries)
 *   - MAX_TOOL_ROWS: hard maximum per-tool rows rendered by /q-cost-status
 *     (custom `maxToolRows` values clamp to this)
 */
export const MAX_TOOL_NAME_BYTES = 32;
export const MAX_MODEL_KEY_BYTES = 48;
export const MAX_TOOL_ROWS = 40;

/** Exact UTF-8 byte length of a string (deterministic). */
function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Code-point-safe UTF-8 byte truncation with an explicit "…" marker. */
function truncateUtf8(text: string, maxBytes: number): string {
	let used = 0;
	const out: string[] = [];
	for (const ch of text) {
		const bytes = utf8Bytes(ch);
		if (used + bytes > maxBytes) return out.join("");
		used += bytes;
		out.push(ch);
	}
	return text;
}

const CONTROL_RE = /[\x00-\x1f\x7f]/g;

/**
 * Bounded display form of an untrusted name (tool name or model key):
 * control characters (including newlines — a field must never inject extra
 * lines) are replaced by a single space, then the result is truncated to
 * `maxBytes` UTF-8 bytes, code-point safe, with an explicit "…" marker.
 * Non-string values render as "(invalid)" so the policy never throws.
 * `altered` reports whether the displayed form differs from the raw value
 * (the caller surfaces it as an explicit omission fact — the raw name is
 * never rendered). Deterministic.
 */
function boundedDisplayName(name: unknown, maxBytes: number): { text: string; altered: boolean } {
	if (typeof name !== "string") return { text: "(invalid)", altered: true };
	const cleaned = name.replace(CONTROL_RE, " ");
	if (utf8Bytes(cleaned) <= maxBytes) return { text: cleaned, altered: cleaned !== name };
	return { text: `${truncateUtf8(cleaned, Math.max(0, maxBytes - 3))}…`, altered: true };
}

const DEFAULT_TOOL_ROWS = 12;

/**
 * Clamp the render option deterministically: malformed values (non-number,
 * NaN/±Infinity, negative) resolve to the default; valid values floor and
 * clamp to [0, MAX_TOOL_ROWS].
 */
function clampMaxToolRows(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return DEFAULT_TOOL_ROWS;
	return Math.min(MAX_TOOL_ROWS, Math.floor(value));
}

/**
 * P0 display bound for the exact commander gross/component token counts
 * (defensive). Real token counts are orders of magnitude below this; a
 * hand-crafted finite-but-absurd count clamps here with an explicit note so
 * rendered lines stay bounded. 2^50 keeps the sum of the four clamped
 * components (≤ 2^52) exactly representable, so the rendered gross equals
 * `input + output + cacheRead + cacheWrite` exactly in integer arithmetic.
 */
export const MAX_COMMANDER_COUNT_DISPLAY = 2 ** 50;

/** P0: defensive, exact commander token facts for rendering. */
interface CommanderTokenFacts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** EXACTLY input + output + cacheRead + cacheWrite (integer arithmetic). */
	gross: number;
	/** True when any component exceeded MAX_COMMANDER_COUNT_DISPLAY. */
	clamped: boolean;
}

/**
 * P0: extract the exact commander gross/component token facts defensively.
 * Each component is normalized (malformed / non-finite / negative → 0,
 * rounded to an integer) and clamped to MAX_COMMANDER_COUNT_DISPLAY, so the
 * facts are always finite, deterministic, non-negative integers and `gross`
 * is exactly `input + output + cacheRead + cacheWrite`. Never throws.
 */
function commanderTokenFacts(breakdown: CostBreakdown): CommanderTokenFacts {
	// `Partial<CostTotals>` keeps the defensive fallback (`{}` for malformed
	// hand-crafted breakdowns) type-safe — each component is read as
	// `number | undefined` and normalized below.
	const commander: Partial<CostTotals> =
		typeof breakdown.commander === "object" && breakdown.commander !== null ? breakdown.commander : {};
	const normalize = (value: unknown): { value: number; clamped: boolean } => {
		const rounded = Math.round(finiteNonNegative(value));
		return rounded > MAX_COMMANDER_COUNT_DISPLAY
			? { value: MAX_COMMANDER_COUNT_DISPLAY, clamped: true }
			: { value: rounded, clamped: false };
	};
	const input = normalize(commander.input);
	const output = normalize(commander.output);
	const cacheRead = normalize(commander.cacheRead);
	const cacheWrite = normalize(commander.cacheWrite);
	return {
		input: input.value,
		output: output.value,
		cacheRead: cacheRead.value,
		cacheWrite: cacheWrite.value,
		gross: input.value + output.value + cacheRead.value + cacheWrite.value,
		clamped: input.clamped || output.clamped || cacheRead.clamped || cacheWrite.clamped,
	};
}

/**
 * P0: deterministic cacheRead share percent (one decimal, e.g. "93.1%").
 * Caller guarantees gross > 0; with normalized non-negative components the
 * ratio is always finite and within [0, 1].
 */
function commanderCacheReadShare(facts: CommanderTokenFacts): string {
	return `${((facts.cacheRead / facts.gross) * 100).toFixed(1)}%`;
}

/**
 * Deterministic text rendering for /q-cost-status: exact commander, worker,
 * other and total amounts (plus token totals), the per-model commander
 * breakdown, and the P0 session facts (commander requests, compactions,
 * exact unabridged commander gross-token facts, bounded per-tool inline
 * TEXT byte attribution — counts and UTF-8 bytes only; tool arguments and
 * result text are never rendered). ASCII-only, works in TUI and
 * print/json modes. Defensive: every untrusted display field (tool names,
 * model keys) is sanitized (control characters replaced — a field can
 * never inject extra lines) and bounded to a documented UTF-8 byte budget
 * with explicit omission facts; `maxToolRows` clamps to
 * [0, MAX_TOOL_ROWS], and commander token counts clamp to
 * MAX_COMMANDER_COUNT_DISPLAY with an explicit note, so malformed session
 * entries/options can never produce unbounded output. The exact structured
 * facts (`toolTextBytes` / `commanderByModel` / the commander bucket) are
 * never altered by display bounding.
 */
export function renderCostBreakdown(breakdown: CostBreakdown, options?: CostBreakdownRenderOptions): string[] {
	const row = (label: string, totals: CostTotals, note: string): string =>
		`  ${label.padEnd(10)} ${formatCost(totals.cost).padStart(9)} ${formatTokens(totals.tokens).padStart(10)} tokens  ${note}`;
	const lines = [
		"session cost breakdown (from session entries):",
		row("commander", breakdown.commander, "(assistant usage)"),
		row("worker", breakdown.worker, "(delegate and exact-repair worker tool results)"),
		row("other", breakdown.other, "(other tool results + branch summaries/compaction)"),
		row("total", breakdown.total, "(commander + worker + other, exact)"),
		"commander by model:",
	];
	const commanderByModel = Array.isArray(breakdown.commanderByModel) ? breakdown.commanderByModel : [];
	let modelKeysBounded = 0;
	if (commanderByModel.length === 0) {
		lines.push("  (no assistant usage)");
	} else {
		for (const entry of commanderByModel) {
			const key = boundedDisplayName(entry?.key, MAX_MODEL_KEY_BYTES);
			if (key.altered) modelKeysBounded++;
			lines.push(`  ${key.text.padEnd(30)} ${formatCost(entry?.cost).padStart(9)} ${formatTokens(entry?.tokens).padStart(10)} tokens`);
		}
		if (modelKeysBounded > 0) {
			lines.push(`  (+${modelKeysBounded} model key(s) bounded for display — exact keys in the commanderByModel field)`);
		}
	}
	// P0 session facts — compact, bounded per-tool rows, descriptive only.
	lines.push("session facts (P0 observability, descriptive — no causal savings claimed):");
	lines.push(`  commander requests : ${formatBytes(breakdown.commanderRequests)}`);
	lines.push(`  compactions        : ${formatBytes(breakdown.compactions)}`);
	// P0 baseline facts: exact, unabridged commander gross tokens (full
	// digits — never k/M-compacted), exact components, and the deterministic
	// cacheRead share (N/A on a zero gross). The compact bucket rows above
	// are untouched.
	const commanderFacts = commanderTokenFacts(breakdown);
	lines.push(
		`  commander gross tokens   : ${commanderFacts.gross} (input ${commanderFacts.input} + output ${commanderFacts.output} + cacheRead ${commanderFacts.cacheRead} + cacheWrite ${commanderFacts.cacheWrite})`,
	);
	lines.push(
		commanderFacts.gross > 0
			? `  commander cacheRead share : ${commanderCacheReadShare(commanderFacts)} (cacheRead ${commanderFacts.cacheRead} / gross ${commanderFacts.gross})`
			: "  commander cacheRead share : N/A (gross tokens 0 — no denominator)",
	);
	if (commanderFacts.clamped) {
		lines.push(
			`  (commander token count(s) above ${MAX_COMMANDER_COUNT_DISPLAY} clamped for display — exact values in the commander bucket)`,
		);
	}
	lines.push(
		`  tool result text   : ${formatBytes(breakdown.toolTextBytesTotal)} UTF-8 text bytes across ${formatBytes(breakdown.toolResultEntries)} tool results (inline TEXT only — counted as bytes, never stored or rendered; tool arguments never inspected)`,
	);
	const maxToolRows = clampMaxToolRows(options?.maxToolRows);
	// Deterministic display order: text bytes descending, then toolName
	// ascending (ties keep a stable code-unit order). Non-finite hand-crafted
	// values normalize to zero so the order stays total and deterministic.
	const toolTextBytes = Array.isArray(breakdown.toolTextBytes) ? breakdown.toolTextBytes : [];
	const ranked = [...toolTextBytes].sort((a, b) => {
		const ab = finiteNonNegative(a?.textBytes);
		const bb = finiteNonNegative(b?.textBytes);
		return ab !== bb ? bb - ab : a?.toolName < b?.toolName ? -1 : a?.toolName > b?.toolName ? 1 : 0;
	});
	lines.push("  per-tool text bytes (descending):");
	if (ranked.length === 0) {
		lines.push("    (no tool results)");
	} else {
		let namesBounded = 0;
		for (const entry of ranked.slice(0, maxToolRows)) {
			const name = boundedDisplayName(entry?.toolName, MAX_TOOL_NAME_BYTES);
			if (name.altered) namesBounded++;
			lines.push(`    ${name.text.padEnd(28)} ${formatBytes(entry?.count)} calls, ${formatBytes(entry?.textBytes)} text bytes`);
		}
		if (namesBounded > 0) {
			lines.push(`    (+${namesBounded} tool name(s) bounded for display — exact names in the toolTextBytes fields)`);
		}
		if (ranked.length > maxToolRows) {
			lines.push(`    (+${ranked.length - maxToolRows} more tools omitted — bounded display; exact facts in the toolTextBytes fields)`);
		}
	}
	return lines;
}
