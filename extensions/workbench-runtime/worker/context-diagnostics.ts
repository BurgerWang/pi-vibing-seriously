/**
 * P7 worker context diagnostics — pure, defensive, NO Pi imports and NO
 * compaction implementation.
 *
 * These diagnostics inspect bounded session-entry-like facts (the same
 * structural shape cost-breakdown consumes: `{ type: "message", message:
 * { role, content, usage, toolName } }` plus non-message entries) and
 * detect the problematic LATEST DELEGATION TOOL-RESULT TURN: the
 * pre-fix `workbench_delegate_worker` handoff embedded the worker's
 * complete final text in ONE toolResult. Pi cannot split a toolResult,
 * and when that turn is the only post-compaction turn there is no
 * compactable prefix — the oversized handoff could never be compacted
 * away. The workbench NEVER reimplements Pi compaction; these functions
 * only estimate and detect so the runtime can visibly warn.
 *
 * Semantics:
 *   - estimateLatestTurnTokens mirrors Pi's conservative per-message
 *     char/4 heuristic (dist/.../compaction/compaction.js estimateTokens)
 *     over the LATEST turn (its user prompt, assistant message, and
 *     trailing toolResults), plus the assistant's provider usage tokens
 *     (Pi's calculateContextTokens convention: a positive totalTokens is
 *     authoritative, otherwise the sum of the non-negative input + output
 *     + cacheRead + cacheWrite) unless includeUsage: false.
 *   - compactablePrefixAvailable mirrors the relevant Pi
 *     `prepareCompaction` structure defensively: the ACTIVE boundary
 *     starts at the latest compaction's `firstKeptEntryId` (matched by
 *     ORIGINAL entry index, falling back to the entry right after the
 *     latest compaction) and a compactable prefix exists when a valid cut
 *     point (message roles user/assistant/custom/branchSummary/
 *     compactionSummary/bashExecution or entry types branch_summary /
 *     custom_message) appears strictly BEFORE the latest turn's start AND
 *     inside that active boundary. Historical entries before the boundary
 *     never count. The single-huge-recent-turn shape (one turn after
 *     compaction) has NO such prefix.
 *   - detectSingleHugeRecentTurn returns true exactly for the known
 *     hazard: the latest turn carries a workbench_delegate_worker
 *     toolResult whose EMBEDDED TEXT (never provider usage — usage does
 *     not affect the compactability of the toolResult content) exceeds
 *     the thresholds AND no compactable prefix exists. The default
 *     thresholds are defined relative to the centralized new parent
 *     handoff cap (2× MAX_PARENT_HANDOFF_BYTES: 24 KiB / 6144 char/4
 *     tokens) — strictly above the new cap, so a valid new bounded
 *     handoff (≤ 12 KiB text) never triggers, while the pre-fix handoff
 *     (bounded by Pi's DEFAULT_MAX_BYTES ≈ 50 KiB output cap) always
 *     does.
 *
 * Malformed input fails safe: malformed entries are ignored, unparseable
 * sessions yield 0 / false / null — never a throw, never NaN.
 */

import { WORKER_TOOL_NAME } from "../core/cost-breakdown.ts";
import { MAX_PARENT_HANDOFF_BYTES } from "./handoff.ts";

/**
 * Default embedded-text byte threshold for a "huge" latest-turn delegation
 * toolResult: strictly above the centralized NEW parent handoff cap (2×
 * MAX_PARENT_HANDOFF_BYTES = 24 KiB) so a valid new bounded handoff (≤ 12
 * KiB) never warns, while the pre-fix handoff — bounded by Pi's
 * DEFAULT_MAX_BYTES ≈ 50 KiB runner output cap — always does.
 */
export const DEFAULT_HUGE_TURN_MIN_BYTES = 2 * MAX_PARENT_HANDOFF_BYTES;
/** Default embedded-text token threshold: the char/4 token estimate of the byte threshold above. */
export const DEFAULT_HUGE_TURN_MIN_TOKENS = Math.ceil(DEFAULT_HUGE_TURN_MIN_BYTES / 4);

/** The exact visible warning line emitted by /q-status and /q-delegation-status. */
export const CONTEXT_RISK_DELEGATION_HANDOFF_TOO_LARGE = "CONTEXT RISK: latest delegation handoff too large";

export interface TurnDiagnosticOptions {
	/** Include the assistant's provider-usage tokens in the estimate (default true). */
	includeUsage?: boolean;
}

export interface HugeTurnThresholds {
	minTokens?: number;
	minBytes?: number;
}

