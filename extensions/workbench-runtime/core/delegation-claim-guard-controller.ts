/** Fail-closed binding between commander prose and real delegation authority. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { sha256Hex } from "../cache/canonical-hash.ts";
import { repairDelegationToolActionV1 } from "./agent-next-action.ts";
import {
	exactRepairToolArgumentsV1,
	type ExactRepairToolArgumentsV1,
} from "./exact-repair-authority.ts";
import {
	DELEGATION_SCHEMA_VERSION,
	type DelegationLedger,
	type readDelegationLedger,
} from "./delegation-ledger.ts";
import {
	DELEGATION_TRANSACTION_ID_RE,
	type DelegationTransactionStatus,
} from "./delegation-transaction.ts";
import type {
	readDelegationCommittedGenerationV2,
	readDelegationReviewV2,
	readDelegationTransactionV2,
} from "./delegation-transaction-storage.ts";
import { hasDelegationSemanticRepairAuthorityV2 } from "./delegation-transaction-storage.ts";
import type { DelegationReviewStatus, DelegationState } from "./delegation-state.ts";
import { ownDataValue } from "./runtime-output-controller.ts";
import type { readCommittedManifest } from "./runs.ts";

export const DELEGATION_CLAIM_GUARD_SCHEMA = "workbench-delegation-claim-guard-v2" as const;
export const DELEGATION_CLAIM_GUARD_CODE = "UNVERIFIED_EXECUTION_CLAIM" as const;
export const DELEGATION_CLAIM_BINDING_REVISION = "authority-resolved-v2" as const;
export const EXACT_REPAIR_DIRECTIVE_SCHEMA = "workbench-exact-repair-directive-v1" as const;
export { exactRepairToolArgumentsV1 };
export const DELEGATION_CLAIM_GUARD_TEXT = [
	`[${DELEGATION_CLAIM_GUARD_SCHEMA}]`,
	DELEGATION_CLAIM_GUARD_CODE,
	"The assistant attempted to report delegation execution without matching machine authority.",
	"No delegation id, status, or completion claim from the rejected message is accepted.",
	"Follow the machine-specific next_action below; rejected prose is never authority.",
].join("\n");

const DELEGATION_ID_SCAN_RE = /\b\d{8}-\d{6}-[A-Za-z0-9]{4}\b/g;
const REPAIR_OF_LABEL_RE = /\brepair_of\b/iu;
const STATUS_SCAN_RE = /\b(?:SUCCESS|REVIEWED|STALE|PENDING_REVIEW|RECOVERY_REQUIRED|FINISHED|FAILED|ABORTED|RUNNING|PREPARED|COMMITTING)\b/gi;
const DELEGATION_WORD_RE = /\bdelegation(?:s)?\b|\brepair_of\b|委派|工作线程/i;
const WORKER_WORD_RE = /\bworker(?:s)?\b|工作线程/iu;
const WORKER_MACHINE_CLAIM_RE = /\bworker(?:s)?\b.{0,80}\b(?:SUCCESS(?:FUL(?:LY)?)?|SUCCEEDED|REVIEWED|FINISHED)\b|\bworker(?:s)?\b.{0,80}成功(?:退出|完成)?/isu;
const EXECUTION_WORD_RE = /\b(?:start(?:ed)?|launch(?:ed)?|execut(?:e|ed)|creat(?:e|ed)|return(?:ed)?|complet(?:e|ed)|attempt(?:ed)?)\b|(?:已|重新|本次|刚刚|刚才|新(?:的)?|全新(?:的)?|再次)?(?:启动|执行|调用|创建|完成|改用|返回|尝试)/i;
const SUCCESS_WORD_RE = /\b(?:SUCCESS(?:FUL(?:LY)?)?|SUCCEEDED|REVIEWED|FINISHED)\b|成功(?:退出|完成)?|已完成|已落地/i;
const NEGATED_WORD_RE = /\b(?:(?:did|does|is|was|were|has|have)\s+not|didn't|doesn't|isn't|wasn't|weren't|hasn't|haven't|never)\s+(?:start|launch|execute|create|complete|find|exist|succeed|review|finish|fail|started|launched|executed|created|completed|found|successful|reviewed|finished|failed)\b|\bno\s+delegation\b|不存在|不是|并非|未创建|未启动|未执行|没有(?:启动|执行|创建|形成)|虚构/i;
const NEGATED_CLAIM_SCAN_RE = /\b(?:(?:did|does|is|was|were|has|have)\s+not|didn't|doesn't|isn't|wasn't|weren't|hasn't|haven't|never|not)\s+(?:start|launch|execute|create|complete|find|exist|succeed|review|finish|fail|started|launched|executed|created|completed|found|successful|reviewed|finished|failed)\b|\bno\s+delegation\b|不存在|不是|并非|未创建|未启动|未执行|未完成|没有(?:启动|执行|创建|形成|完成)|并未(?:启动|执行|创建|完成)|虚构/gi;
const DELEGATION_UNAVAILABLE_DIAGNOSTIC_RE = /\bworkbench_(?:review_worker_diff|delegation_status)\b.{0,200}\b(?:is\s+not\s+the\s+latest|not\s+found|missing|invalid|reject(?:ed)?|refus(?:ed|al))\b|\bdelegation\b.{0,120}\b(?:is\s+not\s+the\s+latest|was\s+not\s+found|does\s+not\s+exist|was\s+reject(?:ed)?|was\s+refus(?:ed)?)\b|\bonly\s+the\s+latest\s+delegation\s+can\s+be\s+reviewed\b|(?:委派|工作线程).{0,120}(?:不是最新|未找到|找不到|不存在|无效|被拒绝|已拒绝)/isu;
const BLOCKED_EXECUTION_SCAN_RE = /(?:\b(?:starting|launching|creating)\b.{0,120}\bdelegation\b.{0,120}\bis blocked\b|(?:启动|开始|创建).{0,80}(?:委派|worker|工作线程).{0,80}(?:被阻止|被拦截|已阻止|无法启动))/gis;
const RECENT_WORD_RE = /\b(?:new|fresh|this\s+(?:turn|attempt|delegation)|just)\b|本次|刚刚|刚才|再次|重新|全新(?:的)?|新(?:的)?\s*(?:delegation|worker|工作线程|委派)|已按要求/i;
const START_WORD_RE = /\b(?:start(?:ed)?|launch(?:ed)?|creat(?:e|ed)|call(?:ed)?)\b|启动|创建|调用|改用/i;
const ASSERTED_START_RE = /\b(?:started|launched|created)\b|已(?:按要求)?(?:启动|创建|改用)|(?:启动|创建|改用)了/iu;
const ASSERTED_ATTEMPT_RE = /\b(?:attempted|called|retried|executed)\b|已(?:按要求)?(?:再次|重新)?(?:调用|尝试|执行)|(?:再次|重新)?(?:调用|尝试|执行)了/iu;
const PLANNED_EXECUTION_RE = /\b(?:will|can|could|should|may|might|plan(?:ned)?\s+to|need\s+to|ready\s+to|going\s+to)\b.{0,32}\b(?:start|launch|execute|create|call)\b|(?:下一步|计划|准备|打算|可以|需要).{0,24}(?:启动|执行|创建|调用|改用)/iu;
const DISTRIBUTIVE_CLAIM_RE = /\b(?:all|both|each|these|those)\b|(?:两|三|四|五|六|七|八|九|十|多)次|(?:全部|都|分别|上述|这些)/iu;
const INLINE_CODE_RE = /`([^`\r\n]*)`/gu;
const RUN_ONLY_LABEL_RE = /\b(?:runs?|run[_ -]?ids?|recipe|tests?|pytest|mypy|compileall|loader|targeted|focused|audit|checks?|diff|gate(?:[-_ ]?profile)?|typecheck|lint)\b|(?:完整\s*)?G1|测试|验证|审计/iu;
const RUN_SUFFIX_LABEL_RE = /^\s*(?:[:：]|[-–—]{1,2}|\(|\[)\s*`?(?:runs?|run[_ -]?ids?|recipe|tests?|pytest|mypy|compileall|loader|targeted|focused|audit|diff|gate(?:[-_ ]?profile)?|typecheck|lint|check:[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+)/iu;
const BUILD_ONLY_LABEL_RE = /\b(?:build|job|workflow|pipeline)\b|构建|流水线/iu;
const DELEGATION_LABEL_RE = /\b(?:delegation(?:s)?|worker(?:s)?|latest|delegation\s+authority|authority\s+v2|repair\s+(?:root|lineage)|lineage\s+root|repair_of)\b|delegation[_ ]?id|委派|工作线程|修复根|修复链/iu;
const LATEST_DELEGATION_LABEL_RE = /\blatest(?:\s+(?:delegation|authority))?(?:\s+id)?\s*[:=]?|最新(?:的)?\s*(?:delegation|authority|委派|工作线程)(?:\s*(?:id|编号))?\s*[:：=]?/iu;
const REVIEW_PASS_FINAL_RE = /\breview(?:\s+v2)?\b.{0,24}\bPASS\b.{0,24}\bFINAL\b|审查.{0,24}(?:通过|PASS).{0,24}(?:最终|FINAL)/iu;
const RUN_SUCCESS_OUTCOME_RE = /\b(?:PASS(?:ED)?|SUCCESS(?:FUL(?:LY)?)?|SUCCEEDED|OK)\b|\bexit(?:\s+code)?\s*[:=]?\s*0\b|成功(?:退出|完成)?/iu;
const RUN_FAILURE_OUTCOME_RE = /\b(?:(?:PROCESS|ARTIFACT)[_ -]FAILED|FAIL(?:ED|URE)?|EXCEPTION|CANCELLED|TIMED[_ ]OUT)\b|\bexit(?:\s+code)?\s*[:=]?\s*[1-9]\d*\b|失败|超时|已取消/iu;
const RUN_COMPLETION_RE = /\b(?:complet(?:e|ed)|finish(?:ed)?|return(?:ed)?|exit(?:ed)?|ended)\b|(?:已|本次|刚刚|刚才)?(?:完成|结束|返回|退出)|完整\s*G1/iu;
const RUN_UNAVAILABLE_DIAGNOSTIC_RE = /\b(?:not\s+found|does\s+not\s+exist|missing|unavailable|uncommitted|invalid\s+(?:record|identity)|identity\s+unavailable)\b|不存在|未运行|未执行|不可用|未提交|无效(?:记录|身份)?|无法读取|虚构/iu;
const MAX_CLAIM_IDS = 32;

export type DelegationClaimAuthorityStatus = DelegationTransactionStatus | "LEGACY_RUNNING" | "LEGACY_SUCCEEDED" | "LEGACY_FAILED";
export type DelegationClaimStatusSource = "transaction" | "session" | "unspecified";

export interface DelegationClaimExpectedStatus {
	readonly status: string;
	readonly source: DelegationClaimStatusSource;
}

export interface DelegationClaimAuthority {
	readonly id: string;
	readonly status: DelegationClaimAuthorityStatus;
	readonly sessionStatus?: DelegationReviewStatus;
}

export interface WorkbenchRunClaimAuthority {
	readonly id: string;
	readonly outcome: "SUCCESS" | "FAILURE";
}

export interface DelegationClaimInspection {
	readonly ids: readonly string[];
	readonly runIds: readonly string[];
	/** Strong lexical namespace claims. Weak/unlabelled ids may be resolved by exclusive durable authority. */
	readonly explicitDelegationIds: readonly string[];
	readonly explicitRunIds: readonly string[];
	readonly expectedRunOutcomes: Readonly<Record<string, "SUCCESS" | "FAILURE" | undefined>>;
	readonly candidateRunOutcomes: Readonly<Record<string, "SUCCESS" | "FAILURE" | undefined>>;
	readonly conflictingRunOutcomeIds: readonly string[];
	readonly directExpectedStatuses: Readonly<Record<string, readonly DelegationClaimExpectedStatus[]>>;
	readonly expectedStatuses: Readonly<Record<string, readonly DelegationClaimExpectedStatus[]>>;
	readonly unboundStatusClaims: readonly DelegationClaimUnboundStatus[];
	readonly explicitlyLatestIds: readonly string[];
	readonly sameRunStartIds: readonly string[];
	readonly executionClaim: boolean;
	readonly workerAttemptClaim: boolean;
	readonly workerStartClaim: boolean;
	readonly successClaim: boolean;
	readonly recentClaim: boolean;
	readonly negativeOnly: boolean;
	readonly overflow: boolean;
	readonly ambiguousStatusBinding: boolean;
}

