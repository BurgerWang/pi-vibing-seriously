/** Fail-closed binding between commander prose and real delegation authority. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { sha256Hex } from "../cache/canonical-hash.ts";
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
	readDelegationTransactionV2,
} from "./delegation-transaction-storage.ts";
import type { DelegationReviewStatus, DelegationState } from "./delegation-state.ts";
import { ownDataValue } from "./runtime-output-controller.ts";
import type { readCommittedManifest } from "./runs.ts";

export const DELEGATION_CLAIM_GUARD_SCHEMA = "workbench-delegation-claim-guard-v1" as const;
export const DELEGATION_CLAIM_GUARD_CODE = "UNVERIFIED_EXECUTION_CLAIM" as const;
export const DELEGATION_CLAIM_GUARD_TEXT = [
	`[${DELEGATION_CLAIM_GUARD_SCHEMA}]`,
	DELEGATION_CLAIM_GUARD_CODE,
	"The assistant attempted to report delegation execution without matching machine authority.",
	"No delegation id, status, or completion claim from the rejected message is accepted.",
	"Query workbench_delegation_status and follow its persisted next action: review PENDING_REVIEW/STALE; delegate only when unblocked.",
].join("\n");

const DELEGATION_ID_SCAN_RE = /\b\d{8}-\d{6}-[A-Za-z0-9]{4}\b/g;
const STATUS_SCAN_RE = /\b(?:SUCCESS|REVIEWED|STALE|PENDING_REVIEW|RECOVERY_REQUIRED|FINISHED|FAILED|ABORTED|RUNNING|PREPARED|COMMITTING)\b/gi;
const DELEGATION_WORD_RE = /\bdelegation(?:s)?\b|委派|工作线程/i;
const WORKER_WORD_RE = /\bworker(?:s)?\b|工作线程/iu;
const WORKER_MACHINE_CLAIM_RE = /\bworker(?:s)?\b.{0,80}\b(?:SUCCESS(?:FUL(?:LY)?)?|SUCCEEDED|REVIEWED|FINISHED)\b|\bworker(?:s)?\b.{0,80}成功(?:退出|完成)?/isu;
const EXECUTION_WORD_RE = /\b(?:start(?:ed)?|launch(?:ed)?|execut(?:e|ed)|creat(?:e|ed)|return(?:ed)?|complet(?:e|ed)|attempt(?:ed)?)\b|(?:已|重新|本次|刚刚|刚才|新(?:的)?|全新(?:的)?|再次)?(?:启动|执行|调用|创建|完成|改用|返回|尝试)/i;
const SUCCESS_WORD_RE = /\b(?:SUCCESS(?:FUL(?:LY)?)?|SUCCEEDED|REVIEWED|FINISHED)\b|成功(?:退出|完成)?|已完成|已落地/i;
const NEGATED_WORD_RE = /\b(?:(?:did|does|is|was|were|has|have)\s+not|didn't|doesn't|isn't|wasn't|weren't|hasn't|haven't|never)\s+(?:start|launch|execute|create|complete|find|exist|succeed|review|finish|fail|started|launched|executed|created|completed|found|successful|reviewed|finished|failed)\b|\bno\s+delegation\b|不存在|不是|并非|未创建|未启动|未执行|没有(?:启动|执行|创建|形成)|虚构/i;
const NEGATED_CLAIM_SCAN_RE = /\b(?:(?:did|does|is|was|were|has|have)\s+not|didn't|doesn't|isn't|wasn't|weren't|hasn't|haven't|never|not)\s+(?:start|launch|execute|create|complete|find|exist|succeed|review|finish|fail|started|launched|executed|created|completed|found|successful|reviewed|finished|failed)\b|\bno\s+delegation\b|不存在|不是|并非|未创建|未启动|未执行|未完成|没有(?:启动|执行|创建|形成|完成)|并未(?:启动|执行|创建|完成)|虚构/gi;
const BLOCKED_EXECUTION_SCAN_RE = /(?:\b(?:starting|launching|creating)\b.{0,120}\bdelegation\b.{0,120}\bis blocked\b|(?:启动|开始|创建).{0,80}(?:委派|worker|工作线程).{0,80}(?:被阻止|被拦截|已阻止|无法启动))/gis;
const RECENT_WORD_RE = /\b(?:new|fresh|this\s+(?:turn|attempt|delegation)|just)\b|本次|刚刚|刚才|全新(?:的)?|新(?:的)?\s*(?:delegation|worker|工作线程|委派)|已按要求/i;
const START_WORD_RE = /\b(?:start(?:ed)?|launch(?:ed)?|creat(?:e|ed)|call(?:ed)?)\b|启动|创建|调用|改用/i;
const ASSERTED_START_RE = /\b(?:started|launched|created|called)\b|已(?:按要求)?(?:启动|创建|调用|改用)|(?:启动|创建|调用|改用)了/iu;
const PLANNED_EXECUTION_RE = /\b(?:will|can|could|should|may|might|plan(?:ned)?\s+to|need\s+to|ready\s+to|going\s+to)\b.{0,32}\b(?:start|launch|execute|create|call)\b|(?:下一步|计划|准备|打算|可以|需要).{0,24}(?:启动|执行|创建|调用|改用)/iu;
const DISTRIBUTIVE_CLAIM_RE = /\b(?:all|both|each|these|those)\b|(?:两|三|四|五|六|七|八|九|十|多)次|(?:全部|都|分别|上述|这些)/iu;
const INLINE_CODE_RE = /`([^`\r\n]*)`/gu;
const RUN_ONLY_LABEL_RE = /\b(?:run|recipe|tests?|pytest|mypy|compileall|loader|targeted|focused|audit|checks?|diff|gate(?:[-_ ]?profile)?|typecheck|lint)\b|(?:完整\s*)?G1|测试|验证|审计/iu;
const DELEGATION_LABEL_RE = /\b(?:delegation(?:s)?|worker(?:s)?|latest|authority)\b|delegation[_ ]?id|委派|工作线程/iu;
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
	readonly expectedRunOutcomes: Readonly<Record<string, "SUCCESS" | "FAILURE" | undefined>>;
	readonly expectedStatuses: Readonly<Record<string, readonly DelegationClaimExpectedStatus[]>>;
	readonly sameRunStartIds: readonly string[];
	readonly executionClaim: boolean;
	readonly workerStartClaim: boolean;
	readonly successClaim: boolean;
	readonly recentClaim: boolean;
	readonly negativeOnly: boolean;
	readonly overflow: boolean;
	readonly ambiguousStatusBinding: boolean;
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
	readonly code?: "claim_overflow" | "ambiguous_status_binding" | "missing_authority" | "status_mismatch" | "missing_started_authority" | "missing_success_result" | "missing_run_authority" | "run_status_mismatch";
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

function claimClauses(text: string): string[] {
	const clauses: string[] = [];
	let fence: "`" | "~" | undefined;
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
		// Markdown inline code is the normal presentation form for persisted ids.
		// Preserve only canonical delegation-looking ids (and status tokens on a
		// delegation-labelled line); discard commands and run-only ids. Fenced
		// transcript/code evidence remains excluded above.
		const withoutInlineCode = rawLine.replace(INLINE_CODE_RE, (_whole, inline: string, offset: number) => {
			const prefix = rawLine.slice(0, offset);
			const boundary = Math.max(
				prefix.lastIndexOf("."), prefix.lastIndexOf(";"), prefix.lastIndexOf("。"), prefix.lastIndexOf("；"),
				prefix.lastIndexOf("!"), prefix.lastIndexOf("?"), prefix.lastIndexOf("！"), prefix.lastIndexOf("？"),
			);
			const localLabel = prefix.slice(boundary + 1);
			const delegationLabeled = DELEGATION_LABEL_RE.test(localLabel);
			const runOnlyLabeled = RUN_ONLY_LABEL_RE.test(localLabel) && !delegationLabeled;
			if (runOnlyLabeled) return " ";
			const ids = [...inline.matchAll(new RegExp(DELEGATION_ID_SCAN_RE.source, "g"))].map((match) => match[0]!);
			const statuses = delegationLabeled
				? [...inline.matchAll(new RegExp(STATUS_SCAN_RE.source, "gi"))].map((match) => match[0]!)
				: [];
			return [...ids, ...statuses].join(" ") || " ";
		});
		for (const part of withoutInlineCode.split(/[.;,，。；!?！？]+/u)) {
			const clause = part.trim();
			if (clause.length > 0) clauses.push(clause);
		}
	}
	return clauses;
}

function inspectWorkbenchRunClaims(text: string): {
	ids: string[];
	expected: Record<string, "SUCCESS" | "FAILURE" | undefined>;
	overflow: boolean;
} {
	const ids: string[] = [];
	const expected: Record<string, "SUCCESS" | "FAILURE" | undefined> = {};
	for (const rawLine of text.split(/\r?\n/u)) {
		const trimmed = rawLine.trim();
		const marker = trimmed.match(/^(`{3,}|~{3,})/u)?.[1]?.[0] as "`" | "~" | undefined;
		if (marker !== undefined) continue;
		// A fenced block can be the assistant's authoritative handoff/evidence
		// format. Explicitly labelled run ids inside it must still bind to a
		// committed run. Delegation transcript claims remain excluded by
		// claimClauses(), and blockquotes/fully quoted lines remain quotations.
		if (/^\s*>/u.test(rawLine) || /^["'“‘].*["'”’]$/u.test(trimmed)) continue;
		const visible = rawLine.replace(INLINE_CODE_RE, (_whole, inline: string) => inline);
		for (const segment of visible.split(/[.;；。!?！？]+/u)) {
			if (!RUN_ONLY_LABEL_RE.test(segment) || DELEGATION_LABEL_RE.test(segment)) continue;
			if (/\b(?:not found|does not exist|missing)\b|不存在|未运行|未执行|虚构/iu.test(segment)) continue;
			const lineIds = [...segment.matchAll(new RegExp(DELEGATION_ID_SCAN_RE.source, "g"))].map((match) => match[0]!);
			const outcome = /\b(?:PASS(?:ED)?|SUCCESS(?:FUL(?:LY)?)?|OK)\b/iu.test(segment)
				? "SUCCESS" as const
				: /\b(?:FAIL(?:ED)?|EXCEPTION|CANCELLED|TIMED\s+OUT)\b/iu.test(segment)
					? "FAILURE" as const
					: undefined;
			for (const id of lineIds) {
				if (!Object.hasOwn(expected, id)) ids.push(id);
				expected[id] = outcome ?? expected[id];
			}
		}
	}
	return { ids: ids.slice(0, MAX_CLAIM_IDS), expected, overflow: ids.length > MAX_CLAIM_IDS };
}

function statusSource(clause: string, status: string, statusIndex: number): DelegationClaimStatusSource {
	if (status === "STALE") return "session";
	const prefix = clause.slice(0, statusIndex);
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
	if (!SUCCESS_WORD_RE.test(text) || statuses.some((status) => statusImpliesSuccess(status.status))) return statuses;
	return [...statuses, { status: "SUCCESS", source: "unspecified" }];
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
	if (!DELEGATION_WORD_RE.test(text) && !WORKER_MACHINE_CLAIM_RE.test(text) && !hasWorkerExecutionPair && !hasIdStatusPair && runClaims.ids.length === 0 && !runClaims.overflow) return undefined;
	const idOrder: string[] = [];
	const expectedStatuses = new Map<string, DelegationClaimExpectedStatus[]>();
	const sameRunStartIds = new Set<string>();
	const unboundStatusClaims: Array<{
		readonly statuses: readonly DelegationClaimExpectedStatus[];
		readonly distributive: boolean;
	}> = [];
	let executionClaim = false;
	let workerStartClaim = false;
	let successClaim = false;
	let recentClaim = false;
	let sawNegativeDelegation = false;

	for (const rawClause of claimClauses(text)) {
		const clause = rawClause.replace(BLOCKED_EXECUTION_SCAN_RE, " ");
		const hasDelegationSubject = DELEGATION_WORD_RE.test(clause) || WORKER_WORD_RE.test(clause);
		const negative = hasDelegationSubject && (
			NEGATED_WORD_RE.test(clause)
			|| new RegExp(NEGATED_CLAIM_SCAN_RE.source, "i").test(clause)
		);
		if (negative) {
			sawNegativeDelegation = true;
			continue;
		}
		const idMatches = [...clause.matchAll(new RegExp(DELEGATION_ID_SCAN_RE.source, "g"))];
		const plannedExecution = hasDelegationSubject && PLANNED_EXECUTION_RE.test(clause);
		if (plannedExecution && idMatches.length === 0 && statusesIn(clause).length === 0) continue;
		const clauseExecution = hasDelegationSubject && !plannedExecution && EXECUTION_WORD_RE.test(clause);
		const clauseSuccess = hasDelegationSubject && !plannedExecution && SUCCESS_WORD_RE.test(clause);
		const clauseStart = clauseExecution && ASSERTED_START_RE.test(clause);
		const clauseRecent = (clauseStart || clauseSuccess)
			&& RECENT_WORD_RE.test(clause)
			&& (START_WORD_RE.test(clause) || clauseSuccess);
		executionClaim ||= clauseExecution;
		workerStartClaim ||= clauseStart;
		successClaim ||= clauseSuccess;
		recentClaim ||= clauseRecent;

		for (let index = 0; index < idMatches.length; index += 1) {
			const match = idMatches[index]!;
			const id = match[0]!;
			if (!expectedStatuses.has(id)) {
				idOrder.push(id);
				expectedStatuses.set(id, []);
			}
			const nextIndex = idMatches[index + 1]?.index ?? clause.length;
			const segment = clause.slice(index === 0 ? 0 : (match.index ?? 0), nextIndex);
			const statuses = addSemanticSuccess(statusesIn(segment), segment);
			expectedStatuses.get(id)!.push(...statuses);
			if (clauseRecent) sameRunStartIds.add(id);
		}
		if (idMatches.length > 1 && DISTRIBUTIVE_CLAIM_RE.test(clause)) {
			const distributedStatuses = addSemanticSuccess(statusesIn(clause), clause);
			if (distributedStatuses.length > 0 && distributedStatuses.every((status) => statusImpliesSuccess(status.status))) {
				for (const match of idMatches) expectedStatuses.get(match[0]!)!.push(...distributedStatuses);
			}
		}
		if (idMatches.length === 0) {
			const statuses = addSemanticSuccess(statusesIn(clause), clause);
			if (statuses.length > 0 && (hasDelegationSubject || statuses.some((status) => status.source !== "unspecified"))) {
				unboundStatusClaims.push({ statuses, distributive: DISTRIBUTIVE_CLAIM_RE.test(clause) });
			}
		}
	}

	const overflow = idOrder.length > MAX_CLAIM_IDS || runClaims.overflow;
	const ids = idOrder.slice(0, MAX_CLAIM_IDS);
	let ambiguousStatusBinding = false;
	for (const claim of unboundStatusClaims) {
		if (ids.length === 1) expectedStatuses.get(ids[0]!)!.push(...claim.statuses);
		else if (ids.length > 1 && claim.distributive) {
			for (const id of ids) expectedStatuses.get(id)!.push(...claim.statuses);
		} else if (ids.length > 1) ambiguousStatusBinding = true;
	}
	const negativeOnly = sawNegativeDelegation && ids.length === 0 && !executionClaim && !successClaim;
	if (ids.length === 0 && runClaims.ids.length === 0 && !overflow && !executionClaim && !successClaim && !negativeOnly) return undefined;
	const boundSameRunStartIds = recentClaim ? ids : [...sameRunStartIds].filter((id) => ids.includes(id));
	return {
		ids,
		runIds: runClaims.ids,
		expectedRunOutcomes: Object.fromEntries(runClaims.ids.map((id) => [id, runClaims.expected[id]])),
		expectedStatuses: Object.fromEntries(ids.map((id) => [id, expectedStatuses.get(id) ?? []])),
		sameRunStartIds: boundSameRunStartIds,
		executionClaim,
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

function authorityProvesWorkerStart(authority: DelegationClaimAuthority): boolean {
	return authority.status !== "PREPARED" && authority.status !== "ABORTED";
}

function freshStatusObservationProvesSuccess(
	inspection: DelegationClaimInspection,
	turn: DelegationClaimTurnEvidence,
	authorityById: ReadonlyMap<string, DelegationClaimAuthority>,
): boolean {
	// A status query can authorize a retrospective summary of the latest durable
	// worker, but it must never rescue a failed delegation attempt in this run.
	if (turn.attemptedCalls !== 0 || turn.observedStatusIds.length === 0) return false;
	const observed = new Set(turn.observedStatusIds);
	const claimed = inspection.ids.length > 0 ? inspection.ids : [...observed];
	if (claimed.length === 0 || claimed.some((id) => !observed.has(id))) return false;
	return claimed.every((id) => {
		const authority = authorityById.get(id);
		return authority !== undefined
			&& authoritySatisfiesStatus(authority, { status: "SUCCESS", source: "transaction" });
	});
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
	if (inspection.ambiguousStatusBinding) return { ok: false, code: "ambiguous_status_binding" };
	const authorityById = new Map(authorities.map((authority) => [authority.id, authority]));
	for (const id of inspection.ids) {
		const authority = authorityById.get(id);
		if (!authority) return { ok: false, code: "missing_authority" };
		for (const expected of inspection.expectedStatuses[id] ?? []) {
			if (!authoritySatisfiesStatus(authority, expected)) return { ok: false, code: "status_mismatch" };
		}
	}
	const runAuthorityById = new Map(runAuthorities.map((authority) => [authority.id, authority]));
	for (const id of inspection.runIds) {
		const authority = runAuthorityById.get(id);
		if (!authority) return { ok: false, code: "missing_run_authority" };
		const expected = inspection.expectedRunOutcomes[id];
		if (expected !== undefined && authority.outcome !== expected) {
			return { ok: false, code: "run_status_mismatch" };
		}
	}
	const observedDurableSuccess = freshStatusObservationProvesSuccess(inspection, turn, authorityById);
	if (inspection.recentClaim && inspection.workerStartClaim) {
		const started = new Set(turn.startedIds);
		if (started.size === 0) return { ok: false, code: "missing_started_authority" };
		if (inspection.sameRunStartIds.some((id) => !started.has(id))) {
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
		if (!observedDurableSuccess && inspection.sameRunStartIds.some((id) => !successful.has(id))) {
			return { ok: false, code: "missing_success_result" };
		}
	}
	if (inspection.workerStartClaim && !inspection.recentClaim && inspection.ids.length === 0) {
		if (!authorities.some(authorityProvesWorkerStart)) return { ok: false, code: "missing_authority" };
	}
	if (inspection.successClaim && inspection.ids.length === 0) {
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

function replacementMessage(
	message: unknown,
	code: NonNullable<DelegationClaimValidation["code"]>,
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
		content: [{ type: "text", text: `${DELEGATION_CLAIM_GUARD_TEXT}\nreason: ${code}\nclaim_hash: ${claimHash}` }],
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
	projectRootFor(ctx: ExtensionContext): Promise<string>;
	getDelegationState(): Pick<DelegationState, "latestId" | "status">;
	readTransaction: typeof readDelegationTransactionV2;
	readCommittedGeneration: typeof readDelegationCommittedGenerationV2;
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
		if (event.toolName !== "workbench_delegate_worker" || event.isError) return;
		const result = ownDataValue(event, "result");
		const details = ownDataValue(result, "details");
		const id = ownDataValue(details, "delegation_id");
		const status = ownDataValue(details, "status");
		if (typeof id === "string" && DELEGATION_TRANSACTION_ID_RE.test(id) && status === "success") {
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
				if (ownDataValue(block, "name") !== "workbench_delegate_worker") continue;
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
			if (inspection.recentClaim || inspection.successClaim) for (const id of startedIds) authorityIds.add(id);
			for (const id of authorityIds) {
				const current = await controller.readTransaction(projectRoot, id);
				if (current.ok) {
					if (["FINISHED", "PENDING_REVIEW", "REVIEWED", "FAILED"].includes(current.value.status)) {
						const committed = await controller.readCommittedGeneration(projectRoot, id);
						if (!committed.ok || committed.value.state.status !== current.value.status) continue;
					}
					authorities.push({
						id,
						status: current.value.status,
						...(sessionState.latestId === id ? { sessionStatus: sessionState.status } : {}),
					});
					continue;
				}
				if (current.error.code !== "not_found") continue;
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
			for (const id of inspection.runIds) {
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
		const verdict = validateDelegationClaims(inspection, {
			attemptedCalls: attemptedCallIds.size,
			successfulResults: successfulResultIds.size,
			resultIds: [...successfulResultIds],
			startedIds: [...startedIds],
			observedStatusIds: [...observedStatusIds],
		}, authorities, runAuthorities);
		return verdict.ok ? undefined : { message: replacementMessage(message, verdict.code ?? "missing_authority") as never };
	});
}
