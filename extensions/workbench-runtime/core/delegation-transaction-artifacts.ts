/**
 * Pure construction of the immutable delegation-v2 committed record set.
 *
 * This module performs no filesystem I/O and never creates or finishes the
 * legacy v1 ledger. It accepts already-normalized bounded facts, validates
 * every transaction/contract/outcome binding, and derives the exact eight
 * records consumed by delegation-transaction-storage.ts.
 */

import { isAbsolute, posix } from "node:path";

import { canonicalHash } from "../cache/canonical-hash.ts";
import type { FinalizedDelegationChangeSetLifecycleV2 } from "./delegation-change-set-lifecycle.ts";
import { validateChangeSet, type ChangeSetRecord } from "./change-set.ts";
import {
	MAX_WORKER_REPORT_BYTES,
	parseWorkerReport,
	truncateUtf8,
	WORKER_REPORT_TRUNCATION_MARKER,
	type ParsedWorkerReport,
} from "../worker/handoff.ts";
import {
	MAX_ACCEPTANCE_CRITERIA,
	MAX_AFTER_SUMMARY_CHARS,
	MAX_ALLOWED_PATHS,
	MAX_ERROR_MESSAGE_CHARS,
	MAX_PATH_LENGTH,
	MAX_REPORT_SUMMARY_CHARS,
	MAX_STOP_REASON_CHARS,
	MAX_TASK_CHARS,
	MAX_VERIFICATION_STEPS,
	parseReportedPaths,
	type AfterFacts,
	type DelegationUsageRecord,
	type GitFacts,
	type LedgerSpendFacts,
	type LedgerWorkerFacts,
	type LedgerWorkerSummaryRecord,
} from "./delegation-ledger.ts";
import {
	DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2,
	type DelegationWorkspaceAfterFactsV2,
	type DelegationWorkspaceGitFactsV2,
} from "./delegation-workspace-v2.ts";
import { redactText } from "./redact.ts";
import {
	DELEGATION_TRANSACTION_HASH_RE,
	DELEGATION_TRANSACTION_ID_RE,
	DELEGATION_TRANSACTION_SCHEMA_VERSION,
	delegationPathAllowedV2,
	parseDelegationTransaction,
	serializeDelegationTransaction,
	type DelegationTaskKind,
	type DelegationTransactionRecord,
} from "./delegation-transaction.ts";
import {
	DELEGATION_TRANSACTION_RECORD_MAX_BYTES,
	DELEGATION_TRANSACTION_REPORT_MAX_BYTES,
	DELEGATION_TRANSACTION_SCOPE_RECORD_MAX_BYTES,
	delegationGenerationRecordRelativePathV2,
	type DelegationCommittedRecords,
} from "./delegation-transaction-storage.ts";
import { validateWorkspaceGuard, type WorkspaceGuardRecord } from "./workspace-guard.ts";
import { validateWorkerWriteJournalRecord, type WorkerWriteJournalRecord } from "./write-journal.ts";
import {
	normalizePlanReference,
	parsePlanReference,
	type PlanReferenceV1,
} from "./plan-reference.ts";
import {
	workerSpendBand,
	workerSpendDimensionFlags,
	workerSpendReasons,
	type WorkerSpendProfile,
} from "./worker-spend.ts";
import {
	canonicalWorkerContractBytes,
	normalizeWorkerContractReason,
	normalizeWorkerContractText,
	parseWorkerVerificationRecipeReference,
	stableUniqueStrings,
	workerContractComparisonKey,
	WORKER_CONTRACT_ABSOLUTE_MAX_BYTES,
	WORKER_CONTRACT_EXTENDED_REASON_MAX_CHARS,
	WORKER_CONTRACT_SOFT_MAX_BYTES,
} from "./worker-contract.ts";
import {
	validateSemanticReviewEnvelopeV1,
	type SemanticReviewEnvelopeV1,
} from "./semantic-review-envelope.ts";

const ACCEPTANCE_ITEM_MAX_CHARS = 1_000;
const VERIFICATION_ITEM_MAX_CHARS = 500;
const REPORT_WARNING_MAX_CHARS = 500;
/** Persisted v2 records may contain the retired low profile and remain readable. */
const HISTORICAL_SPEND_PROFILES: readonly WorkerSpendProfile[] = ["low", "standard", "extended"];
/** New public contracts and committed generations may use only active profiles. */
const CURRENT_SPEND_PROFILES: readonly WorkerSpendProfile[] = ["standard", "extended"];
const TASK_CONTRACT_FIELDS = [
	"task_kind",
	"task",
	"allowed_paths",
	"acceptance_criteria",
	"verification",
	"timeout_seconds",
	"budget_profile",
] as const;
const NORMALIZABLE_TASK_CONTRACT_REQUIRED_FIELDS = [
	"task_kind",
	"task",
	"allowed_paths",
	"acceptance_criteria",
] as const;
const NORMALIZABLE_TASK_CONTRACT_OPTIONAL_FIELDS = [
	"verification", "timeout_seconds", "budget_profile", "repair_of", "plan_ref", "extended_reason",
] as const;
const DELEGATION_DELTA_MISSING_STATUS_V2 = "__MISSING_STATUS_V2__";
const DELEGATION_DELTA_MISSING_DIGEST_V2 = "__MISSING_DIGEST_V2__";

export interface DelegationBoundedTaskContractPayloadV2 {
	task_kind: DelegationTaskKind;
	task: string;
	allowed_paths: string[];
	acceptance_criteria: string[];
	verification: string[];
	timeout_seconds: number;
	budget_profile: WorkerSpendProfile;
	repair_of?: string;
	plan_ref?: PlanReferenceV1;
	/** Public justification required when a new canonical contract exceeds the 12 KiB soft limit. */
	extended_reason?: string;
}

export interface DelegationBoundedTaskContractBindingV2 extends DelegationBoundedTaskContractPayloadV2 {
	contract_hash: string;
}

export type DelegationArtifactErrorCode =
	| "invalid_contract"
	| "invalid_state"
	| "binding_conflict"
	| "invalid_facts"
	| "invalid_report"
	| "review_envelope_exceeded"
	| "record_too_large";

