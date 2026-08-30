/** One-turn, checkpoint-bound authorization for the sole standard -> extended promotion. */

import { canonicalHash } from "../cache/canonical-hash.ts";
import {
	computeLifecycleActionSnapshotHashV2,
	validateLifecycleActionSnapshotV2,
	type LifecycleActionSnapshotV2,
} from "./delegation-lifecycle-resolver.ts";
import { validateWorkerCheckpointV1 } from "./worker-checkpoint.ts";

export const BUDGET_CONTINUATION_AUTHORIZATION_KIND_V1 =
	"budget-continuation-authorization-v1" as const;

export interface BudgetContinuationAuthorizationV1 {
	readonly schema_version: 1;
	readonly kind: typeof BUDGET_CONTINUATION_AUTHORIZATION_KIND_V1;
	readonly delegation_id: string;
	readonly checkpoint_hash: string;
	readonly target_profile: "extended";
	/** Hash only: raw user prompt text is never copied into project authority. */
	readonly prompt_hash: string;
	readonly authority_hash: string;
}

const HASH_RE = /^[0-9a-f]{64}$/u;
const DELEGATION_ID_RE = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/u;

function explicitContinuationIntent(prompt: string): boolean {
	const normalized = prompt.trim().replace(/\s+/gu, " ");
	if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > 4_096) return false;
	if (/(?:不要|不再|停止|取消|拒绝|先别|暫停|暂停)|\b(?:do\s+not|don't|stop|cancel|decline)\b/iu.test(normalized)) return false;
	const explicit = /(?:授权|授權|同意|批准|延长预算|延長預算|扩展预算|擴展預算|有界拆分|继续(?:执行|开发|处理|推进|完成)?|繼續(?:執行|開發|處理|推進|完成)?|恢复(?:执行|开发|处理|推进)?|恢復(?:執行|開發|處理|推進)?|请(?:继续|繼續|恢复|恢復|执行|執行|推进|推進)|\b(?:authorize|authorise|approved?|continue|resume|proceed)\b)/iu.test(normalized);
	if (!explicit) return false;
	// A question that merely mentions continuation is not mutation authority.
	return !/(?:为什么|為什麼|为何|為何|怎么|怎麼|如何|是否|能不能|可不可以|什么是|什麼是|吗\s*[?？]?|[?？])|\b(?:why|how|can\s+(?:it|you|we)|could\s+(?:it|you|we)|what)\b/iu.test(normalized);
}

function projection(value: Omit<BudgetContinuationAuthorizationV1, "authority_hash">): unknown {
	return value;
}

export function validateBudgetContinuationAuthorizationV1(
	value: unknown,
): value is BudgetContinuationAuthorizationV1 {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const fields = Object.keys(record).sort();
	if (fields.join("\0") !== [
		"authority_hash", "checkpoint_hash", "delegation_id", "kind", "prompt_hash", "schema_version", "target_profile",
	].sort().join("\0") || record.schema_version !== 1 || record.kind !== BUDGET_CONTINUATION_AUTHORIZATION_KIND_V1
		|| typeof record.delegation_id !== "string" || !DELEGATION_ID_RE.test(record.delegation_id)
		|| typeof record.checkpoint_hash !== "string" || !HASH_RE.test(record.checkpoint_hash)
		|| record.target_profile !== "extended"
		|| typeof record.prompt_hash !== "string" || !HASH_RE.test(record.prompt_hash)
		|| typeof record.authority_hash !== "string" || !HASH_RE.test(record.authority_hash)) return false;
	const { authority_hash: supplied, ...withoutHash } = record as unknown as BudgetContinuationAuthorizationV1;
	return supplied === canonicalHash(projection(withoutHash));
}

export interface AuthorizedBudgetContinuationTurnV1 {
	readonly authorization: Readonly<BudgetContinuationAuthorizationV1>;
	readonly snapshot: Readonly<LifecycleActionSnapshotV2>;
}

/** Consume ordinary affirmative user wording only when machine authority is exactly PAUSED_BUDGET. */
export function authorizePausedBudgetContinuationTurnV1(
	snapshot: unknown,
	prompt: string,
	checkpoint: unknown,
): AuthorizedBudgetContinuationTurnV1 | undefined {
	if (!validateLifecycleActionSnapshotV2(snapshot) || snapshot.action !== "PAUSED_BUDGET"
		|| snapshot.authorization !== "USER_REQUIRED" || snapshot.exact_target.delegation_id === undefined
		|| snapshot.exact_target.bound_hash === undefined || !explicitContinuationIntent(prompt)
		|| !validateWorkerCheckpointV1(checkpoint) || checkpoint.machine_state !== "PAUSED_BUDGET"
		|| checkpoint.remaining_budget.profile !== "standard" || checkpoint.budget_promotion !== undefined
		|| checkpoint.delegation_id !== snapshot.exact_target.delegation_id
		|| checkpoint.checkpoint_hash !== snapshot.exact_target.bound_hash) return undefined;
	const withoutHash = {
		schema_version: 1 as const,
		kind: BUDGET_CONTINUATION_AUTHORIZATION_KIND_V1,
		delegation_id: snapshot.exact_target.delegation_id,
		checkpoint_hash: snapshot.exact_target.bound_hash,
		target_profile: "extended" as const,
		prompt_hash: canonicalHash({ prompt }),
	};
	const authorization = Object.freeze({
		...withoutHash,
		authority_hash: canonicalHash(projection(withoutHash)),
	});
	const { snapshot_hash: _priorSnapshotHash, ...prior } = snapshot;
	const payload: Omit<LifecycleActionSnapshotV2, "snapshot_hash"> = {
		...prior,
		action: "CONTINUE_CHECKPOINT",
		tool: "workbench_repair_delegation",
		arguments: { delegation_id: authorization.delegation_id },
		safe_automatic: false,
		authorization: "EXISTING",
		retryable: true,
		reason_code: "USER_AUTHORIZED_BUDGET_CONTINUATION",
	};
	const authorizedSnapshot = {
		...payload,
		snapshot_hash: computeLifecycleActionSnapshotHashV2(payload),
	};
	return validateBudgetContinuationAuthorizationV1(authorization)
		&& validateLifecycleActionSnapshotV2(authorizedSnapshot)
		? Object.freeze({
			authorization,
			snapshot: Object.freeze(structuredClone(authorizedSnapshot)),
		})
		: undefined;
}
