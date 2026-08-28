/** Test-only legacy v1 ledger writer. Production keeps this schema read-only. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	DELEGATION_SCHEMA_VERSION,
	MAX_AFTER_SUMMARY_CHARS,
	MAX_ERROR_MESSAGE_CHARS,
	MAX_REPORT_SUMMARY_CHARS,
	MAX_STOP_REASON_CHARS,
	boundLedgerContract,
	computeDiffHash,
	delegationDirFor,
	delegationReportPath,
	isValidDelegationId,
	parseReportedPaths,
	writeJsonAtomic,
	writeTextAtomic,
	type DelegationManifest,
	type DelegationUsageRecord,
	type FinishDelegationInput,
	type FinishLedgerResult,
	type GitFacts,
	type LedgerAfterRecord,
	type LedgerBeforeRecord,
	type LedgerContract,
	type LedgerResult,
	type LedgerSpendFacts,
	type LedgerWorkerSummaryRecord,
	type PendingReviewPlaceholder,
} from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import { redactText } from "../extensions/workbench-runtime/core/redact.ts";
import {
	MAX_WORKER_REPORT_BYTES,
	parseWorkerReport,
	truncateUtf8,
	WORKER_REPORT_FILE_NAME,
	WORKER_REPORT_TRUNCATION_MARKER,
	WORKER_SUMMARY_FILE_NAME,
	WORKER_USAGE_FILE_NAME,
} from "../extensions/workbench-runtime/worker/handoff.ts";

export async function createLegacyDelegationFixture(
	projectRoot: string,
	delegationId: string,
	rawContract: LedgerContract,
	before: GitFacts,
	now: string,
): Promise<LedgerResult> {
	if (!isValidDelegationId(delegationId)) return { ok: false, error: `invalid delegation id "${delegationId}"` };
	const bounded = boundLedgerContract(rawContract);
	if (!bounded.ok) return bounded;
	const dir = delegationDirFor(projectRoot, delegationId);
	const beforeHash = computeDiffHash(before.changedPaths, before.pathDigests, before.pathStatuses);
	const manifest: DelegationManifest = {
		schema_version: DELEGATION_SCHEMA_VERSION,
		delegation_id: delegationId,
		created_at: now,
		finished_at: null,
		status: "running",
		review_status: "PENDING_REVIEW",
		git_head_before: before.gitHead,
		git_dirty_before: before.gitDirty,
		diff_hash_before: beforeHash,
		diff_hash_after: null,
		changed_path_count_before: before.changedPaths.length,
		changed_path_count_after: null,
		changed_since_before_count: null,
	};
	const beforeRecord: LedgerBeforeRecord = {
		schema_version: DELEGATION_SCHEMA_VERSION,
		delegation_id: delegationId,
		recorded_at: now,
		contract: bounded.contract,
		git_head: before.gitHead,
		git_dirty: before.gitDirty,
		diff_hash: beforeHash,
		changed_paths: [...before.changedPaths],
		path_statuses: { ...before.pathStatuses },
		path_digests: { ...before.pathDigests },
	};
	try {
		await writeJsonAtomic(dir, "manifest.json", manifest);
		await writeJsonAtomic(dir, "before.json", beforeRecord);
		return { ok: true, dir };
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}
}

export async function finishLegacyDelegationFixture(
	projectRoot: string,
	delegationId: string,
	input: FinishDelegationInput,
): Promise<FinishLedgerResult> {
	if (!isValidDelegationId(delegationId)) return { ok: false, error: `invalid delegation id "${delegationId}"` };
	const dir = delegationDirFor(projectRoot, delegationId);
	const redact = (text: string): string => redactText(text, input.secrets ?? []);
	const safeReportText = redact(input.reportText ?? input.worker.reportSummary);
	const parsed = parseWorkerReport(safeReportText);
	const reportedPaths = parseReportedPaths(safeReportText);
	const reportPath = delegationReportPath(projectRoot, delegationId);
	let spend: LedgerSpendFacts | undefined;
	if (input.worker.spendProfile !== undefined && input.worker.spendState !== undefined &&
		input.worker.spendBand !== undefined && input.worker.spendReasons !== undefined &&
		input.worker.spendSoftReached !== undefined && input.worker.spendHardExceeded !== undefined) {
		spend = {
			profile: input.worker.spendProfile,
			turns: input.worker.spendState.turns,
			totalTokens: input.worker.spendState.totalTokens,
			outputTokens: input.worker.spendState.outputTokens,
			band: input.worker.spendBand,
			softReached: { ...input.worker.spendSoftReached },
			hardExceeded: { ...input.worker.spendHardExceeded },
			reasons: [...input.worker.spendReasons],
		};
	}
	const reportedSet = new Set(reportedPaths);
	const actualSet = new Set(input.after.changedSinceBefore);
	const onlyReported = reportedPaths.filter((path) => !actualSet.has(path));
	const onlyActual = input.after.changedSinceBefore.filter((path) => !reportedSet.has(path));
	const divergence = reportedPaths.length === 0 && input.after.changedSinceBefore.length > 0
		? ["report has no parseable Files Changed claims but the actual diff has changed paths"]
		: onlyReported.length > 0 || onlyActual.length > 0
			? [`reported Files Changed claims diverge from the actual diff (${onlyReported.length} claimed-only, ${onlyActual.length} actual-only)`]
			: [];
	const parseWarning = [parsed.parseWarning, ...divergence].filter((value): value is string => Boolean(value)).join("; ").slice(0, 500) || null;
	const common = {
		schema_version: DELEGATION_SCHEMA_VERSION,
		delegation_id: delegationId,
		recorded_at: input.now,
		status: input.worker.status,
		...(input.worker.workerSuccess === undefined ? {} : { worker_success: input.worker.workerSuccess }),
		...(input.worker.workerFailureCode === undefined ? {} : { worker_failure_code: input.worker.workerFailureCode }),
		exit_code: input.worker.exitCode,
	} as const;
	const afterRecord: LedgerAfterRecord = {
		...common,
		pinned_identity: { pinned_provider: "deepseek", pinned_model: "deepseek-v4-flash", provider: input.worker.provider, model: input.worker.model },
		git_head: input.after.gitHead,
		git_dirty: input.after.gitDirty,
		diff_hash: input.after.diffHash,
		changed_paths: [...input.after.changedPaths],
		path_statuses: { ...input.after.pathStatuses },
		path_digests: { ...input.after.pathDigests },
		changed_since_before: [...input.after.changedSinceBefore],
		reported_paths: reportedPaths,
		usage: input.worker.usage,
		budget: input.worker.budget,
		report_summary: redact(safeReportText.slice(0, MAX_AFTER_SUMMARY_CHARS)),
		review_status: "PENDING_REVIEW",
	};
	const workerSummary: LedgerWorkerSummaryRecord = {
		...common,
		provider: input.worker.provider,
		model: input.worker.model,
		turns: input.worker.turns,
		stop_reason: input.worker.stopReason?.slice(0, MAX_STOP_REASON_CHARS) ?? null,
		error_message: input.worker.errorMessage ? redact(input.worker.errorMessage.slice(0, MAX_ERROR_MESSAGE_CHARS)) : null,
		usage: input.worker.usage,
		cache_hit_ratio: input.worker.cacheHitRatio,
		budget: input.worker.budget,
		spend,
		report_summary: redact(safeReportText.slice(0, MAX_REPORT_SUMMARY_CHARS)),
		changed_paths: [...input.after.changedSinceBefore],
		completed: parsed.completed,
		verification_commands: parsed.verificationCommands,
		verification_observations: parsed.verificationObservations,
		remaining_risks: parsed.remainingRisks,
		report_path: reportPath,
		parse_warning: parseWarning,
		parse_reliable: parsed.reliable,
		truncated_items: parsed.truncatedItems,
	};
	const usageRecord: DelegationUsageRecord = {
		...common,
		provider: input.worker.provider,
		model: input.worker.model,
		turns: input.worker.turns,
		stop_reason: workerSummary.stop_reason,
		error_message: workerSummary.error_message,
		usage: input.worker.usage,
		cache_hit_ratio: input.worker.cacheHitRatio,
		budget: input.worker.budget,
		spend,
	};
	const review: PendingReviewPlaceholder = {
		schema_version: DELEGATION_SCHEMA_VERSION,
		delegation_id: delegationId,
		recorded_at: input.now,
		review_status: "PENDING_REVIEW",
		message: "review pending — replaced by the review service (core/diff-review.ts)",
	};
	let reportBody = safeReportText;
	if (Buffer.byteLength(reportBody, "utf8") > MAX_WORKER_REPORT_BYTES) {
		const bodyBudget = MAX_WORKER_REPORT_BYTES - Buffer.byteLength(WORKER_REPORT_TRUNCATION_MARKER, "utf8");
		reportBody = `${truncateUtf8(reportBody, bodyBudget)}${WORKER_REPORT_TRUNCATION_MARKER}`;
	}
	try {
		await writeTextAtomic(dir, WORKER_REPORT_FILE_NAME, reportBody);
		await writeJsonAtomic(dir, WORKER_USAGE_FILE_NAME, usageRecord);
		await writeJsonAtomic(dir, "after.json", afterRecord);
		await writeJsonAtomic(dir, WORKER_SUMMARY_FILE_NAME, workerSummary);
		await writeJsonAtomic(dir, "review.json", review);
		const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as DelegationManifest;
		manifest.finished_at = input.now;
		manifest.status = "finished";
		manifest.diff_hash_after = input.after.diffHash;
		manifest.changed_path_count_after = input.after.changedPaths.length;
		manifest.changed_since_before_count = input.after.changedSinceBefore.length;
		await writeJsonAtomic(dir, "manifest.json", manifest);
		return { ok: true, dir, workerSummary };
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}
}