export interface DelegationArtifactError {
	code: DelegationArtifactErrorCode;
	message: string;
}

export type DelegationArtifactResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: DelegationArtifactError };

export interface BuildDelegationCommittedArtifactsV2Input {
	transaction: DelegationTransactionRecord;
	contract: DelegationBoundedTaskContractBindingV2;
	/** Runtime validation requires the tagged branch; legacy types remain accepted at compile time for read-only callers/tests. */
	before: GitFacts | DelegationWorkspaceGitFactsV2;
	after: AfterFacts | DelegationWorkspaceAfterFactsV2;
	changeSetLifecycle: Readonly<FinalizedDelegationChangeSetLifecycleV2>;
	worker: LedgerWorkerFacts;
	reportText: string;
	secrets?: readonly string[];
	/** Required for every non-zero implementation generation written by the current runtime. */
	reviewEnvelope?: SemanticReviewEnvelopeV1;
}

export interface BuiltDelegationCommittedArtifactsV2 {
	records: DelegationCommittedRecords;
	workerSummary: LedgerWorkerSummaryRecord;
	reportComplete: boolean;
	reportTruncated: boolean;
	reportPath: string;
	reportedPaths: string[];
}

export interface DerivedDelegationPersistedReportV2 {
	persisted_text: string;
	report_complete: boolean;
	report_truncated: boolean;
	parsed_report: ParsedWorkerReport;
	reported_paths: string[];
}