interface EntryLike {
	type?: unknown;
	message?: unknown;
}

interface MessageLike {
	role?: unknown;
	content?: unknown;
	usage?: unknown;
	toolName?: unknown;
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Pi's calculateContextTokens convention, defensively: positive totalTokens wins. */
function usageTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const u = usage as Record<string, unknown>;
	const total = u.totalTokens;
	if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;
	return (
		finiteNonNegative(u.input) +
		finiteNonNegative(u.output) +
		finiteNonNegative(u.cacheRead) +
		finiteNonNegative(u.cacheWrite)
	);
}

/** Concatenated text of a content block list or string (Pi's content shapes). */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") out += b.text;
		else if (b.type === "thinking" && typeof b.thinking === "string") out += b.thinking;
		else if (b.type === "toolCall" && typeof b.name === "string") {
			out += b.name;
			out += typeof b.arguments === "string" ? b.arguments : "";
		}
	}
	return out;
}

/** Pi's estimateTokens heuristic for one message: ceil(chars / 4). */
function estimateMessageTokens(message: MessageLike, includeUsage: boolean): number {
	let tokens = Math.ceil(contentText(message.content).length / 4);
	if (includeUsage && message.role === "assistant") tokens += usageTokens(message.usage);
	return tokens;
}

/** Only well-formed message entries are inspected (malformed ones are ignored). */
function messageEntries(entries: readonly unknown[]): MessageLike[] {
	if (!Array.isArray(entries)) return [];
	const out: MessageLike[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as EntryLike;
		if (e.type !== "message") continue;
		if (typeof e.message !== "object" || e.message === null) continue;
		out.push(e.message as MessageLike);
	}
	return out;
}

function isEntryLike(entry: unknown): EntryLike | null {
	if (typeof entry !== "object" || entry === null) return null;
	return entry as EntryLike;
}

function lastAssistantIndex(messages: readonly MessageLike[]): number {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]?.role === "assistant") return i;
	}
	return -1;
}

/**
 * Estimate the context tokens of the LATEST turn (user prompt + assistant
 * message + trailing toolResults) using Pi's conservative char/4 heuristic
 * plus — unless includeUsage: false — the assistant's provider usage
 * tokens. Mirrors Pi's estimateContextTokens semantics defensively;
 * malformed sessions yield 0 — never NaN, never a throw.
 */
export function estimateLatestTurnTokens(entries: readonly unknown[], options: TurnDiagnosticOptions = {}): number {
	const includeUsage = options.includeUsage ?? true;
	const messages = messageEntries(entries);
	const lastAssistant = lastAssistantIndex(messages);
	if (lastAssistant < 0) return 0;
	// The latest turn starts at the nearest preceding user message (or at
	// the assistant message itself when the turn has no user prompt, e.g.
	// a compacted retained tail).
	let start = lastAssistant;
	for (let i = lastAssistant - 1; i >= 0; i -= 1) {
		if (messages[i]?.role === "user") {
			start = i;
			break;
		}
	}
	let tokens = 0;
	for (let i = start; i < messages.length; i += 1) {
		tokens += estimateMessageTokens(messages[i]!, includeUsage);
	}
	return tokens;
}

/**
 * True when Pi-style compaction could select a prefix BEFORE the latest
 * turn. Mirrors the relevant `prepareCompaction` structure defensively:
 * the ACTIVE boundary starts at the LATEST compaction's `firstKeptEntryId`
 * (matched by ORIGINAL entry index — never a filtered array), falling back
 * to the entry right after the latest compaction; a context-visible valid
 * cut point (message roles user/assistant/custom/branchSummary/
 * compactionSummary/bashExecution or entry types branch_summary /
 * custom_message) strictly BEFORE the latest turn's start AND inside that
 * active boundary makes a compactable prefix available. Historical entries
 * before the boundary are already summarized and never count. The
 * single-huge-recent-turn shape — the delegation tool-result turn is the
 * only post-compaction turn — has NO such prefix and returns false. This
 * is a defensive structural mirror of Pi's prepareCompaction/findCutPoint;
 * it never implements or triggers compaction itself.
 */