export interface DelegationClaimUnboundStatus {
	readonly statuses: readonly DelegationClaimExpectedStatus[];
	readonly distributive: boolean;
}

export interface DelegationClaimTurnEvidence {
	readonly attemptedCalls: number;
	readonly successfulResults: number;
	readonly resultIds: readonly string[];
	readonly startedIds: readonly string[];
	readonly observedStatusIds: readonly string[];
}

export interface DelegationClaimValidation {
	readonly ok: boolean;
	readonly code?: "claim_overflow" | "ambiguous_authority_namespace" | "ambiguous_run_outcome" | "ambiguous_status_binding" | "missing_authority" | "status_mismatch" | "missing_attempt_authority" | "missing_started_authority" | "missing_success_result" | "missing_run_authority" | "run_status_mismatch";
}

interface DelegationClaimFailureFacts {
	readonly claimNamespace: "delegation" | "run" | "mixed" | "implicit";
	readonly claimedDelegations: number;
	readonly verifiedDelegations: number;
	readonly claimedRuns: number;
	readonly verifiedRuns: number;
	readonly attemptedDelegateCalls: number;
	readonly successfulDelegateResults: number;
	readonly statusMismatchCount: number;
	readonly durableAttemptFacts: readonly {
		readonly delegation_id: string;
		readonly transaction_status: DelegationClaimAuthorityStatus;
		readonly session_status: DelegationReviewStatus | null;
	}[];
	readonly freshStatusFacts: readonly {
		readonly delegation_id: string;
		readonly transaction_status: DelegationClaimAuthorityStatus;
		readonly session_status: DelegationReviewStatus | null;
	}[];
	readonly statusMismatches: readonly (
		| {
			readonly delegation_id: string;
			readonly transaction_status: DelegationClaimAuthorityStatus;
			readonly session_status: DelegationReviewStatus | null;
			readonly claimed: readonly string[];
		}
		| {
			readonly run_id: string;
			readonly committed_outcome: WorkbenchRunClaimAuthority["outcome"];
			readonly claimed_outcome: WorkbenchRunClaimAuthority["outcome"];
		}
	)[];
}

function assistantText(message: unknown): string | undefined {
	if (ownDataValue(message, "role") !== "assistant") return undefined;
	const content = ownDataValue(message, "content");
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	const lengthValue = ownDataValue(content, "length");
	const length = typeof lengthValue === "number" && Number.isSafeInteger(lengthValue) && lengthValue >= 0
		? Math.min(lengthValue, 2_049)
		: 0;
	for (let index = 0; index < length; index += 1) {
		const block = ownDataValue(content, String(index));
		if (ownDataValue(block, "type") !== "text") continue;
		const text = ownDataValue(block, "text");
		if (typeof text === "string") parts.push(text);
	}
	return parts.join("\n");
}

/**
 * Recognize only an unambiguous user command whose entire payload is one
 * exact repair pointer. Explanations, quoted logs, and prompts containing any
 * other request remain ordinary model input.
 */
export function exactRepairCommandIdV1(prompt: string): string | undefined {
	const match = prompt.match(
		/^\s*(?:(?:执行|调用|启动)|(?:execute|call|start|run))?\s*[:：]?\s*`?repair_of\s*=\s*(\d{8}-\d{6}-[A-Za-z0-9]{4})`?\s*[。.!]?\s*$/iu,
	);
	return match?.[1];
}

function exactRepairDirectiveContentV1(
	repairOf: string,
): string {
	return [
		`[${EXACT_REPAIR_DIRECTIVE_SCHEMA}]`,
		"The raw repair pointer is compatibility input, not executable contract authority.",
		`Required action: ${repairDelegationToolActionV1(repairOf)}.`,
		"Pass only the delegation id. The tool recovers the complete immutable contract and replays an existing successor idempotently.",
		"Do not report an attempt or persistence failure until the tool returns durable successor facts.",
	].join("\n");
}