function fail<T>(code: DelegationArtifactErrorCode, message: string): DelegationArtifactResult<T> {
	return { ok: false, error: { code, message: message.slice(0, 240) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const expected = [...required, ...optional.filter((field) => Object.prototype.hasOwnProperty.call(value, field))];
	const actual = Object.keys(value).sort();
	expected.sort();
	return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function isStrictRelativePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
	if (value !== value.trim() || isAbsolute(value) || value.includes("\\") || value.includes("\0")) return false;
	const normalized = posix.normalize(value);
	return normalized === value && normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
}

function isAllowedPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
	const base = value.endsWith("/**") ? value.slice(0, -3) : value.endsWith("/") ? value.slice(0, -1) : value;
	return base.length > 0 && isStrictRelativePath(base);
}

function isBoundedExactStrings(value: unknown, maxItems: number, maxChars: number): value is string[] {
	return Array.isArray(value) && value.length <= maxItems && value.every((item) =>
		typeof item === "string" && item.length > 0 && item.length <= maxChars && item === item.trim() && !item.includes("\0"));
}

function isSortedUniqueStrings(value: readonly string[]): boolean {
	return value.every((item, index) => index === 0 || value[index - 1]! < item);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cloneContractPayload(payload: DelegationBoundedTaskContractPayloadV2): DelegationBoundedTaskContractPayloadV2 {
	return {
		task_kind: payload.task_kind,
		task: payload.task,
		allowed_paths: [...payload.allowed_paths],
		acceptance_criteria: [...payload.acceptance_criteria],
		verification: [...payload.verification],
		timeout_seconds: payload.timeout_seconds,
		budget_profile: payload.budget_profile,
		...(payload.repair_of === undefined ? {} : { repair_of: payload.repair_of }),
		...(payload.plan_ref === undefined ? {} : { plan_ref: structuredClone(payload.plan_ref) }),
		...(payload.extended_reason === undefined ? {} : { extended_reason: payload.extended_reason }),
	};
}

function parseContractPayload(raw: unknown): DelegationArtifactResult<DelegationBoundedTaskContractPayloadV2> {
	if (!isRecord(raw) || !exactFields(raw, TASK_CONTRACT_FIELDS, ["repair_of", "plan_ref", "extended_reason"])) {
		return fail("invalid_contract", "delegation v2 task contract must have the exact normalized field set");
	}
	if (raw.task_kind !== "implementation" && raw.task_kind !== "diagnosis") {
		return fail("invalid_contract", "delegation v2 task kind is invalid");
	}
	if (typeof raw.task !== "string" || raw.task.length === 0 || raw.task.length > MAX_TASK_CHARS ||
		raw.task !== raw.task.trim() || raw.task.includes("\0")) {
		return fail("invalid_contract", "delegation v2 task is not normalized and bounded");
	}
	if (!Array.isArray(raw.allowed_paths) || raw.allowed_paths.length === 0 || raw.allowed_paths.length > MAX_ALLOWED_PATHS ||
		!raw.allowed_paths.every(isAllowedPath) || !isSortedUniqueStrings(raw.allowed_paths)) {
		return fail("invalid_contract", "delegation v2 allowed paths are not normalized and bounded");
	}
	if (!isBoundedExactStrings(raw.acceptance_criteria, MAX_ACCEPTANCE_CRITERIA, ACCEPTANCE_ITEM_MAX_CHARS) ||
		raw.acceptance_criteria.length === 0 ||
		!isBoundedExactStrings(raw.verification, MAX_VERIFICATION_STEPS, VERIFICATION_ITEM_MAX_CHARS)) {
		return fail("invalid_contract", "delegation v2 criteria or verification are not normalized and bounded");
	}
	if (!Number.isSafeInteger(raw.timeout_seconds) || (raw.timeout_seconds as number) < 60 || (raw.timeout_seconds as number) > 3_600) {
		return fail("invalid_contract", "delegation v2 timeout is outside the fixed bound");
	}
	if (!HISTORICAL_SPEND_PROFILES.includes(raw.budget_profile as WorkerSpendProfile)) {
		return fail("invalid_contract", "delegation v2 budget profile is invalid");
	}
	if (Object.prototype.hasOwnProperty.call(raw, "repair_of") &&
		(typeof raw.repair_of !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(raw.repair_of))) {
		return fail("invalid_contract", "delegation v2 repair pointer is invalid");
	}
	if (Object.prototype.hasOwnProperty.call(raw, "plan_ref") && parsePlanReference(raw.plan_ref) === undefined) {
		return fail("invalid_contract", "delegation v2 plan reference is invalid");
	}
	if (Object.prototype.hasOwnProperty.call(raw, "extended_reason") &&
		(typeof raw.extended_reason !== "string" || raw.extended_reason.length === 0 ||
			raw.extended_reason.length > WORKER_CONTRACT_EXTENDED_REASON_MAX_CHARS ||
			raw.extended_reason !== normalizeWorkerContractReason(raw.extended_reason) || raw.extended_reason.includes("\0") ||
			raw.budget_profile !== "extended")) {
		return fail("invalid_contract", "delegation v2 extended reason is not normalized and bounded");
	}
	const contractBytes = canonicalWorkerContractBytes(raw);
	if (contractBytes === undefined || contractBytes > WORKER_CONTRACT_ABSOLUTE_MAX_BYTES) {
		return fail("invalid_contract", `delegation v2 task contract exceeds the fixed ${WORKER_CONTRACT_ABSOLUTE_MAX_BYTES}-byte bound`);
	}
	const value = raw as unknown as DelegationBoundedTaskContractPayloadV2;
	return { ok: true, value: cloneContractPayload({
		...value,
		...(value.plan_ref === undefined ? {} : { plan_ref: parsePlanReference(value.plan_ref)! }),
	}) };
}

/** Validate an already-normalized payload and bind its deterministic hash. */
export function bindDelegationBoundedTaskContractV2(
	payload: unknown,
): DelegationArtifactResult<DelegationBoundedTaskContractBindingV2> {
	const parsed = parseContractPayload(payload);
	if (!parsed.ok) return parsed;
	try {
		const contract_hash = canonicalHash(parsed.value);
		return { ok: true, value: { ...cloneContractPayload(parsed.value), contract_hash } };
	} catch {
		return fail("invalid_contract", "delegation v2 task contract is not canonical JSON");
	}
}

/**
 * Normalize the public snake_case task values once, then pass the detached
 * payload through the strict canonical binder above.  This is intentionally
 * the only permissive edge: the binder itself never sorts, trims, defaults,
 * de-duplicates, or repairs a purportedly canonical payload.
 */
export function normalizeDelegationBoundedTaskContractV2(
	raw: unknown,
): DelegationArtifactResult<DelegationBoundedTaskContractBindingV2> {
	if (!isRecord(raw)) return fail("invalid_contract", "delegation v2 public task contract must be an object");
	const keys = Object.keys(raw);
	const allowedFields = new Set<string>([
		...NORMALIZABLE_TASK_CONTRACT_REQUIRED_FIELDS,
		...NORMALIZABLE_TASK_CONTRACT_OPTIONAL_FIELDS,
	]);
	if (!NORMALIZABLE_TASK_CONTRACT_REQUIRED_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(raw, field)) ||
		!keys.every((field) => allowedFields.has(field))) {
		return fail("invalid_contract", "delegation v2 public task contract has an invalid field set");
	}
	if (raw.task_kind !== "implementation" && raw.task_kind !== "diagnosis") {
		return fail("invalid_contract", "delegation v2 public task kind must already be resolved");
	}
	if (typeof raw.task !== "string") return fail("invalid_contract", "delegation v2 public task must be a string");
	const task = normalizeWorkerContractText(raw.task);
	if (task.length === 0 || task.length > MAX_TASK_CHARS || task.includes("\0")) {
		return fail("invalid_contract", "delegation v2 public task is empty, invalid, or exceeds its bound");
	}
	if (!Array.isArray(raw.allowed_paths) || raw.allowed_paths.length === 0 || raw.allowed_paths.length > MAX_ALLOWED_PATHS ||
		!raw.allowed_paths.every((item) => typeof item === "string")) {
		return fail("invalid_contract", "delegation v2 public allowed paths are invalid or exceed their bound");
	}
	const allowed_paths = [...new Set((raw.allowed_paths as string[]).map((item) => item.trim()))];
	if (!allowed_paths.every(isAllowedPath)) {
		return fail("invalid_contract", "delegation v2 public allowed paths contain an empty or invalid rule");
	}
	allowed_paths.sort();
	const normalizeItems = (value: unknown, maxItems: number, maxChars: number): string[] | undefined => {
		if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => typeof item === "string")) return undefined;
		const items = (value as string[]).map(normalizeWorkerContractText);
		return items.every((item) => item.length > 0 && item.length <= maxChars && !item.includes("\0"))
			? stableUniqueStrings(items, workerContractComparisonKey)
			: undefined;
	};
	const acceptance_criteria = normalizeItems(raw.acceptance_criteria, MAX_ACCEPTANCE_CRITERIA, ACCEPTANCE_ITEM_MAX_CHARS);
	const verification = raw.verification === undefined
		? []
		: normalizeItems(raw.verification, MAX_VERIFICATION_STEPS, VERIFICATION_ITEM_MAX_CHARS);
	if (acceptance_criteria === undefined || acceptance_criteria.length === 0 || verification === undefined) {
		return fail("invalid_contract", "delegation v2 public criteria or verification are invalid or exceed their bounds");
	}
	if (!verification.every((reference) => parseWorkerVerificationRecipeReference(reference) !== undefined)) {
		return fail("invalid_contract", "delegation v2 public verification must contain only recipe:<declared-name> references");
	}
	const timeout_seconds = raw.timeout_seconds === undefined ? 1_800 : raw.timeout_seconds;
	if (!Number.isSafeInteger(timeout_seconds) || (timeout_seconds as number) < 60 || (timeout_seconds as number) > 3_600) {
		return fail("invalid_contract", "delegation v2 public timeout is outside the fixed bound");
	}
	const budget_profile = raw.budget_profile === undefined ? "extended" : raw.budget_profile;
	if (!CURRENT_SPEND_PROFILES.includes(budget_profile as WorkerSpendProfile)) {
		return fail("invalid_contract", "delegation v2 public budget profile is invalid");
	}
	if (raw.repair_of !== undefined && (typeof raw.repair_of !== "string" || !DELEGATION_TRANSACTION_ID_RE.test(raw.repair_of))) {
		return fail("invalid_contract", "delegation v2 public repair pointer is invalid");
	}
	const plan_ref = raw.plan_ref === undefined ? undefined : normalizePlanReference(raw.plan_ref);
	if (raw.plan_ref !== undefined && plan_ref === undefined) {
		return fail("invalid_contract", "delegation v2 public plan reference is invalid");
	}
	const extended_reason = raw.extended_reason === undefined
		? undefined
		: typeof raw.extended_reason === "string"
			? normalizeWorkerContractReason(raw.extended_reason)
			: undefined;
	if (raw.extended_reason !== undefined &&
		(extended_reason === undefined || extended_reason.length === 0 ||
			extended_reason.length > WORKER_CONTRACT_EXTENDED_REASON_MAX_CHARS || extended_reason.includes("\0"))) {
		return fail("invalid_contract", "delegation v2 public extended reason is invalid or exceeds its bound");
	}
	if (extended_reason !== undefined && raw.budget_profile !== "extended") {
		return fail("invalid_contract", "delegation v2 extended_reason requires explicit budget_profile extended");
	}
	const payload = {
		task_kind: raw.task_kind,
		task,
		allowed_paths,
		acceptance_criteria,
		verification,
		timeout_seconds: timeout_seconds as number,
		budget_profile: budget_profile as WorkerSpendProfile,
		...(raw.repair_of === undefined ? {} : { repair_of: raw.repair_of }),
		...(plan_ref === undefined ? {} : { plan_ref }),
		...(extended_reason === undefined ? {} : { extended_reason }),
	};
	const contractBytes = canonicalWorkerContractBytes(payload);
	if (contractBytes === undefined || contractBytes > WORKER_CONTRACT_ABSOLUTE_MAX_BYTES) {
		return fail("invalid_contract", `delegation v2 public task contract exceeds the fixed ${WORKER_CONTRACT_ABSOLUTE_MAX_BYTES}-byte bound`);
	}
	if (contractBytes > WORKER_CONTRACT_SOFT_MAX_BYTES &&
		(raw.budget_profile !== "extended" || extended_reason === undefined)) {
		return fail(
			"invalid_contract",
			`delegation v2 public task contract exceeds the ${WORKER_CONTRACT_SOFT_MAX_BYTES}-byte soft limit; explicit extended budget and reason are required`,
		);
	}
	return bindDelegationBoundedTaskContractV2(payload);
}

