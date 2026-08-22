/** Fail-closed binding between commander prose and real delegation authority. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { readDelegationLedger } from "./delegation-ledger.ts";
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
const WORKER_MACHINE_CLAIM_RE = /\bworker(?:s)?\b.{0,80}\b(?:SUCCESS|REVIEWED|FINISHED)\b|\bworker(?:s)?\b.{0,80}成功退出/is;
const EXECUTION_WORD_RE = /\b(?:start(?:ed)?|launch(?:ed)?|execut(?:e|ed)|creat(?:e|ed)|return(?:ed)?|complet(?:e|ed)|attempt(?:ed)?)\b|(?:已|重新|本次|刚刚|刚才|新(?:的)?|全新(?:的)?|再次)?(?:启动|执行|调用|创建|完成|改用|返回|尝试)/i;
const SUCCESS_WORD_RE = /\b(?:SUCCESS|SUCCEEDED|REVIEWED|FINISHED)\b|成功(?:退出|完成)?|已完成|已落地/i;
const NEGATED_WORD_RE = /\b(?:not|never)\s+(?:started|launched|executed|created|completed|found)\b|\bdoes\s+not\s+exist\b|不存在|未创建|未启动|未执行|没有(?:启动|执行|创建|形成)|虚构/i;
const NEGATED_CLAIM_SCAN_RE = /\b(?:not|never)\s+(?:started|launched|executed|created|completed|found|successful)\b|\bdoes\s+not\s+exist\b|不存在|未创建|未启动|未执行|未完成|没有(?:启动|执行|创建|形成|完成)|并未(?:启动|执行|创建|完成)|虚构/gi;
const BLOCKED_EXECUTION_SCAN_RE = /(?:\b(?:starting|launching|creating)\b.{0,120}\bdelegation\b.{0,120}\bis blocked\b|(?:启动|开始|创建).{0,80}(?:委派|worker|工作线程).{0,80}(?:被阻止|被拦截|已阻止|无法启动))/gis;
const RECENT_WORD_RE = /\b(?:new|fresh|this\s+(?:turn|attempt|delegation)|just)\b|本次|刚刚|刚才|全新(?:的)?|新(?:的)?\s*delegation|已按要求/i;
const LOCAL_CONTEXT_CHARS = 160;
const MAX_CLAIM_IDS = 32;

export type DelegationClaimAuthorityStatus = DelegationTransactionStatus | "LEGACY_RUNNING" | "LEGACY_FINISHED";

export interface DelegationClaimAuthority {
	readonly id: string;
	readonly status: DelegationClaimAuthorityStatus;
	readonly sessionStatus?: DelegationReviewStatus;
}

export interface DelegationClaimInspection {
	readonly ids: readonly string[];
	readonly expectedStatuses: Readonly<Record<string, readonly string[]>>;
	readonly executionClaim: boolean;
	readonly successClaim: boolean;
	readonly recentClaim: boolean;
	readonly negativeOnly: boolean;
}

export interface DelegationClaimTurnEvidence {
	readonly attemptedCalls: number;
	readonly successfulResults: number;
	readonly resultIds: readonly string[];
}

export interface DelegationClaimValidation {
	readonly ok: boolean;
	readonly code?: "missing_authority" | "status_mismatch" | "missing_call" | "missing_success_result";
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

function statusesNear(text: string, id: string): string[] {
	const statuses = new Set<string>();
	let offset = 0;
	while (offset < text.length) {
		const index = text.indexOf(id, offset);
		if (index < 0) break;
		const start = Math.max(0, index - LOCAL_CONTEXT_CHARS);
		const end = Math.min(text.length, index + id.length + LOCAL_CONTEXT_CHARS);
		for (const match of text.slice(start, end).matchAll(STATUS_SCAN_RE)) statuses.add(match[0]!.toUpperCase());
		offset = index + id.length;
	}
	return [...statuses];
}

/** Inspect only visible assistant text; reasoning blocks are never execution evidence. */
export function inspectDelegationClaims(message: unknown): DelegationClaimInspection | undefined {
	const text = assistantText(message);
	if (text === undefined || text.length === 0 || (!DELEGATION_WORD_RE.test(text) && !WORKER_MACHINE_CLAIM_RE.test(text))) return undefined;
	const ids = [...new Set(text.match(DELEGATION_ID_SCAN_RE) ?? [])].slice(0, MAX_CLAIM_IDS);
	const affirmativeText = text
		.replace(NEGATED_CLAIM_SCAN_RE, "")
		.replace(BLOCKED_EXECUTION_SCAN_RE, "");
	const executionClaim = EXECUTION_WORD_RE.test(affirmativeText);
	const successClaim = SUCCESS_WORD_RE.test(affirmativeText);
	const recentClaim = RECENT_WORD_RE.test(text);
	const negativeOnly = NEGATED_WORD_RE.test(text) && !executionClaim && !successClaim;
	if (ids.length === 0 && !executionClaim && !successClaim) return undefined;
	const expectedStatuses: Record<string, readonly string[]> = {};
	for (const id of ids) expectedStatuses[id] = statusesNear(text, id);
	return { ids, expectedStatuses, executionClaim, successClaim, recentClaim, negativeOnly };
}

