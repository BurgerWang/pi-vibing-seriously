/** Legacy budget-promotion record validation; current runtime never mints one. */

import { canonicalHash } from "../cache/canonical-hash.ts";
import type { LifecycleActionSnapshotV2 } from "./delegation-lifecycle-resolver.ts";

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

/**
 * Retained API seam for older extensions. Worker continuation now always
 * reuses existing delegation authority, so prompt wording cannot mint a
 * budget grant and this function deliberately returns undefined.
 */
export function authorizePausedBudgetContinuationTurnV1(
	_snapshot: unknown,
	_prompt: string,
	_checkpoint: unknown,
): AuthorizedBudgetContinuationTurnV1 | undefined {
	return undefined;
}