export function compactablePrefixAvailable(entries: readonly unknown[]): boolean {
	const list = (Array.isArray(entries) ? entries : []).map(isEntryLike).filter((e): e is EntryLike => e !== null);
	if (list.length === 0) return false;
	// Pi prepares nothing when the newest entry is already a compaction
	// (the session is fully summarized) — no compactable prefix remains.
	if (list[list.length - 1]?.type === "compaction") return false;
	// Active boundary: the latest compaction's firstKeptEntryId, matched by
	// ORIGINAL entry index; fallback = the entry after the compaction.
	let boundaryStart = 0;
	for (let i = list.length - 1; i >= 0; i -= 1) {
		const entry = list[i]!;
		if (entry.type !== "compaction") continue;
		const compaction = entry as { firstKeptEntryId?: unknown };
		const keptIndex =
			typeof compaction.firstKeptEntryId === "string"
				? list.findIndex((candidate) => (candidate as { id?: unknown }).id === compaction.firstKeptEntryId)
				: -1;
		boundaryStart = keptIndex >= 0 ? keptIndex : i + 1;
		break;
	}
	// The latest assistant message and its turn start, by ORIGINAL entry
	// index (never mixed with a filtered message array).
	let lastAssistant = -1;
	for (let i = list.length - 1; i >= 0; i -= 1) {
		const entry = list[i]!;
		if (entry.type !== "message") continue;
		const message = entry.message as MessageLike | undefined;
		if (message && typeof message === "object" && message.role === "assistant") {
			lastAssistant = i;
			break;
		}
	}
	if (lastAssistant < 0) return false;
	let turnStart = lastAssistant;
	for (let i = lastAssistant - 1; i >= 0; i -= 1) {
		const entry = list[i]!;
		if (entry.type !== "message") continue;
		const message = entry.message as MessageLike | undefined;
		if (message && typeof message === "object" && message.role === "user") {
			turnStart = i;
			break;
		}
	}
	// A compactable prefix exists when a valid Pi cut point sits strictly
	// before the latest turn start AND at/after the active boundary.
	for (let i = boundaryStart; i < turnStart; i += 1) {
		const entry = list[i]!;
		if (entry.type === "branch_summary" || entry.type === "custom_message") return true;
		if (entry.type === "message") {
			const role = (entry.message as MessageLike | undefined)?.role;
			if (
				role === "user" ||
				role === "assistant" ||
				role === "custom" ||
				role === "branchSummary" ||
				role === "compactionSummary" ||
				role === "bashExecution"
			) {
				return true;
			}
		}
	}
	return false;
}

function threshold(raw: number | undefined, fallback: number): number {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return fallback;
	return raw;
}

/**
 * Detect the problematic latest delegation tool-result turn: the latest
 * turn carries a workbench_delegate_worker toolResult whose EMBEDDED TEXT
 * is huge (≥ minTokens estimated text tokens via Pi's char/4 heuristic or
 * ≥ minBytes UTF-8 bytes — defaults strictly above the new 12 KiB bounded
 * handoff, 2× the parent cap) AND no compactable prefix exists before it
 * (the only post-compaction turn). The token/byte thresholds measure the
 * EMBEDDED HANDOFF TEXT itself (the un-splittable toolResult content), so
 * a valid new bounded handoff never warns regardless of prompt size, while
 * the pre-fix ~50 KiB runner-bounded handoff always does. Provider usage
 * facts never trigger detection. Malformed input fails safe (false).
 */
export function detectSingleHugeRecentTurn(entries: readonly unknown[], thresholds: HugeTurnThresholds = {}): boolean {
	const minTokens = threshold(thresholds.minTokens, DEFAULT_HUGE_TURN_MIN_TOKENS);
	const minBytes = threshold(thresholds.minBytes, DEFAULT_HUGE_TURN_MIN_BYTES);
	const messages = messageEntries(entries);
	const lastAssistant = lastAssistantIndex(messages);
	if (lastAssistant < 0) return false;
	let delegationText = "";
	for (let i = lastAssistant + 1; i < messages.length; i += 1) {
		const message = messages[i]!;
		if (message.role === "toolResult" && message.toolName === WORKER_TOOL_NAME) {
			delegationText += contentText(message.content);
		}
	}
	if (!delegationText) return false;
	if (compactablePrefixAvailable(entries)) return false;
	const estimatedTokens = Math.ceil(delegationText.length / 4);
	return estimatedTokens >= minTokens || Buffer.byteLength(delegationText, "utf8") >= minBytes;
}

/**
 * The visible CONTEXT RISK line for /q-status and /q-delegation-status,
 * or undefined when the hazard is not detected.
 */
export function delegationContextRiskLine(entries: readonly unknown[]): string | undefined {
	return detectSingleHugeRecentTurn(entries) ? CONTEXT_RISK_DELEGATION_HANDOFF_TOO_LARGE : undefined;
}