function parseContractBinding(raw: unknown): DelegationArtifactResult<DelegationBoundedTaskContractBindingV2> {
	if (!isRecord(raw) || !DELEGATION_TRANSACTION_HASH_RE.test(String(raw.contract_hash))) {
		return fail("invalid_contract", "delegation v2 task contract binding is invalid");
	}
	const { contract_hash, ...payload } = raw;
	const bound = bindDelegationBoundedTaskContractV2(payload);
	if (!bound.ok) return bound;
	if (contract_hash !== bound.value.contract_hash) {
		return fail("binding_conflict", "delegation v2 task contract hash conflicts with its canonical payload");
	}
	return bound;
}

function validSortedUniquePaths(value: unknown): value is string[] {
	if (!Array.isArray(value) || value.length > 500 || !value.every(isStrictRelativePath)) return false;
	return value.every((path, index) => index === 0 || byteCompare(value[index - 1]!, path) < 0);
}

function validGitFacts(value: unknown, after: boolean): value is DelegationWorkspaceGitFactsV2 | DelegationWorkspaceAfterFactsV2 {
	if (!isRecord(value) || typeof value.gitDirty !== "boolean" ||
		value.diffIdentityKind !== DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2 ||
		typeof value.diffHash !== "string" || !DELEGATION_TRANSACTION_HASH_RE.test(value.diffHash) ||
		(value.gitHead !== null && (typeof value.gitHead !== "string" || !/^[a-f0-9]{40,64}$/.test(value.gitHead))) ||
		!validSortedUniquePaths(value.changedPaths) || !isRecord(value.pathStatuses) || !isRecord(value.pathDigests)) return false;
	const changed = value.changedPaths as string[];
	if (!Object.values(value.pathStatuses).every((status) => typeof status === "string" && status.length > 0 && status.length <= 4)) return false;
	const digestPaths = Object.keys(value.pathDigests).sort();
	if (!digestPaths.every(isStrictRelativePath) ||
		!Object.values(value.pathDigests).every((digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest))) return false;
	if (after) {
		if (!validSortedUniquePaths(value.changedSinceBefore)) return false;
	}
	return true;
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateWorkerFacts(worker: LedgerWorkerFacts): boolean {
	if (!isRecord(worker)) return false;
	const spendProfile = worker.spendProfile;
	if ((worker.status !== "success" && worker.status !== "failure") ||
		typeof worker.provider !== "string" || typeof worker.model !== "string" ||
		(worker.exitCode !== null && !Number.isSafeInteger(worker.exitCode)) ||
		!Number.isSafeInteger(worker.turns) || worker.turns < 0 ||
		(worker.stopReason !== null && typeof worker.stopReason !== "string") ||
		(worker.errorMessage !== null && typeof worker.errorMessage !== "string") ||
		!isRecord(worker.usage) || !isRecord(worker.usage.cost) || !isRecord(worker.budget)) return false;
	const usageValues = [worker.usage.input, worker.usage.output, worker.usage.cacheRead, worker.usage.cacheWrite,
		worker.usage.totalTokens, worker.usage.cost.input, worker.usage.cost.output, worker.usage.cost.cacheRead,
		worker.usage.cost.cacheWrite, worker.usage.cost.total];
	if (!usageValues.every(finiteNonNegative) ||
		(worker.cacheHitRatio !== null && (!finiteNonNegative(worker.cacheHitRatio) || worker.cacheHitRatio > 1))) return false;
	const budgetValues = [worker.budget.maxContextTokens, worker.budget.maxContextRatio, worker.budget.compactionCount];
	if (!budgetValues.every(finiteNonNegative) || typeof worker.budget.softBudgetReached !== "boolean" ||
		typeof worker.budget.hardBudgetExceeded !== "boolean" || !Array.isArray(worker.budget.compactionReasons) ||
		!worker.budget.compactionReasons.every((reason) => typeof reason === "string" && reason.length <= 500)) return false;
	if (spendProfile === undefined || !HISTORICAL_SPEND_PROFILES.includes(spendProfile) || !isRecord(worker.spendState) ||
		!finiteNonNegative(worker.spendState.turns) || !finiteNonNegative(worker.spendState.totalTokens) ||
		!finiteNonNegative(worker.spendState.outputTokens) || !["ok", "soft", "hard"].includes(String(worker.spendBand)) ||
		!Array.isArray(worker.spendReasons) || !worker.spendReasons.every((reason) => ["turns", "total_tokens", "output_tokens"].includes(reason)) ||
		!isRecord(worker.spendSoftReached) || !isRecord(worker.spendHardExceeded)) return false;
	for (const flags of [worker.spendSoftReached, worker.spendHardExceeded]) {
		if (Object.keys(flags).sort().join(",") !== "outputTokens,totalTokens,turns" || !Object.values(flags).every((flag) => typeof flag === "boolean")) return false;
	}
	const aggregateFallbackCeiling = worker.usage.totalTokens + worker.usage.input + worker.usage.output +
		worker.usage.cacheRead + worker.usage.cacheWrite;
	if (worker.spendState.turns !== worker.turns ||
		worker.spendState.totalTokens < worker.usage.totalTokens ||
		worker.spendState.totalTokens > aggregateFallbackCeiling ||
		worker.spendState.outputTokens !== worker.usage.output) return false;
	const expectedFlags = workerSpendDimensionFlags(worker.spendState, spendProfile);
	if (worker.spendBand !== workerSpendBand(worker.spendState, spendProfile) ||
		!sameStrings(worker.spendReasons, workerSpendReasons(worker.spendState, spendProfile)) ||
		worker.spendSoftReached.turns !== expectedFlags.soft.turns ||
		worker.spendSoftReached.totalTokens !== expectedFlags.soft.totalTokens ||
		worker.spendSoftReached.outputTokens !== expectedFlags.soft.outputTokens ||
		worker.spendHardExceeded.turns !== expectedFlags.hard.turns ||
		worker.spendHardExceeded.totalTokens !== expectedFlags.hard.totalTokens ||
		worker.spendHardExceeded.outputTokens !== expectedFlags.hard.outputTokens) return false;
	return true;
}

function cloneSpend(worker: LedgerWorkerFacts): LedgerSpendFacts {
	return {
		profile: worker.spendProfile!,
		turns: worker.spendState!.turns,
		totalTokens: worker.spendState!.totalTokens,
		outputTokens: worker.spendState!.outputTokens,
		band: worker.spendBand!,
		softReached: { ...worker.spendSoftReached! },
		hardExceeded: { ...worker.spendHardExceeded! },
		reasons: [...worker.spendReasons!],
	};
}

function boundedJson(value: unknown, name: keyof DelegationCommittedRecords): boolean {
	try {
		const encoded = JSON.stringify(value);
		const cap = name === "scope.json"
			? DELEGATION_TRANSACTION_SCOPE_RECORD_MAX_BYTES
			: DELEGATION_TRANSACTION_RECORD_MAX_BYTES;
		return encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= cap;
	} catch {
		return false;
	}
}

const FINALIZED_LIFECYCLE_FIELDS = ["prepared", "sealed_journal", "after_guard", "change_set"] as const;
const PREPARED_LIFECYCLE_FIELDS = [
	"schema_version", "project_root", "delegation_id", "contract_hash", "dependency_paths", "before_guard", "journal",
] as const;

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function samePathSetByte(left: readonly string[], right: readonly string[]): boolean {
	const leftSorted = [...left].sort(byteCompare);
	const rightSorted = [...right].sort(byteCompare);
	return sameStrings(leftSorted, rightSorted);
}

function guardMatchesGitFacts(guard: Readonly<WorkspaceGuardRecord>, facts: Readonly<DelegationWorkspaceGitFactsV2>): boolean {
	return facts.gitHead === guard.git_head && facts.gitDirty === (guard.entries.length > 0) &&
		facts.diffIdentityKind === DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2 &&
		facts.diffHash === guard.workspace_guard_hash &&
		samePathSetByte(Object.keys(facts.pathStatuses), guard.entries.map((entry) => entry.path)) &&
		guard.entries.every((entry) => facts.pathStatuses[entry.path] === entry.status);
}

function workerDeltaPaths(changeSet: Readonly<ChangeSetRecord>): string[] {
	return changeSet.worker_delta.map((entry) => entry.path);
}

function exactWorkerFileDigests(
	digests: Readonly<Record<string, string>>,
	changeSet: Readonly<ChangeSetRecord>,
	phase: "before" | "after",
): boolean {
	const expected = changeSet.worker_delta
		.filter((entry) => entry[phase].kind === "file")
		.map((entry) => entry.path);
	const actual = Object.keys(digests).sort(byteCompare);
	if (!sameStrings(actual, expected)) return false;
	return changeSet.worker_delta.every((entry) => {
		const identity = entry[phase];
		return identity.kind !== "file" || digests[entry.path] === identity.sha256;
	});
}

function validFinalizedLifecycle(
	value: unknown,
	transaction: Readonly<DelegationTransactionRecord>,
	before: Readonly<DelegationWorkspaceGitFactsV2>,
	after: Readonly<DelegationWorkspaceAfterFactsV2>,
): value is Readonly<FinalizedDelegationChangeSetLifecycleV2> {
	if (!isRecord(value) || !exactFields(value, FINALIZED_LIFECYCLE_FIELDS) ||
		!isRecord(value.prepared) || !exactFields(value.prepared, PREPARED_LIFECYCLE_FIELDS)) return false;
	const prepared = value.prepared;
	const openJournal = prepared.journal;
	const sealedJournal = value.sealed_journal;
	const beforeGuard = prepared.before_guard;
	const afterGuard = value.after_guard;
	const changeSet = value.change_set;
	if (prepared.schema_version !== 2 || typeof prepared.project_root !== "string" || !isAbsolute(prepared.project_root) ||
		prepared.delegation_id !== transaction.delegation_id || prepared.contract_hash !== transaction.contract_hash ||
		!Array.isArray(prepared.dependency_paths) ||
		!validateWorkspaceGuard(beforeGuard) || !validateWorkspaceGuard(afterGuard) ||
		!validateWorkerWriteJournalRecord(openJournal) || !validateWorkerWriteJournalRecord(sealedJournal) ||
		!validateChangeSet(changeSet)) return false;
	const open = openJournal as WorkerWriteJournalRecord;
	const sealed = sealedJournal as WorkerWriteJournalRecord;
	const beforeRecord = beforeGuard as WorkspaceGuardRecord;
	const afterRecord = afterGuard as WorkspaceGuardRecord;
	const change = changeSet as ChangeSetRecord;
	return open.state === "OPEN" && open.journal_hash === null && open.revision === 0 && open.operations.length === 0 &&
		sealed.state === "SEALED" && sealed.journal_hash !== null &&
		open.delegation_id === transaction.delegation_id && sealed.delegation_id === transaction.delegation_id &&
		open.contract_hash === transaction.contract_hash && sealed.contract_hash === transaction.contract_hash &&
		change.delegation_id === transaction.delegation_id && change.contract_hash === transaction.contract_hash &&
		change.journal_hash === sealed.journal_hash &&
		change.before_workspace_guard_hash === beforeRecord.workspace_guard_hash &&
		change.after_workspace_guard_hash === afterRecord.workspace_guard_hash &&
		change.workspace_guard_hash === afterRecord.workspace_guard_hash &&
		guardMatchesGitFacts(beforeRecord, before) && guardMatchesGitFacts(afterRecord, after) &&
		samePathSetByte(before.changedPaths, beforeRecord.entries.map((entry) => entry.path)) &&
		sameStrings(after.changedPaths, workerDeltaPaths(change)) &&
		exactWorkerFileDigests(before.pathDigests, change, "before") &&
		exactWorkerFileDigests(after.pathDigests, change, "after") &&
		sameStrings(change.dependency_paths, prepared.dependency_paths as readonly string[]);
}

/** Derive bounded, redacted report authority before the transaction enters COMMITTING. */
export function deriveDelegationPersistedReportV2(
	raw: unknown,
	secrets: readonly string[] = [],
): DelegationArtifactResult<DerivedDelegationPersistedReportV2> {
	try {
		if (typeof raw !== "string" || raw.includes("\0") || !Array.isArray(secrets) ||
			!secrets.every((secret) => typeof secret === "string")) {
			return fail("invalid_report", "worker report or redaction secrets are invalid");
		}
		let text = redactText(raw, secrets);
		if (new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text, "utf8")) !== text) {
			return fail("invalid_report", "worker report is not valid UTF-8");
		}
		let report_truncated = false;
		if (Buffer.byteLength(text, "utf8") > DELEGATION_TRANSACTION_REPORT_MAX_BYTES) {
			const markerBytes = Buffer.byteLength(WORKER_REPORT_TRUNCATION_MARKER, "utf8");
			const bodyBudget = Math.max(DELEGATION_TRANSACTION_REPORT_MAX_BYTES - markerBytes, 0);
			text = `${truncateUtf8(text, bodyBudget)}${WORKER_REPORT_TRUNCATION_MARKER}`;
			report_truncated = true;
		}
		if (Buffer.byteLength(text, "utf8") > MAX_WORKER_REPORT_BYTES) {
			return fail("invalid_report", "worker report exceeds the fixed persisted bound");
		}
		const parsed = parseWorkerReport(text);
		const reportedPaths = parseReportedPaths(text);
		return {
			ok: true,
			value: {
				persisted_text: text,
				report_complete: text.trim().length > 0 && !report_truncated && parsed.reliable,
				report_truncated,
				parsed_report: {
					...parsed,
					completed: [...parsed.completed],
					filesChangedClaims: [...parsed.filesChangedClaims],
					verificationCommands: [...parsed.verificationCommands],
					verificationObservations: [...parsed.verificationObservations],
					remainingRisks: [...parsed.remainingRisks],
					foundSections: [...parsed.foundSections],
				},
				reported_paths: [...reportedPaths],
			},
		};
	} catch {
		return fail("invalid_report", "worker report could not be safely derived");
	}
}