function claimClauses(text: string): string[] {
	const clauses: string[] = [];
	let fence: "`" | "~" | undefined;
	let runSection = false;
	for (const rawLine of text.split(/\r?\n/u)) {
		const trimmed = rawLine.trim();
		const marker = trimmed.match(/^(`{3,}|~{3,})/u)?.[1]?.[0] as "`" | "~" | undefined;
		if (marker !== undefined) {
			if (fence === undefined) fence = marker;
			else if (fence === marker) fence = undefined;
			continue;
		}
		if (fence !== undefined || /^\s*>/u.test(rawLine)) continue;
		if (/^["'“‘].*["'”’]$/u.test(trimmed)) continue;
		const listItem = /^\s*(?:[-*+]|\d+[.)])\s+/u.test(rawLine);
		if (runSectionHeading(trimmed)) runSection = true;
		else if (trimmed.length > 0 && !listItem) runSection = false;
		const contextualLine = runSection && listItem ? `run ${rawLine}` : rawLine;
		// Markdown inline code is the normal presentation form for persisted ids.
		// Preserve only canonical delegation-looking ids (and status tokens on a
		// delegation-labelled line); discard commands and run-only ids. Fenced
		// transcript/code evidence remains excluded above.
		const withoutInlineCode = contextualLine.replace(INLINE_CODE_RE, (whole: string, inline: string, offset: number) => {
			const prefix = contextualLine.slice(0, offset);
			const boundary = Math.max(
				prefix.lastIndexOf("."), prefix.lastIndexOf(";"), prefix.lastIndexOf("。"), prefix.lastIndexOf("；"),
				prefix.lastIndexOf("!"), prefix.lastIndexOf("?"), prefix.lastIndexOf("！"), prefix.lastIndexOf("？"),
			);
			const localLabel = prefix.slice(boundary + 1);
			const contextPrefix = `${localLabel} `;
			const suffix = contextualLine.slice(offset + whole.length);
			const contextualInline = `${contextPrefix}${inline} ${suffix}`;
			const ids = [...inline.matchAll(new RegExp(DELEGATION_ID_SCAN_RE.source, "g"))]
				.filter((match) => !idHasNearestRunLabel(contextualInline, contextPrefix.length + (match.index ?? 0)))
				.map((match) => match[0]!);
			const runLabelIndex = lastLabelIndex(contextualInline, RUN_ONLY_LABEL_RE);
			const delegationLabelIndex = lastLabelIndex(contextualInline, DELEGATION_LABEL_RE);
			const statuses = delegationLabelIndex >= runLabelIndex && delegationLabelIndex >= 0
				? [...inline.matchAll(new RegExp(STATUS_SCAN_RE.source, "gi"))].map((match) => match[0]!)
				: [];
			// `repair_of=<id>` is itself a strong delegation label. Retain that
			// label when Markdown backticks are removed so prose such as
			// `已执行 \`repair_of=...\`` cannot degrade into an unlabelled
			// historical id and evade the same-turn execution guard.
			const repairLabel = REPAIR_OF_LABEL_RE.test(inline) ? ["repair_of"] : [];
			return [...repairLabel, ...ids, ...statuses].join(" ") || " ";
		});
		// Keep comma-linked contrast clauses together. A sentence such as
		// `did not fail, but completed successfully` contains both a negated
		// audit statement and an affirmative execution claim; splitting at the
		// comma would detach the delegation id from the affirmative half.
		for (const part of withoutInlineCode.split(/[.;。；!?！？]+/u)) {
			const clause = part.trim();
			if (clause.length > 0) clauses.push(clause);
		}
	}
	return clauses;
}

function lastLabelIndex(text: string, pattern: RegExp): number {
	let last = -1;
	for (const match of text.matchAll(new RegExp(pattern.source, "giu"))) last = match.index ?? last;
	return last;
}

function firstLabelIndex(text: string, pattern: RegExp): number {
	return text.match(new RegExp(pattern.source, "iu"))?.index ?? -1;
}

function runSectionHeading(trimmed: string): boolean {
	if (trimmed.length === 0 || new RegExp(DELEGATION_ID_SCAN_RE.source).test(trimmed)) return false;
	const heading = /^#{1,6}\s+/u.test(trimmed)
		|| /^\*\*[^*]+\*\*\s*:?[：]?\s*$/u.test(trimmed)
		|| /^[^`]{1,120}[:：]\s*$/u.test(trimmed);
	return heading && RUN_ONLY_LABEL_RE.test(trimmed) && !DELEGATION_LABEL_RE.test(trimmed);
}

/**
 * Run ids and delegation ids intentionally share the same canonical shape.
 * Bind each visible occurrence to the nearest explicit label before it:
 * `delegation ID ... run ID` therefore classifies the two ids independently,
 * while an unlabeled id retains the historical delegation fail-closed path.
 */
function idHasNearestRunLabel(clause: string, idIndex: number): boolean {
	const prefix = clause.slice(0, idIndex);
	const runIndex = lastLabelIndex(prefix, RUN_ONLY_LABEL_RE);
	const delegationIndex = lastLabelIndex(prefix, DELEGATION_LABEL_RE);
	if (runIndex >= 0) return runIndex > delegationIndex;
	if (delegationIndex >= 0) return false;
	// Machine summaries commonly put the immutable id before its recipe label:
	// `ID — check:rust-test — SUCCESS`. Accept a bounded suffix label only when
	// no preceding delegation label already owns the occurrence.
	const suffix = clause.slice(idIndex + 20, idIndex + 180);
	if (!RUN_SUFFIX_LABEL_RE.test(suffix)) return false;
	const suffixRunIndex = firstLabelIndex(suffix, RUN_ONLY_LABEL_RE);
	if (suffixRunIndex < 0) return false;
	const suffixDelegationIndex = firstLabelIndex(suffix, DELEGATION_LABEL_RE);
	return suffixDelegationIndex < 0 || suffixRunIndex < suffixDelegationIndex;
}

function idHasNearestDelegationLabel(clause: string, idIndex: number): boolean {
	const prefix = clause.slice(0, idIndex);
	const delegationIndex = lastLabelIndex(prefix, DELEGATION_LABEL_RE);
	if (delegationIndex < 0) return false;
	return delegationIndex >= lastLabelIndex(prefix, RUN_ONLY_LABEL_RE)
		&& delegationIndex >= lastLabelIndex(prefix, BUILD_ONLY_LABEL_RE);
}

function statusIsDelegationOnly(status: DelegationClaimExpectedStatus): boolean {
	return !["SUCCESS", "FAILED", "FINISHED"].includes(status.status);
}

function idHasNearestNonDelegationLabel(clause: string, idIndex: number): boolean {
	if (idHasNearestRunLabel(clause, idIndex)) return true;
	const prefix = clause.slice(0, idIndex);
	const buildIndex = lastLabelIndex(prefix, BUILD_ONLY_LABEL_RE);
	if (buildIndex < 0) return false;
	return buildIndex > lastLabelIndex(prefix, DELEGATION_LABEL_RE);
}

function idHasLatestDelegationLabel(clause: string, idIndex: number): boolean {
	const prefix = clause.slice(0, idIndex);
	const latestIndex = lastLabelIndex(prefix, LATEST_DELEGATION_LABEL_RE);
	if (latestIndex < 0) return false;
	return latestIndex >= lastLabelIndex(prefix, RUN_ONLY_LABEL_RE)
		&& latestIndex >= lastLabelIndex(prefix, BUILD_ONLY_LABEL_RE);
}

interface IndexedRunOutcome {
	readonly outcome: WorkbenchRunClaimAuthority["outcome"];
	readonly start: number;
	readonly end: number;
}

function indexedRunOutcomes(segment: string): IndexedRunOutcome[] {
	const outcomes: IndexedRunOutcome[] = [];
	for (const [pattern, outcome] of [
		[RUN_SUCCESS_OUTCOME_RE, "SUCCESS"],
		[RUN_FAILURE_OUTCOME_RE, "FAILURE"],
	] as const) {
		for (const match of segment.matchAll(new RegExp(pattern.source, "giu"))) {
			const start = match.index ?? 0;
			outcomes.push({ outcome, start, end: start + match[0]!.length });
		}
	}
	return outcomes.sort((left, right) => left.start - right.start || left.end - right.end);
}

function outcomeForRunOccurrence(
	match: RegExpMatchArray,
	outcomes: readonly IndexedRunOutcome[],
): WorkbenchRunClaimAuthority["outcome"] | "AMBIGUOUS" | undefined {
	if (outcomes.length === 0) return undefined;
	const distinct = new Set(outcomes.map((outcome) => outcome.outcome));
	if (distinct.size === 1) return outcomes[0]!.outcome;
	const start = match.index ?? 0;
	const end = start + match[0]!.length;
	let nearestDistance = Number.POSITIVE_INFINITY;
	const nearest = new Set<WorkbenchRunClaimAuthority["outcome"]>();
	for (const outcome of outcomes) {
		const distance = outcome.end <= start
			? start - outcome.end
			: outcome.start >= end ? outcome.start - end : 0;
		if (distance < nearestDistance) {
			nearestDistance = distance;
			nearest.clear();
			nearest.add(outcome.outcome);
		} else if (distance === nearestDistance) {
			nearest.add(outcome.outcome);
		}
	}
	return nearest.size === 1 ? [...nearest][0] : "AMBIGUOUS";
}

function inspectWorkbenchRunClaims(text: string): {
	ids: string[];
	candidateIds: string[];
	expected: Record<string, "SUCCESS" | "FAILURE" | undefined>;
	candidateExpected: Record<string, "SUCCESS" | "FAILURE" | undefined>;
	conflictingIds: string[];
	overflow: boolean;
} {
	const ids: string[] = [];
	const candidateIds: string[] = [];
	const expected: Record<string, "SUCCESS" | "FAILURE" | undefined> = {};
	const candidateExpected: Record<string, "SUCCESS" | "FAILURE" | undefined> = {};
	const conflictingIds = new Set<string>();
	let fence: "`" | "~" | undefined;
	let runSection = false;
	for (const rawLine of text.split(/\r?\n/u)) {
		const trimmed = rawLine.trim();
		const marker = trimmed.match(/^(`{3,}|~{3,})/u)?.[1]?.[0] as "`" | "~" | undefined;
		if (marker !== undefined) {
			if (fence === undefined) fence = marker;
			else if (fence === marker) fence = undefined;
			continue;
		}
		const insideFence = fence !== undefined;
		// A fenced block can be the assistant's authoritative handoff/evidence
		// format. Explicitly labelled run ids inside it must still bind to a
		// committed run. Delegation transcript claims remain excluded by
		// claimClauses(), and blockquotes/fully quoted lines remain quotations.
		if (/^\s*>/u.test(rawLine) || /^["'“‘].*["'”’]$/u.test(trimmed)) continue;
		const listItem = /^\s*(?:[-*+]|\d+[.)])\s+/u.test(rawLine);
		if (runSectionHeading(trimmed)) runSection = true;
		else if (trimmed.length > 0 && !listItem) runSection = false;
		const contextualLine = runSection && listItem ? `run ${rawLine}` : rawLine;
		const visible = contextualLine.replace(INLINE_CODE_RE, (_whole, inline: string) => inline);
		for (const rawSegment of visible.split(/[.;；。!?！？]+/u)) {
			const segment = runEvidenceAfterUnavailableDelegationDiagnostic(rawSegment);
			if (segment.length === 0) continue;
			const outcomes = indexedRunOutcomes(segment);
			const hasSuccess = outcomes.some((outcome) => outcome.outcome === "SUCCESS");
			const hasFailure = outcomes.some((outcome) => outcome.outcome === "FAILURE");
			const completion = outcomes.length > 0 || RUN_COMPLETION_RE.test(segment);
			// A neutral pointer such as `gate: record BLOCKED (run ID)` or an
			// explicit unavailable-identity diagnostic is not a claim that a run
			// executed or completed. Positive/negative terminal outcome words still
			// require strict committed-run authority even if other prose is noisy.
			if (!completion || (RUN_UNAVAILABLE_DIAGNOSTIC_RE.test(segment) && !hasSuccess && !hasFailure)) continue;
			const allLineIds = [...segment.matchAll(new RegExp(DELEGATION_ID_SCAN_RE.source, "g"))];
			for (const match of allLineIds) {
				const id = match[0]!;
				const outcome = outcomeForRunOccurrence(match, outcomes);
				if (!insideFence && !BUILD_ONLY_LABEL_RE.test(segment) && !candidateIds.includes(id)) candidateIds.push(id);
				if (outcome === "AMBIGUOUS") {
					conflictingIds.add(id);
					continue;
				}
				if (outcome !== undefined && candidateExpected[id] !== undefined && candidateExpected[id] !== outcome) {
					conflictingIds.add(id);
				}
				candidateExpected[id] = outcome ?? candidateExpected[id];
			}
			if (!RUN_ONLY_LABEL_RE.test(segment)) continue;
			const lineMatches = allLineIds.filter((match) => idHasNearestRunLabel(segment, match.index ?? 0));
			for (const match of lineMatches) {
				const id = match[0]!;
				const outcome = outcomeForRunOccurrence(match, outcomes);
				if (!Object.hasOwn(expected, id)) ids.push(id);
				if (outcome === "AMBIGUOUS") {
					conflictingIds.add(id);
					continue;
				}
				if (outcome !== undefined && expected[id] !== undefined && expected[id] !== outcome) conflictingIds.add(id);
				expected[id] = outcome ?? expected[id];
			}
		}
	}
	return {
		ids: ids.slice(0, MAX_CLAIM_IDS),
		candidateIds: candidateIds.slice(0, MAX_CLAIM_IDS),
		expected,
		candidateExpected,
		conflictingIds: [...conflictingIds],
		overflow: ids.length > MAX_CLAIM_IDS || candidateIds.length > MAX_CLAIM_IDS,
	};
}

function statusSource(clause: string, status: string, statusIndex: number): DelegationClaimStatusSource {
	if (status === "STALE") return "session";
	const prefix = clause.slice(0, statusIndex);
	// The status renderer's `latest` line is a composite projection: active and
	// failed transaction states come from durable transaction authority, while
	// REVIEWED/PENDING_REVIEW/STALE may come from the session mirror.  Do not
	// misclassify an exact `latest ... FAILED` or `latest ... FINISHED` copy as a
	// session claim; those values are not valid session-review statuses at all.
	// Keep otherwise-unlabelled tokens unspecified so a run-result line cannot
	// become an unbound delegation-status claim.
	if (["FAILED", "FINISHED", "ABORTED", "RUNNING", "PREPARED", "COMMITTING", "RECOVERY_REQUIRED"].includes(status)) {
		return /\btransaction\b|authority\s+v2|\blatest\b/iu.test(prefix) ? "transaction" : "unspecified";
	}
	const transactionLabels = [...prefix.matchAll(/\btransaction\b|authority\s+v2/giu)];
	const sessionLabels = [...prefix.matchAll(/\blatest\b|\bsession\b|会话|review[_ ]status/giu)];
	const transactionIndex = transactionLabels.at(-1)?.index ?? -1;
	const sessionIndex = sessionLabels.at(-1)?.index ?? -1;
	if (transactionIndex > sessionIndex) return "transaction";
	if (sessionIndex > transactionIndex) return "session";
	return "unspecified";
}

function statusesIn(clause: string): DelegationClaimExpectedStatus[] {
	const seen = new Set<string>();
	const statuses: DelegationClaimExpectedStatus[] = [];
	for (const match of clause.matchAll(new RegExp(STATUS_SCAN_RE.source, "gi"))) {
		const status = match[0]!.toUpperCase();
		const source = statusSource(clause, status, match.index ?? 0);
		const key = `${source}:${status}`;
		if (seen.has(key)) continue;
		seen.add(key);
		statuses.push({ status, source });
	}
	return statuses;
}

function statusImpliesSuccess(status: string): boolean {
	return status === "SUCCESS" || status === "REVIEWED" || status === "FINISHED";
}

function addSemanticSuccess(
	statuses: DelegationClaimExpectedStatus[],
	text: string,
): DelegationClaimExpectedStatus[] {
	let result = statuses;
	if (REVIEW_PASS_FINAL_RE.test(text) && !result.some((status) => status.status === "REVIEWED" && status.source === "session")) {
		result = [...result, { status: "REVIEWED", source: "session" }];
	}
	if (!SUCCESS_WORD_RE.test(text) || result.some((status) => statusImpliesSuccess(status.status))) return result;
	return [...result, { status: "SUCCESS", source: "unspecified" }];
}

function isUnavailableDelegationDiagnostic(clause: string): boolean {
	const evidence = clause.replace(
		/\b(?:can|cannot|can't|could\s+not|may\s+not|must\s+not|should\s+not)\s+be\s+reviewed\b/giu,
		" ",
	);
	return DELEGATION_UNAVAILABLE_DIAGNOSTIC_RE.test(clause)
		&& !SUCCESS_WORD_RE.test(evidence)
		&& !ASSERTED_START_RE.test(evidence)
		&& !ASSERTED_ATTEMPT_RE.test(evidence)
		&& !REVIEW_PASS_FINAL_RE.test(evidence);
}

function runEvidenceAfterUnavailableDelegationDiagnostic(segment: string): string {
	const diagnosticBoundary = segment.search(/[,，]/u);
	if (
		diagnosticBoundary >= 0
		&& isUnavailableDelegationDiagnostic(segment.slice(0, diagnosticBoundary))
	) return segment.slice(diagnosticBoundary + 1).trim();
	return isUnavailableDelegationDiagnostic(segment) ? "" : segment;
}

function strictLegacyStatus(ledger: DelegationLedger, id: string): DelegationClaimAuthorityStatus | undefined {
	if (
		ledger.manifest.schema_version !== DELEGATION_SCHEMA_VERSION
		|| ledger.before.schema_version !== DELEGATION_SCHEMA_VERSION
		|| ledger.manifest.delegation_id !== id
		|| ledger.before.delegation_id !== id
		|| ledger.manifest.review_status !== "PENDING_REVIEW"
		|| typeof ledger.before.diff_hash !== "string"
		|| ledger.before.diff_hash.length === 0
		|| ledger.manifest.diff_hash_before !== ledger.before.diff_hash
	) return undefined;
	if (ledger.manifest.status === "running") {
		return ledger.manifest.finished_at === null
			&& ledger.manifest.diff_hash_after === null
			&& ledger.after === null
			&& ledger.workerSummary === null
			? "LEGACY_RUNNING"
			: undefined;
	}
	if (
		ledger.manifest.status !== "finished"
		|| typeof ledger.manifest.finished_at !== "string"
		|| ledger.manifest.finished_at.length === 0
		|| typeof ledger.manifest.diff_hash_after !== "string"
		|| ledger.manifest.diff_hash_after.length === 0
		|| ledger.after === null
		|| ledger.workerSummary === null
		|| ledger.after.schema_version !== DELEGATION_SCHEMA_VERSION
		|| ledger.workerSummary.schema_version !== DELEGATION_SCHEMA_VERSION
		|| ledger.after.delegation_id !== id
		|| ledger.workerSummary.delegation_id !== id
		|| ledger.after.review_status !== "PENDING_REVIEW"
		|| ledger.after.diff_hash !== ledger.manifest.diff_hash_after
		|| ledger.after.status !== ledger.workerSummary.status
		|| ledger.after.exit_code !== ledger.workerSummary.exit_code
	) return undefined;
	return ledger.after.status === "success" && ledger.after.exit_code === 0
		? "LEGACY_SUCCEEDED"
		: "LEGACY_FAILED";
}

/** Inspect affirmative prose plus explicitly labelled run evidence; quoted delegation logs remain non-authoritative. */
export function inspectDelegationClaims(message: unknown): DelegationClaimInspection | undefined {
	const text = assistantText(message);
	if (text === undefined || text.length === 0) return undefined;
	const runClaims = inspectWorkbenchRunClaims(text);
	const hasIdStatusPair = new RegExp(DELEGATION_ID_SCAN_RE.source).test(text)
		&& new RegExp(STATUS_SCAN_RE.source, "i").test(text);
	const hasWorkerExecutionPair = WORKER_WORD_RE.test(text)
		&& (EXECUTION_WORD_RE.test(text) || SUCCESS_WORD_RE.test(text));
	if (
		!DELEGATION_WORD_RE.test(text)
		&& !WORKER_MACHINE_CLAIM_RE.test(text)
		&& !hasWorkerExecutionPair
		&& !hasIdStatusPair
		&& runClaims.ids.length === 0
		&& runClaims.candidateIds.length === 0
		&& !runClaims.overflow
	) return undefined;
	const idOrder: string[] = [];
	const expectedStatuses = new Map<string, DelegationClaimExpectedStatus[]>();
	const explicitlyLatestIds = new Set<string>();
	const explicitDelegationIds = new Set<string>();
	const sameRunStartIds = new Set<string>();
	const unboundStatusClaims: DelegationClaimUnboundStatus[] = [];
	let executionClaim = false;
	let workerAttemptClaim = false;
	let workerStartClaim = false;
	let successClaim = false;
	let recentClaim = false;
	let unboundRecentClaim = false;
	let sawNegativeDelegation = false;

	for (const rawClause of claimClauses(text)) {
		const clause = rawClause.replace(BLOCKED_EXECUTION_SCAN_RE, " ");
		let affirmativeClause = clause.replace(new RegExp(NEGATED_CLAIM_SCAN_RE.source, "gi"), " ");
		const diagnosticBoundary = clause.search(/[,，]/u);
		if (diagnosticBoundary >= 0 && isUnavailableDelegationDiagnostic(clause.slice(0, diagnosticBoundary))) {
			sawNegativeDelegation = true;
			affirmativeClause = clause.slice(diagnosticBoundary + 1).trim();
		}
		if (isUnavailableDelegationDiagnostic(affirmativeClause)) {
			sawNegativeDelegation = true;
			continue;
		}
		const hasDelegationSubject = DELEGATION_WORD_RE.test(affirmativeClause)
			|| WORKER_WORD_RE.test(affirmativeClause);
		const negative = hasDelegationSubject && (NEGATED_WORD_RE.test(clause) || affirmativeClause !== clause);
		if (negative) {
			sawNegativeDelegation = true;
			if (!EXECUTION_WORD_RE.test(affirmativeClause) && !SUCCESS_WORD_RE.test(affirmativeClause)
				&& !REVIEW_PASS_FINAL_RE.test(affirmativeClause) && statusesIn(affirmativeClause).length === 0) continue;
		}
		const idMatches = [...affirmativeClause.matchAll(new RegExp(DELEGATION_ID_SCAN_RE.source, "g"))]
			.filter((match) => !idHasNearestNonDelegationLabel(affirmativeClause, match.index ?? 0));
		const plannedExecution = hasDelegationSubject && PLANNED_EXECUTION_RE.test(affirmativeClause);
		if (plannedExecution && idMatches.length === 0 && statusesIn(affirmativeClause).length === 0) continue;
		const clauseExecution = hasDelegationSubject && !plannedExecution && EXECUTION_WORD_RE.test(affirmativeClause);
		const clauseSuccess = hasDelegationSubject && !plannedExecution
			&& (SUCCESS_WORD_RE.test(affirmativeClause) || REVIEW_PASS_FINAL_RE.test(affirmativeClause));
		const exactRepairExecution = clauseExecution && REPAIR_OF_LABEL_RE.test(affirmativeClause);
		const clauseAttempt = clauseExecution && (ASSERTED_ATTEMPT_RE.test(affirmativeClause) || exactRepairExecution);
		const clauseStart = clauseExecution && ASSERTED_START_RE.test(affirmativeClause);
		const clauseRecent = (clauseAttempt || clauseStart || clauseSuccess)
			&& (RECENT_WORD_RE.test(affirmativeClause) || exactRepairExecution)
			&& (START_WORD_RE.test(affirmativeClause) || clauseAttempt || clauseSuccess);
		executionClaim ||= clauseExecution;
		workerAttemptClaim ||= clauseAttempt;
		workerStartClaim ||= clauseStart;
		successClaim ||= clauseSuccess;
		recentClaim ||= clauseRecent;
		unboundRecentClaim ||= clauseRecent && idMatches.length === 0;

		for (let index = 0; index < idMatches.length; index += 1) {
			const match = idMatches[index]!;
			const id = match[0]!;
			if (!expectedStatuses.has(id)) {
				idOrder.push(id);
				expectedStatuses.set(id, []);
			}
			if (idHasLatestDelegationLabel(affirmativeClause, match.index ?? 0)) explicitlyLatestIds.add(id);
			const nextIndex = idMatches[index + 1]?.index ?? affirmativeClause.length;
			const segment = affirmativeClause.slice(index === 0 ? 0 : (match.index ?? 0), nextIndex);
			const statuses = addSemanticSuccess(statusesIn(segment), segment);
			if (
				idHasNearestDelegationLabel(affirmativeClause, match.index ?? 0)
				|| statuses.some(statusIsDelegationOnly)
			) explicitDelegationIds.add(id);
			expectedStatuses.get(id)!.push(...statuses);
			if (clauseRecent) sameRunStartIds.add(id);
		}
		if (idMatches.length > 1 && DISTRIBUTIVE_CLAIM_RE.test(affirmativeClause)) {
			const distributedStatuses = addSemanticSuccess(statusesIn(affirmativeClause), affirmativeClause);
			if (distributedStatuses.length > 0 && distributedStatuses.every((status) => statusImpliesSuccess(status.status))) {
				for (const match of idMatches) expectedStatuses.get(match[0]!)!.push(...distributedStatuses);
			}
		}
		if (idMatches.length === 0) {
			const statuses = addSemanticSuccess(statusesIn(affirmativeClause), affirmativeClause);
			if (statuses.length > 0 && (hasDelegationSubject || statuses.some((status) => status.source !== "unspecified"))) {
				unboundStatusClaims.push({ statuses, distributive: DISTRIBUTIVE_CLAIM_RE.test(affirmativeClause) });
			}
		}
	}
	for (const id of runClaims.candidateIds) {
		if (idOrder.includes(id) || runClaims.ids.includes(id)) continue;
		idOrder.push(id);
		expectedStatuses.set(id, []);
	}

	const allIdOrder = [...idOrder];
	for (const id of runClaims.ids) if (!allIdOrder.includes(id)) allIdOrder.push(id);
	const overflow = allIdOrder.length > MAX_CLAIM_IDS || runClaims.overflow;
	const admittedIds = new Set(allIdOrder.slice(0, MAX_CLAIM_IDS));
	const ids = idOrder.filter((id) => admittedIds.has(id));
	const runIds = runClaims.ids.filter((id) => admittedIds.has(id));
	const latestIds = [...explicitlyLatestIds].filter((id) => ids.includes(id));
	const directExpectedStatuses = Object.fromEntries(ids.map((id) => [id, [...(expectedStatuses.get(id) ?? [])]]));
	let ambiguousStatusBinding = false;
	for (const claim of unboundStatusClaims) {
		if (ids.length === 1) expectedStatuses.get(ids[0]!)!.push(...claim.statuses);
		else if (ids.length > 1 && claim.distributive) {
			for (const id of ids) expectedStatuses.get(id)!.push(...claim.statuses);
		} else if (
			ids.length > 1
			&& latestIds.length === 1
			&& claim.statuses.every((status) => status.source !== "unspecified")
		) {
			expectedStatuses.get(latestIds[0]!)!.push(...claim.statuses);
		} else if (ids.length > 1) ambiguousStatusBinding = true;
	}
	const negativeOnly = sawNegativeDelegation
		&& ids.length === 0
		&& runClaims.ids.length === 0
		&& !executionClaim
		&& !successClaim;
	if (ids.length === 0 && runClaims.ids.length === 0 && !overflow && !executionClaim && !successClaim && !negativeOnly) return undefined;
	const explicitSameRunStartIds = [...sameRunStartIds].filter((id) => ids.includes(id));
	const boundSameRunStartIds = explicitSameRunStartIds.length > 0
		? explicitSameRunStartIds
		: unboundRecentClaim ? ids : [];
	return {
		ids,
		runIds,
		explicitDelegationIds: [...explicitDelegationIds].filter((id) => ids.includes(id)),
		explicitRunIds: runIds,
		expectedRunOutcomes: Object.fromEntries(runIds.map((id) => [id, runClaims.expected[id]])),
		candidateRunOutcomes: Object.fromEntries(allIdOrder.map((id) => [id, runClaims.candidateExpected[id]])),
		conflictingRunOutcomeIds: runClaims.conflictingIds.filter((id) => admittedIds.has(id)),
		directExpectedStatuses,
		expectedStatuses: Object.fromEntries(ids.map((id) => [id, expectedStatuses.get(id) ?? []])),
		unboundStatusClaims,
		explicitlyLatestIds: latestIds,
		sameRunStartIds: boundSameRunStartIds,
		executionClaim,
		workerAttemptClaim,
		workerStartClaim,
		successClaim,
		recentClaim,
		negativeOnly,
		overflow,
		ambiguousStatusBinding,
	};
}

function transactionSatisfiesStatus(status: DelegationClaimAuthorityStatus, expected: string): boolean {
	if (expected === "SUCCESS") {
		return status === "FINISHED" || status === "PENDING_REVIEW" || status === "REVIEWED" || status === "LEGACY_SUCCEEDED";
	}
	if (expected === "FINISHED") return status === "FINISHED" || status === "LEGACY_SUCCEEDED" || status === "LEGACY_FAILED";
	if (expected === "FAILED") return status === "FAILED" || status === "LEGACY_FAILED";
	if (expected === "RUNNING") return status === "RUNNING" || status === "LEGACY_RUNNING";
	return status === expected;
}

function authoritySatisfiesStatus(authority: DelegationClaimAuthority, expected: DelegationClaimExpectedStatus): boolean {
	const status = authority.status;
	if (expected.source === "transaction") return transactionSatisfiesStatus(status, expected.status);
	if (expected.source === "session") return authority.sessionStatus === expected.status;
	if (expected.status === "STALE") return authority.sessionStatus === "STALE";
	if (expected.status === "PENDING_REVIEW" || expected.status === "REVIEWED") {
		return transactionSatisfiesStatus(status, expected.status) || authority.sessionStatus === expected.status;
	}
	return transactionSatisfiesStatus(status, expected.status);
}

function committedSessionStatus(
	state: { readonly task_kind: string; readonly status: DelegationTransactionStatus },
): DelegationReviewStatus | undefined {
	// A successful diagnosis is durably terminal as transaction FINISHED. The
	// public worker result and session mirror intentionally project that same
	// zero-delta closure as review REVIEWED. Reconstruct that projection from
	// the strict committed generation after it stops being the latest session
	// item, rather than treating Pi's own earlier result as a status mismatch.
	if (state.task_kind === "diagnosis" && state.status === "FINISHED") return "REVIEWED";
	if (state.status === "PENDING_REVIEW" || state.status === "REVIEWED") return state.status;
	return undefined;
}

function authorityProvesWorkerStart(authority: DelegationClaimAuthority): boolean {
	return authority.status !== "PREPARED" && authority.status !== "ABORTED";
}

function freshStatusObservationProvesSuccess(
	claimedDelegationIds: readonly string[],
	turn: DelegationClaimTurnEvidence,
	authorityById: ReadonlyMap<string, DelegationClaimAuthority>,
): boolean {
	// A status query can authorize a retrospective summary of the latest durable
	// worker, but it must never rescue a failed delegation attempt in this run.
	if (turn.attemptedCalls !== 0 || turn.observedStatusIds.length === 0) return false;
	const observed = new Set(turn.observedStatusIds);
	const claimed = claimedDelegationIds.length > 0 ? claimedDelegationIds : [...observed];
	if (claimed.length === 0 || claimed.some((id) => !observed.has(id))) return false;
	return claimed.every((id) => {
		const authority = authorityById.get(id);
		return authority !== undefined
			&& authoritySatisfiesStatus(authority, { status: "SUCCESS", source: "transaction" });
	});
}

interface ResolvedClaimNamespaces {
	readonly delegationIds: readonly string[];
	readonly runIds: readonly string[];
	readonly expectedStatuses: Readonly<Record<string, readonly DelegationClaimExpectedStatus[]>>;
	readonly expectedRunOutcomes: Readonly<Record<string, "SUCCESS" | "FAILURE" | undefined>>;
	readonly ambiguousNamespace: boolean;
	readonly ambiguousStatusBinding: boolean;
}

/**
 * The two durable namespaces intentionally share an id shape. Strong labels
 * remain mandatory, but weak/unlabelled prose is resolved by exclusive strict
 * authority rather than by another English/Chinese word-order heuristic.
 */
function resolveClaimNamespaces(
	inspection: DelegationClaimInspection,
	authorityById: ReadonlyMap<string, DelegationClaimAuthority>,
	runAuthorityById: ReadonlyMap<string, WorkbenchRunClaimAuthority>,
): ResolvedClaimNamespaces {
	const lexicalDelegations = new Set(inspection.ids);
	const lexicalRuns = new Set(inspection.runIds);
	const explicitDelegations = new Set(inspection.explicitDelegationIds);
	const explicitRuns = new Set(inspection.explicitRunIds);
	const allIds = [...new Set([...inspection.ids, ...inspection.runIds])];
	const delegationIds: string[] = [];
	const runIds: string[] = [];
	let ambiguousNamespace = false;

	for (const id of allIds) {
		const explicitDelegation = explicitDelegations.has(id);
		const explicitRun = explicitRuns.has(id);
		if (explicitDelegation) delegationIds.push(id);
		if (explicitRun) runIds.push(id);
		if (explicitDelegation || explicitRun) continue;

		const hasDelegationAuthority = authorityById.has(id);
		const hasRunAuthority = runAuthorityById.has(id);
		if (hasDelegationAuthority && hasRunAuthority) {
			ambiguousNamespace = true;
			continue;
		}
		if (hasDelegationAuthority !== hasRunAuthority) {
			(hasDelegationAuthority ? delegationIds : runIds).push(id);
			continue;
		}
		const lexicalDelegation = lexicalDelegations.has(id);
		const lexicalRun = lexicalRuns.has(id);
		if (lexicalDelegation !== lexicalRun) {
			(lexicalDelegation ? delegationIds : runIds).push(id);
			continue;
		}
		ambiguousNamespace = true;
	}

	const expectedStatuses = new Map<string, DelegationClaimExpectedStatus[]>();
	for (const id of delegationIds) expectedStatuses.set(id, [...(inspection.directExpectedStatuses[id] ?? [])]);
	const latestIds = inspection.explicitlyLatestIds.filter((id) => expectedStatuses.has(id));
	let ambiguousStatusBinding = false;
	for (const claim of inspection.unboundStatusClaims) {
		if (delegationIds.length === 1) expectedStatuses.get(delegationIds[0]!)!.push(...claim.statuses);
		else if (delegationIds.length > 1 && claim.distributive) {
			for (const id of delegationIds) expectedStatuses.get(id)!.push(...claim.statuses);
		} else if (
			delegationIds.length > 1
			&& latestIds.length === 1
			&& claim.statuses.every((status) => status.source !== "unspecified")
		) {
			expectedStatuses.get(latestIds[0]!)!.push(...claim.statuses);
		} else if (delegationIds.length > 1) ambiguousStatusBinding = true;
	}

	return {
		delegationIds,
		runIds,
		expectedStatuses: Object.fromEntries(expectedStatuses),
		expectedRunOutcomes: Object.fromEntries(runIds.map((id) => [
			id,
			inspection.expectedRunOutcomes[id] ?? inspection.candidateRunOutcomes[id],
		])),
		ambiguousNamespace,
		ambiguousStatusBinding,
	};
}

/** Pure verdict: current-turn observations never replace strict on-disk authority. */
export function validateDelegationClaims(
	inspection: DelegationClaimInspection,
	turn: DelegationClaimTurnEvidence,
	authorities: readonly DelegationClaimAuthority[],
	runAuthorities: readonly WorkbenchRunClaimAuthority[] = [],
): DelegationClaimValidation {
	if (inspection.negativeOnly) return { ok: true };
	if (inspection.overflow) return { ok: false, code: "claim_overflow" };
	const authorityById = new Map(authorities.map((authority) => [authority.id, authority]));
	const runAuthorityById = new Map(runAuthorities.map((authority) => [authority.id, authority]));
	const resolved = resolveClaimNamespaces(inspection, authorityById, runAuthorityById);
	if (resolved.ambiguousNamespace) return { ok: false, code: "ambiguous_authority_namespace" };
	if (resolved.runIds.some((id) => inspection.conflictingRunOutcomeIds.includes(id))) {
		return { ok: false, code: "ambiguous_run_outcome" };
	}
	if (resolved.ambiguousStatusBinding) return { ok: false, code: "ambiguous_status_binding" };
	for (const id of resolved.delegationIds) {
		const authority = authorityById.get(id);
		if (!authority) return { ok: false, code: "missing_authority" };
		for (const expected of resolved.expectedStatuses[id] ?? []) {
			if (!authoritySatisfiesStatus(authority, expected)) return { ok: false, code: "status_mismatch" };
		}
	}
	for (const id of resolved.runIds) {
		const authority = runAuthorityById.get(id);
		if (!authority) return { ok: false, code: "missing_run_authority" };
		const expected = resolved.expectedRunOutcomes[id];
		if (expected !== undefined && authority.outcome !== expected) {
			return { ok: false, code: "run_status_mismatch" };
		}
	}
	const observedDurableSuccess = freshStatusObservationProvesSuccess(resolved.delegationIds, turn, authorityById);
	const sameRunStartIds = inspection.sameRunStartIds.filter((id) => resolved.delegationIds.includes(id));
	if (inspection.recentClaim && inspection.workerAttemptClaim && turn.attemptedCalls === 0) {
		return { ok: false, code: "missing_attempt_authority" };
	}
	if (inspection.recentClaim && inspection.workerStartClaim) {
		const started = new Set(turn.startedIds);
		if (started.size === 0) return { ok: false, code: "missing_started_authority" };
		if (sameRunStartIds.some((id) => !started.has(id))) {
			return { ok: false, code: "missing_started_authority" };
		}
		if (![...started].some((id) => {
			const authority = authorityById.get(id);
			return authority !== undefined && authorityProvesWorkerStart(authority);
		})) {
			return { ok: false, code: "missing_started_authority" };
		}
	}
	if (inspection.recentClaim && inspection.successClaim) {
		const successful = new Set(turn.resultIds);
		if (turn.successfulResults === 0 && !observedDurableSuccess) {
			return { ok: false, code: "missing_success_result" };
		}
		if (!observedDurableSuccess && sameRunStartIds.some((id) => !successful.has(id))) {
			return { ok: false, code: "missing_success_result" };
		}
	}
	if (inspection.workerStartClaim && !inspection.recentClaim && resolved.delegationIds.length === 0) {
		if (!authorities.some(authorityProvesWorkerStart)) return { ok: false, code: "missing_authority" };
	}
	if (inspection.successClaim && resolved.delegationIds.length === 0) {
		if (inspection.recentClaim) {
			if (turn.successfulResults === 0) {
				if (!observedDurableSuccess) return { ok: false, code: "missing_success_result" };
				return { ok: true };
			}
			const resultAuthorities = turn.startedIds
				.map((id) => authorityById.get(id))
				.filter((authority): authority is DelegationClaimAuthority => authority !== undefined);
			if (resultAuthorities.length === 0) return { ok: false, code: "missing_authority" };
			if (!resultAuthorities.some((authority) => authoritySatisfiesStatus(authority, { status: "SUCCESS", source: "transaction" }))) {
				return { ok: false, code: "status_mismatch" };
			}
		} else {
			if (authorities.length === 0) return { ok: false, code: "missing_authority" };
			if (!authorities.some((authority) => authoritySatisfiesStatus(authority, { status: "SUCCESS", source: "transaction" }))) {
				return { ok: false, code: "status_mismatch" };
			}
		}
	}
	return { ok: true };
}

function validToolCallId(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
}

function claimGuardNextAction(
	code: NonNullable<DelegationClaimValidation["code"]>,
	facts: DelegationClaimFailureFacts,
): string {
	const noDelegateCall = facts.attemptedDelegateCalls === 0
		? "no workbench_delegate_worker call occurred in this turn; do not infer a delegation registry or persistence failure; "
		: "";
	if (code === "missing_run_authority" || code === "run_status_mismatch" || code === "ambiguous_run_outcome") {
		return "query workbench_read_run for every stated run_id and report only its committed outcome";
	}
	if (code === "ambiguous_authority_namespace" || code === "ambiguous_status_binding") {
		return "query workbench_delegation_status and workbench_read_run, then restate each fact with an explicit delegation_id or run_id label";
	}
	if (code === "missing_attempt_authority" || code === "missing_started_authority" || code === "missing_success_result") {
		if (facts.attemptedDelegateCalls === 0 && facts.freshStatusFacts.length === 1) {
			const observed = facts.freshStatusFacts[0]!;
			if (observed.transaction_status === "PENDING_REVIEW" && observed.session_status === "PENDING_REVIEW") {
				return `${noDelegateCall}${repairDelegationToolActionV1(observed.delegation_id)}; it validates strict durable repair authority and fails closed before worker start when unavailable; never guess a receipt id`;
			}
		}
		return `${noDelegateCall}do not claim a current-turn worker attempt or completion; query workbench_delegation_status and follow its persisted next action`;
	}
	if (code === "missing_authority") {
		if (facts.durableAttemptFacts.length === 1) {
			const attempt = facts.durableAttemptFacts[0]!;
			if (attempt.transaction_status === "FAILED") {
				return `discard guessed delegation ids; current-turn durable delegation ${attempt.delegation_id} is FAILED; ${repairDelegationToolActionV1(attempt.delegation_id)} for the deterministic authority check, which fails closed before worker start without a strict terminal-negative decision`;
			}
			return `discard guessed delegation ids; current-turn durable delegation ${attempt.delegation_id} is ${attempt.transaction_status}; query workbench_delegation_status and follow its persisted next action`;
		}
		if (facts.freshStatusFacts.length === 1) {
			const observed = facts.freshStatusFacts[0]!;
			return `${noDelegateCall}discard guessed delegation ids; reuse verified latest delegation ${observed.delegation_id} (${observed.transaction_status}/${observed.session_status ?? "NO_SESSION_STATUS"}) and follow the already returned fresh workbench_delegation_status next action exactly; never guess delegation_id or tool-result receipt ids`;
		}
		return `${noDelegateCall}discard guessed delegation ids; query workbench_delegation_status; if its persisted next action permits delegation, call workbench_delegate_worker and report only the returned delegation_id`;
	}
	if (code === "status_mismatch") {
		return "query workbench_delegation_status and restate each machine_mismatch_fact without collapsing transaction and session status";
	}
	return "query workbench_delegation_status and follow its persisted next action; review PENDING_REVIEW or STALE, and delegate only when unblocked";
}

function claimFailureFacts(
	inspection: DelegationClaimInspection,
	turn: DelegationClaimTurnEvidence,
	authorities: readonly DelegationClaimAuthority[],
	runAuthorities: readonly WorkbenchRunClaimAuthority[],
): DelegationClaimFailureFacts {
	const authorityById = new Map(authorities.map((authority) => [authority.id, authority]));
	const runAuthorityById = new Map(runAuthorities.map((authority) => [authority.id, authority]));
	const resolved = resolveClaimNamespaces(inspection, authorityById, runAuthorityById);
	const claimedDelegations = resolved.delegationIds.length;
	const claimedRuns = resolved.runIds.length;
	const durableAttemptFacts = [...new Set(turn.startedIds)].flatMap((id) => {
		const authority = authorityById.get(id);
		return authority === undefined ? [] : [{
			delegation_id: id,
			transaction_status: authority.status,
			session_status: authority.sessionStatus ?? null,
		}];
	}).slice(0, 8);
	const freshStatusFacts = [...new Set(turn.observedStatusIds)].flatMap((id) => {
		const authority = authorityById.get(id);
		return authority === undefined ? [] : [{
			delegation_id: id,
			transaction_status: authority.status,
			session_status: authority.sessionStatus ?? null,
		}];
	}).slice(0, 8);
	const delegationStatusMismatches = resolved.delegationIds.flatMap((id) => {
		const authority = authorityById.get(id);
		if (authority === undefined) return [];
		const mismatched = (resolved.expectedStatuses[id] ?? [])
			.filter((expected) => !authoritySatisfiesStatus(authority, expected));
		if (mismatched.length === 0) return [];
		return [{
			delegation_id: id,
			transaction_status: authority.status,
			session_status: authority.sessionStatus ?? null,
			claimed: mismatched.slice(0, 8).map((expected) => `${expected.source}:${expected.status}`),
		}];
	});
	const runStatusMismatches = resolved.runIds.flatMap((id) => {
		const authority = runAuthorityById.get(id);
		const expected = resolved.expectedRunOutcomes[id];
		if (authority === undefined || expected === undefined || authority.outcome === expected) return [];
		return [{
			run_id: id,
			committed_outcome: authority.outcome,
			claimed_outcome: expected,
		}];
	});
	const statusMismatches = [...delegationStatusMismatches, ...runStatusMismatches].slice(0, 8);
	return {
		claimNamespace: claimedDelegations > 0 && claimedRuns > 0
			? "mixed"
			: claimedDelegations > 0 ? "delegation" : claimedRuns > 0 ? "run" : "implicit",
		claimedDelegations,
		verifiedDelegations: resolved.delegationIds.filter((id) => authorityById.has(id)).length,
		claimedRuns,
		verifiedRuns: resolved.runIds.filter((id) => runAuthorityById.has(id)).length,
		attemptedDelegateCalls: turn.attemptedCalls,
		successfulDelegateResults: turn.successfulResults,
		statusMismatchCount: statusMismatches.length,
		durableAttemptFacts,
		freshStatusFacts,
		statusMismatches,
	};
}

function replacementMessage(
	message: unknown,
	code: NonNullable<DelegationClaimValidation["code"]>,
	facts: DelegationClaimFailureFacts,
): Record<string, unknown> {
	const timestamp = ownDataValue(message, "timestamp");
	const provider = ownDataValue(message, "provider");
	const model = ownDataValue(message, "model");
	const api = ownDataValue(message, "api");
	const usage = ownDataValue(message, "usage");
	const rejectedText = assistantText(message) ?? "";
	const claimHash = sha256Hex(rejectedText);
	return {
		role: "assistant",
		content: [{
			type: "text",
			text: [
				DELEGATION_CLAIM_GUARD_TEXT,
				`binding_revision: ${DELEGATION_CLAIM_BINDING_REVISION}`,
				`reason: ${code}`,
				`claim_namespace: ${facts.claimNamespace}`,
				`claimed_delegation_count: ${facts.claimedDelegations}`,
				`verified_delegation_authority_count: ${facts.verifiedDelegations}`,
				`claimed_run_count: ${facts.claimedRuns}`,
				`verified_run_authority_count: ${facts.verifiedRuns}`,
				`delegate_calls_this_turn: ${facts.attemptedDelegateCalls}`,
				`successful_delegate_results_this_turn: ${facts.successfulDelegateResults}`,
				`persistence_assessment: ${facts.attemptedDelegateCalls === 0 ? "NOT_APPLICABLE_NO_DELEGATE_CALL" : "REQUIRES_DURABLE_AUTHORITY"}`,
				`durable_attempt_facts: ${JSON.stringify(facts.durableAttemptFacts)}`,
				`fresh_status_facts: ${JSON.stringify(facts.freshStatusFacts)}`,
				`status_mismatch_count: ${facts.statusMismatchCount}`,
				`machine_mismatch_facts: ${JSON.stringify(facts.statusMismatches)}`,
				`next_action: ${claimGuardNextAction(code, facts)}`,
				`claim_hash: ${claimHash}`,
			].join("\n"),
		}],
		...(typeof provider === "string" ? { provider } : {}),
		...(typeof model === "string" ? { model } : {}),
		...(typeof api === "string" ? { api } : {}),
		...(usage === undefined ? {} : { usage }),
		stopReason: "stop",
		...(typeof timestamp === "number" && Number.isFinite(timestamp) ? { timestamp } : {}),
	};
}

export interface DelegationClaimGuardController {
	pi: Pick<ExtensionAPI, "on">;
	isCommander(): boolean;
	/** Suppress only the legacy raw-repair notice while direct continuation owns the next before-agent boundary. */
	hasPendingAutomaticDeliveryContinuation?: () => boolean;
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	getDelegationState(): Pick<DelegationState, "latestId" | "status">;
	readTransaction: typeof readDelegationTransactionV2;
	readCommittedGeneration: typeof readDelegationCommittedGenerationV2;
	readReview: typeof readDelegationReviewV2;
	/** Test seam only; production omits it and uses strict storage parsing. */
	hasSemanticRepairAuthority?: (authority: unknown) => boolean;
	readLegacyLedger: typeof readDelegationLedger;
	readCommittedRun: typeof readCommittedManifest;
}

/** Register a session-local guard. It performs no writes and never invokes a worker. */
export function registerDelegationClaimGuard(controller: DelegationClaimGuardController): void {
	const attemptedCallIds = new Set<string>();
	const successfulResultIds = new Set<string>();
	const observedStatusIds = new Set<string>();
	let baselineLatestId: string | undefined;
	let baselineCaptured = false;

	const resetTurn = (): void => {
		attemptedCallIds.clear();
		successfulResultIds.clear();
		observedStatusIds.clear();
		baselineLatestId = controller.getDelegationState().latestId;
		baselineCaptured = true;
	};

	// Legacy raw repair prose is compatibility input only. Confirm that strict
	// durable semantic authority exists, then point the commander at the
	// id-only model tool. No prompt-derived contract fields become authority.
	controller.pi.on("before_agent_start", async (event, ctx) => {
		if (!controller.isCommander()) return undefined;
		try {
			if (controller.hasPendingAutomaticDeliveryContinuation?.() === true) return undefined;
		} catch {
			// A broken suppression seam cannot grant repair authority. Continue to
			// the ordinary strict compatibility readback below.
		}
		const repairOf = exactRepairCommandIdV1(event.prompt);
		if (repairOf === undefined) return undefined;
		const sessionState = controller.getDelegationState();
		if (sessionState.latestId !== repairOf || sessionState.status !== "PENDING_REVIEW") return undefined;
		try {
			const projectRoot = await controller.projectRootFor(ctx);
			const [committed, review] = await Promise.all([
				controller.readCommittedGeneration(projectRoot, repairOf),
				controller.readReview(projectRoot, repairOf),
			]);
			const hasRepairAuthority = controller.hasSemanticRepairAuthority
				?? ((authority: unknown) => hasDelegationSemanticRepairAuthorityV2(authority as never));
			if (!committed.ok || !review.ok || !hasRepairAuthority(review.value)) return undefined;
			if (exactRepairToolArgumentsV1(committed.value, repairOf) === undefined) return undefined;
			return {
				message: {
					customType: EXACT_REPAIR_DIRECTIVE_SCHEMA,
					content: exactRepairDirectiveContentV1(repairOf),
					display: false,
					details: {
						repair_of: repairOf,
					},
				},
			};
		} catch {
			// The delegate tool remains the sole write/execution authority. If the
			// exact immutable contract cannot be recovered, inject nothing and let
			// the ordinary fail-closed status path explain the unavailable route.
			return undefined;
		}
	});

	// One Pi agent run can contain many turn_start events (one before every
	// assistant/tool loop). Reset only at agent_start so a real delegation
	// result remains available to the final assistant message in the same run.
	controller.pi.on("agent_start", resetTurn);
	controller.pi.on("tool_execution_end", (event) => {
		if (event.toolName === "workbench_delegation_status") {
			if (event.isError) return;
			const result = ownDataValue(event, "result");
			const details = ownDataValue(result, "details");
			if (ownDataValue(details, "git_refresh") !== "fresh") return;
			const latestId = controller.getDelegationState().latestId;
			if (typeof latestId === "string" && DELEGATION_TRANSACTION_ID_RE.test(latestId)) {
				observedStatusIds.add(latestId);
			}
			return;
		}
		if ((event.toolName !== "workbench_delegate_worker" && event.toolName !== "workbench_repair_delegation") || event.isError) return;
		const result = ownDataValue(event, "result");
		const details = ownDataValue(result, "details");
		const id = ownDataValue(details, "delegation_id");
		const status = ownDataValue(details, "status");
		const successorStatus = ownDataValue(details, "successor_status");
		const successfulRepairSuccessor = successorStatus === "PENDING_REVIEW" || successorStatus === "REVIEWED" || successorStatus === "FINISHED";
		if (typeof id === "string" && DELEGATION_TRANSACTION_ID_RE.test(id) &&
			(status === "success" || successfulRepairSuccessor)) {
			successfulResultIds.add(id);
		}
	});

	controller.pi.on("message_end", async (event, ctx) => {
		if (!controller.isCommander()) return undefined;
		const message = ownDataValue(event, "message");
		if (ownDataValue(message, "role") !== "assistant") return undefined;
		const content = ownDataValue(message, "content");
		let hasToolCall = false;
		if (Array.isArray(content)) {
			for (let index = 0; index < content.length; index += 1) {
				const block = ownDataValue(content, String(index));
				if (ownDataValue(block, "type") !== "toolCall") continue;
				hasToolCall = true;
				const toolName = ownDataValue(block, "name");
				if (toolName !== "workbench_delegate_worker" && toolName !== "workbench_repair_delegation") continue;
				const id = validToolCallId(ownDataValue(block, "id"));
				if (id) attemptedCallIds.add(id);
			}
		}
		// A tool-call assistant message is pre-execution. Rewriting it would
		// remove the call before Pi can execute it. Validate only the later
		// terminal assistant message, after tool_execution_end has supplied facts.
		if (hasToolCall) return undefined;
		const inspection = inspectDelegationClaims(message);
		if (!inspection) return undefined;
		if (inspection.negativeOnly) return undefined;

		const authorities: DelegationClaimAuthority[] = [];
		const runAuthorities: WorkbenchRunClaimAuthority[] = [];
		const startedIds = new Set(successfulResultIds);
		try {
			const projectRoot = await controller.projectRootFor(ctx);
			const sessionState = controller.getDelegationState();
			if (
				baselineCaptured
				&& attemptedCallIds.size > 0
				&& sessionState.latestId !== undefined
				&& sessionState.latestId !== baselineLatestId
			) startedIds.add(sessionState.latestId);
			const authorityIds = new Set(inspection.ids);
			if (
				inspection.ids.length === 0
				&& (inspection.successClaim || inspection.workerStartClaim)
				&& sessionState.latestId !== undefined
			) {
				authorityIds.add(sessionState.latestId);
			}
			// A failed tool result can still leave a strict FAILED/ABORTED durable
			// transaction. Always read a same-turn changed latest id so the guard can
			// reject guessed prose while returning the real recovery authority.
			for (const id of startedIds) authorityIds.add(id);
			for (const id of observedStatusIds) authorityIds.add(id);
			const claimAuthorityIds = new Set([...authorityIds, ...inspection.runIds]);
			for (const id of claimAuthorityIds) {
				const current = await controller.readTransaction(projectRoot, id);
				if (current.ok) {
					let historicalSessionStatus: DelegationReviewStatus | undefined;
					if (["FINISHED", "PENDING_REVIEW", "REVIEWED", "FAILED"].includes(current.value.status)) {
						const committed = await controller.readCommittedGeneration(projectRoot, id);
						if (!committed.ok || committed.value.state.status !== current.value.status) continue;
						historicalSessionStatus = committedSessionStatus(committed.value.state);
					}
					authorities.push({
						id,
						status: current.value.status,
						...(sessionState.latestId === id
							? { sessionStatus: sessionState.status }
							: historicalSessionStatus === undefined ? {} : { sessionStatus: historicalSessionStatus }),
					});
				} else if (current.error.code === "not_found") {
					const legacy = await controller.readLegacyLedger(projectRoot, id);
					const legacyStatus = legacy === null ? undefined : strictLegacyStatus(legacy, id);
					if (legacyStatus !== undefined) {
						authorities.push({
							id,
							status: legacyStatus,
							...(sessionState.latestId === id ? { sessionStatus: sessionState.status } : {}),
						});
					}
				}
				const run = await controller.readCommittedRun(projectRoot, id);
				if (run === null) continue;
				runAuthorities.push({
					id,
					outcome: run.run_outcome === "SUCCESS" ? "SUCCESS" : "FAILURE",
				});
			}
		} catch {
			// An unreadable project root or authority is not execution evidence.
		}
		const turnEvidence: DelegationClaimTurnEvidence = {
			attemptedCalls: attemptedCallIds.size,
			successfulResults: successfulResultIds.size,
			resultIds: [...successfulResultIds],
			startedIds: [...startedIds],
			observedStatusIds: [...observedStatusIds],
		};
		const verdict = validateDelegationClaims(inspection, turnEvidence, authorities, runAuthorities);
		return verdict.ok ? undefined : {
			message: replacementMessage(
				message,
				verdict.code ?? "missing_authority",
				claimFailureFacts(inspection, turnEvidence, authorities, runAuthorities),
			) as never,
		};
	});
}