function authoritySatisfiesStatus(authority: DelegationClaimAuthority, expected: string): boolean {
	const status = authority.status;
	if (expected === "SUCCESS") {
		return status === "FINISHED" || status === "PENDING_REVIEW" || status === "REVIEWED" || status === "LEGACY_FINISHED";
	}
	if (expected === "FINISHED") return status === "FINISHED" || status === "LEGACY_FINISHED";
	if (expected === "RUNNING") return status === "RUNNING" || status === "LEGACY_RUNNING";
	if (expected === "STALE") return authority.sessionStatus === "STALE";
	if (expected === "PENDING_REVIEW" || expected === "REVIEWED") {
		return status === expected || authority.sessionStatus === expected;
	}
	return status === expected;
}

/** Pure verdict: current-turn observations never replace strict on-disk authority. */
export function validateDelegationClaims(
	inspection: DelegationClaimInspection,
	turn: DelegationClaimTurnEvidence,
	authorities: readonly DelegationClaimAuthority[],
): DelegationClaimValidation {
	if (inspection.negativeOnly) return { ok: true };
	const authorityById = new Map(authorities.map((authority) => [authority.id, authority]));
	for (const id of inspection.ids) {
		const authority = authorityById.get(id);
		if (!authority) return { ok: false, code: "missing_authority" };
		for (const expected of inspection.expectedStatuses[id] ?? []) {
			if (!authoritySatisfiesStatus(authority, expected)) return { ok: false, code: "status_mismatch" };
		}
	}
	if (inspection.recentClaim && inspection.executionClaim && turn.attemptedCalls === 0) {
		return { ok: false, code: "missing_call" };
	}
	if (inspection.successClaim && inspection.ids.length === 0 && turn.successfulResults === 0) {
		return { ok: false, code: "missing_success_result" };
	}
	if (inspection.successClaim && inspection.ids.length === 0 && !turn.resultIds.some((id) => authorityById.has(id))) {
		return { ok: false, code: "missing_authority" };
	}
	return { ok: true };
}

function validToolCallId(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
}

function replacementMessage(message: unknown): Record<string, unknown> {
	const timestamp = ownDataValue(message, "timestamp");
	const provider = ownDataValue(message, "provider");
	const model = ownDataValue(message, "model");
	const api = ownDataValue(message, "api");
	const usage = ownDataValue(message, "usage");
	return {
		role: "assistant",
		content: [{ type: "text", text: DELEGATION_CLAIM_GUARD_TEXT }],
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
}

/** Register a session-local guard. It performs no writes and never invokes a worker. */
export function registerDelegationClaimGuard(controller: DelegationClaimGuardController): void {
	const attemptedCallIds = new Set<string>();
	const successfulResultIds = new Set<string>();

	const resetTurn = (): void => {
		attemptedCallIds.clear();
		successfulResultIds.clear();
	};

	// One Pi agent run can contain many turn_start events (one before every
	// assistant/tool loop). Reset only at agent_start so a real delegation
	// result remains available to the final assistant message in the same run.
	controller.pi.on("agent_start", resetTurn);
	controller.pi.on("tool_execution_end", (event) => {
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
		try {
			const projectRoot = await controller.projectRootFor(ctx);
			const sessionState = controller.getDelegationState();
			const authorityIds = new Set(inspection.ids);
			if (inspection.successClaim) for (const id of successfulResultIds) authorityIds.add(id);
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
				if (legacy) {
					authorities.push({
						id,
						status: legacy.manifest.status === "finished" ? "LEGACY_FINISHED" : "LEGACY_RUNNING",
						...(sessionState.latestId === id ? { sessionStatus: sessionState.status } : {}),
					});
				}
			}
		} catch {
			// An unreadable project root or authority is not execution evidence.
		}
		const verdict = validateDelegationClaims(inspection, {
			attemptedCalls: attemptedCallIds.size,
			successfulResults: successfulResultIds.size,
			resultIds: [...successfulResultIds],
		}, authorities);
		return verdict.ok ? undefined : { message: replacementMessage(message) as never };
	});
}