/**
 * Transitional S1.1 worker delta identity: only paths changed by this
 * delegation participate; pre-existing workspace dirt is excluded.  A
 * missing status/digest is represented explicitly rather than omitted.
 */
export function computeDelegationDeltaHashV2(
	after: Pick<AfterFacts, "changedSinceBefore" | "pathStatuses" | "pathDigests">,
): string {
	const paths = [...after.changedSinceBefore].sort();
	return canonicalHash({
		schema_version: DELEGATION_TRANSACTION_SCHEMA_VERSION,
		changed_since_before: paths.map((path) => ({
			path,
			status: Object.prototype.hasOwnProperty.call(after.pathStatuses, path)
				? after.pathStatuses[path]
				: DELEGATION_DELTA_MISSING_STATUS_V2,
			digest: Object.prototype.hasOwnProperty.call(after.pathDigests, path)
				? after.pathDigests[path]
				: DELEGATION_DELTA_MISSING_DIGEST_V2,
		})),
	});
}

function buildDelegationCommittedArtifactsUnchecked(
	input: BuildDelegationCommittedArtifactsV2Input,
): DelegationArtifactResult<BuiltDelegationCommittedArtifactsV2> {
	let transaction: DelegationTransactionRecord;
	try {
		const parsed = parseDelegationTransaction(serializeDelegationTransaction(input.transaction));
		if (!parsed.ok) return fail("invalid_state", "delegation transaction is not a strict v2 record");
		transaction = parsed.state;
	} catch {
		return fail("invalid_state", "delegation transaction is not a strict v2 record");
	}
	if (transaction.status !== "COMMITTING" || transaction.committed_proof !== null || transaction.terminal_outcome === null) {
		return fail("invalid_state", "delegation artifact construction requires an unpublished COMMITTING transaction");
	}
	const contractResult = parseContractBinding(input.contract);
	if (!contractResult.ok) return contractResult;
	const contract = contractResult.value;
	// The strict binder remains able to reproduce historical low contract
	// hashes for read/review compatibility. Artifact construction is the
	// current write boundary and must never publish a new low generation.
	if (!CURRENT_SPEND_PROFILES.includes(contract.budget_profile)) {
		return fail("invalid_contract", "delegation v2 low budget profile is historical-read-only");
	}
	if (contract.contract_hash !== transaction.contract_hash || contract.task_kind !== transaction.task_kind ||
		!sameStrings(contract.allowed_paths, transaction.allowed_paths)) {
		return fail("binding_conflict", "delegation task contract conflicts with the COMMITTING transaction");
	}
	if (!validGitFacts(input.before, false) || !validGitFacts(input.after, true)) {
		return fail("invalid_facts", "delegation git facts are incomplete, unbounded, or internally inconsistent");
	}
	if (!validFinalizedLifecycle(input.changeSetLifecycle, transaction, input.before, input.after)) {
		return fail("invalid_facts", "delegation finalized ChangeSet lifecycle is invalid or conflicts with the transaction");
	}
	const lifecycle = input.changeSetLifecycle;
	const changeSet = lifecycle.change_set;
	const changedPaths = workerDeltaPaths(changeSet);
	if (!changedPaths.every((path, index) => index === 0 || byteCompare(changedPaths[index - 1]!, path) < 0)) {
		return fail("invalid_facts", "delegation worker delta paths are not in canonical byte order");
	}
	const pendingReviewCandidate = transaction.task_kind === "implementation" && changedPaths.length > 0 &&
		transaction.postcondition_reasons.length === 0 && transaction.terminal_outcome.terminal_facts_complete &&
		transaction.terminal_outcome.scope_complete;
	if (pendingReviewCandidate &&
		(!validateSemanticReviewEnvelopeV1(input.reviewEnvelope) || input.reviewEnvelope.path_count !== changedPaths.length)) {
		return fail("review_envelope_exceeded", "delegation semantic review cannot be closed inside the versioned capacity envelope");
	}
	const authorityBoundPaths = new Set([
		// A journal-attributed path can be intentionally absent from both Git
		// guards (for example, a project-local ignored runtime recipe). Its
		// first/final streaming identities are already bound by the sealed
		// journal and ChangeSet, so requiring a duplicate Git-visible entry
		// would reject a valid delivery after the worker has written it.
		...changedPaths,
		...lifecycle.prepared.before_guard.entries.map((entry) => entry.path),
		...lifecycle.after_guard.entries.map((entry) => entry.path),
		...changeSet.conflicts.map((entry) => entry.path),
	]);
	if (!input.after.changedSinceBefore.every((path) => authorityBoundPaths.has(path))) {
		return fail("invalid_facts", "delegation actual changed paths are not bound to the snapshots or worker delta");
	}
	const outcome = transaction.terminal_outcome;
	const successfulWriteCount = lifecycle.sealed_journal.operations.filter((operation) =>
		operation.status === "completed" && operation.outcome === "succeeded").length;
	const scopeComplete = changedPaths.every((path) => delegationPathAllowedV2(path, transaction.allowed_paths));
	if (!sameStrings(changedPaths, outcome.changed_paths) || outcome.change_set_status !== changeSet.status ||
		outcome.terminal_facts_complete !== true || outcome.scope_complete !== scopeComplete ||
		outcome.successful_write_count !== successfulWriteCount ||
		(outcome.task_kind === "implementation" && outcome.delta_hash !== changeSet.worker_delta_hash) ||
		(outcome.task_kind === "diagnosis" && outcome.delta_hash !== null)) {
		return fail("binding_conflict", "ChangeSet authority conflicts with the terminal outcome");
	}
	if (!validateWorkerFacts(input.worker) || input.worker.exitCode !== outcome.exit_code ||
		input.worker.provider !== transaction.worker_identity.provider ||
		input.worker.model !== transaction.worker_identity.model ||
		input.worker.spendProfile !== contract.budget_profile ||
		(input.worker.turns > 0) !== outcome.provider_success) {
		return fail("binding_conflict", "worker facts conflict with the pinned transaction outcome");
	}
	const reportResult = deriveDelegationPersistedReportV2(input.reportText, input.secrets ?? []);
	if (!reportResult.ok) return reportResult;
	const report = reportResult.value;
	const parsedReport = report.parsed_report;
	const reportedPaths = report.reported_paths;
	const reportComplete = report.report_complete;
	if (reportComplete !== outcome.report_complete) {
		return fail("binding_conflict", "derived report completeness conflicts with the terminal outcome");
	}
	const reportPath = delegationGenerationRecordRelativePathV2(
		transaction.delegation_id,
		transaction.generation,
		"worker-report.md",
	);
	if (reportPath === undefined) return fail("invalid_state", "delegation generation report path is invalid");

	const reportedSet = new Set(reportedPaths);
	const actualSet = new Set(changedPaths);
	const onlyReported = reportedPaths.filter((path) => !actualSet.has(path));
	const onlyActual = changedPaths.filter((path) => !reportedSet.has(path));
	const divergence = onlyReported.length > 0 || onlyActual.length > 0
		? `reported Files Changed claims diverge from the actual diff (${onlyReported.length} claimed-only, ${onlyActual.length} actual-only)`
		: null;
	const truncationWarning = report.report_truncated ? "worker report was truncated at the fixed persisted byte bound" : null;
	const parseWarning = [parsedReport.parseWarning, truncationWarning, divergence]
		.filter((value): value is string => Boolean(value)).join("; ").slice(0, REPORT_WARNING_MAX_CHARS) || null;
	const spend = cloneSpend(input.worker);
	const safeError = input.worker.errorMessage === null
		? null
		: truncateUtf8(redactText(input.worker.errorMessage, input.secrets ?? []), MAX_ERROR_MESSAGE_CHARS);
	const safeStop = input.worker.stopReason === null ? null : truncateUtf8(input.worker.stopReason, MAX_STOP_REASON_CHARS);
	const usage = structuredClone(input.worker.usage);
	const budget = structuredClone(input.worker.budget);
	const recordedAt = transaction.updated_at;
	const workerSummary: LedgerWorkerSummaryRecord = {
		schema_version: DELEGATION_TRANSACTION_SCHEMA_VERSION,
		delegation_id: transaction.delegation_id,
		recorded_at: recordedAt,
		provider: input.worker.provider,
		model: input.worker.model,
		status: input.worker.status,
		exit_code: input.worker.exitCode,
		turns: input.worker.turns,
		stop_reason: safeStop,
		error_message: safeError,
		usage,
		cache_hit_ratio: input.worker.cacheHitRatio,
		budget,
		spend,
		report_summary: truncateUtf8(report.persisted_text, MAX_REPORT_SUMMARY_CHARS),
		changed_paths: [...changedPaths],
		completed: [...parsedReport.completed],
		verification_commands: [...parsedReport.verificationCommands],
		verification_observations: [...parsedReport.verificationObservations],
		remaining_risks: [...parsedReport.remainingRisks],
		report_path: reportPath,
		parse_warning: parseWarning,
		parse_reliable: parsedReport.reliable,
		truncated_items: parsedReport.truncatedItems,
	};
	const usageRecord: DelegationUsageRecord = {
		schema_version: DELEGATION_TRANSACTION_SCHEMA_VERSION,
		delegation_id: transaction.delegation_id,
		recorded_at: recordedAt,
		provider: input.worker.provider,
		model: input.worker.model,
		status: input.worker.status,
		exit_code: input.worker.exitCode,
		turns: input.worker.turns,
		stop_reason: safeStop,
		error_message: safeError,
		usage: structuredClone(usage),
		cache_hit_ratio: input.worker.cacheHitRatio,
		budget: structuredClone(budget),
		spend: structuredClone(spend),
	};
	const records: DelegationCommittedRecords = {
		"after.json": {
			schema_version: 2,
			diff_identity_kind: DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2,
			delegation_id: transaction.delegation_id,
			recorded_at: recordedAt,
			status: input.worker.status,
			exit_code: input.worker.exitCode,
			pinned_identity: {
				pinned_provider: transaction.worker_identity.provider,
				pinned_model: transaction.worker_identity.model,
				provider: input.worker.provider,
				model: input.worker.model,
			},
			git_head: input.after.gitHead,
			git_dirty: input.after.gitDirty,
			diff_hash: input.after.diffHash,
			changed_paths: [...changedPaths],
			path_statuses: { ...input.after.pathStatuses },
			path_digests: { ...input.after.pathDigests },
			changed_since_before: [...input.after.changedSinceBefore],
			workspace_guard: structuredClone(lifecycle.after_guard),
			change_set_status: changeSet.status,
			worker_delta_hash: changeSet.worker_delta_hash,
			workspace_guard_hash: changeSet.workspace_guard_hash,
			change_set_hash: changeSet.change_set_hash,
			reported_paths: [...reportedPaths],
			usage: structuredClone(usage),
			budget: structuredClone(budget),
			report_summary: truncateUtf8(report.persisted_text, MAX_AFTER_SUMMARY_CHARS),
			review_status: "PENDING_REVIEW",
			...(pendingReviewCandidate ? { review_envelope: structuredClone(input.reviewEnvelope!) } : {}),
		},
		"before.json": {
			schema_version: 2,
			diff_identity_kind: DELEGATION_WORKSPACE_DIFF_IDENTITY_KIND_V2,
			delegation_id: transaction.delegation_id,
			recorded_at: transaction.created_at,
			contract: structuredClone(contract),
			git_head: input.before.gitHead,
			git_dirty: input.before.gitDirty,
			diff_hash: input.before.diffHash,
			changed_paths: [...input.before.changedPaths],
			path_statuses: { ...input.before.pathStatuses },
			path_digests: { ...input.before.pathDigests },
			workspace_guard: structuredClone(lifecycle.prepared.before_guard),
		},
		"identity.json": {
			schema_version: 2,
			delegation_id: transaction.delegation_id,
			task_kind: transaction.task_kind,
			contract_hash: transaction.contract_hash,
			generation: transaction.generation,
			revision: transaction.revision,
			worker_identity: { ...transaction.worker_identity },
		},
		"review.json": {
			schema_version: 2,
			delegation_id: transaction.delegation_id,
			recorded_at: recordedAt,
			review_status: "PENDING_REVIEW",
			message: transaction.task_kind === "diagnosis"
				? "diagnosis completed without a mutable review artifact"
				: "review pending in the separate v2 review authority store",
		},
		"scope.json": {
			schema_version: 2,
			delegation_id: transaction.delegation_id,
			task_kind: transaction.task_kind,
			contract_hash: transaction.contract_hash,
			allowed_paths: [...transaction.allowed_paths],
			changed_paths: [...outcome.changed_paths],
			write_journal: structuredClone(lifecycle.sealed_journal),
			change_set: structuredClone(changeSet),
		},
		"usage.json": usageRecord,
		"worker-report.md": report.persisted_text,
		"worker-summary.json": workerSummary,
	};
	if (Object.entries(records).some(([name, value]) => name !== "worker-report.md" &&
		!boundedJson(value, name as keyof DelegationCommittedRecords))) {
		return fail("record_too_large", "delegation v2 committed JSON record exceeds its fixed byte bound");
	}
	return {
		ok: true,
		value: {
			records,
			workerSummary,
			reportComplete,
			reportTruncated: report.report_truncated,
			reportPath,
			reportedPaths: [...reportedPaths],
		},
	};
}

/** Build the exact immutable v2 record set without performing any writes. */
export function buildDelegationCommittedArtifactsV2(
	input: BuildDelegationCommittedArtifactsV2Input,
): DelegationArtifactResult<BuiltDelegationCommittedArtifactsV2> {
	try {
		return buildDelegationCommittedArtifactsUnchecked(input);
	} catch {
		return fail("invalid_facts", "delegation v2 artifact input could not be safely evaluated");
	}
}
