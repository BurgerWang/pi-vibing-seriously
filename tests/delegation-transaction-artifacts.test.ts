import assert from "node:assert/strict";
import test from "node:test";

import {
	bindDelegationBoundedTaskContractV2,
	buildDelegationCommittedArtifactsV2,
	computeDelegationDeltaHashV2,
	deriveDelegationPersistedReportV2,
	normalizeDelegationBoundedTaskContractV2,
	type DelegationBoundedTaskContractPayloadV2,
} from "../extensions/workbench-runtime/core/delegation-transaction-artifacts.ts";
import { computeDiffHash, type AfterFacts, type GitFacts, type LedgerWorkerFacts } from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import { DELEGATION_TRANSACTION_REPORT_MAX_BYTES } from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import {
	beginDelegationCommit,
	createPreparedDelegationTransaction,
	startDelegationTransaction,
	type DelegationTaskKind,
	type DelegationTerminalOutcome,
	type DelegationTransactionRecord,
} from "../extensions/workbench-runtime/core/delegation-transaction.ts";
import { WORKER_REPORT_TRUNCATION_MARKER } from "../extensions/workbench-runtime/worker/handoff.ts";
import { WORKER_MODEL_ID, WORKER_PROVIDER } from "../extensions/workbench-runtime/core/worker-policy.ts";
import { computeChangeSet } from "../extensions/workbench-runtime/core/change-set.ts";
import type { FinalizedDelegationChangeSetLifecycleV2 } from "../extensions/workbench-runtime/core/delegation-change-set-lifecycle.ts";
import { deriveFinalizedDelegationWorkspaceFactsV2 } from "../extensions/workbench-runtime/core/delegation-workspace-v2.ts";
import type { StreamingPathIdentity } from "../extensions/workbench-runtime/core/streaming-identity.ts";
import { computeWorkspaceGuardHash, type WorkspaceGuardRecord } from "../extensions/workbench-runtime/core/workspace-guard.ts";
import { computeWorkerWriteJournalHash, type WorkerWriteJournalRecord } from "../extensions/workbench-runtime/core/write-journal.ts";

const ID = "20260817-170000-abcd";
const HEAD = "1".repeat(40);
const IDENTITY = { provider: WORKER_PROVIDER, model: WORKER_MODEL_ID, worker_id: "artifact-worker" } as const;

function at(second: number): string {
	return `2026-08-17T17:00:${String(second).padStart(2, "0")}.000Z`;
}

function payload(kind: DelegationTaskKind = "implementation"): DelegationBoundedTaskContractPayloadV2 {
	return {
		task_kind: kind,
		task: kind === "implementation" ? "Implement the bounded artifact builder." : "Diagnose the delegation state.",
		allowed_paths: ["src/**"],
		acceptance_criteria: ["Records are authority-bound."],
		verification: ["npm test"],
		timeout_seconds: 600,
		budget_profile: "standard",
	};
}

const BEFORE: GitFacts = {
	gitHead: HEAD,
	gitDirty: false,
	changedPaths: [],
	pathStatuses: {},
	pathDigests: {},
};

function after(kind: DelegationTaskKind): AfterFacts {
	const changedPaths = kind === "implementation" ? ["src/changed.ts"] : [];
	const pathStatuses: Record<string, string> = kind === "implementation" ? { "src/changed.ts": "??" } : {};
	const pathDigests: Record<string, string> = kind === "implementation" ? { "src/changed.ts": "2".repeat(64) } : {};
	return {
		gitHead: HEAD,
		gitDirty: changedPaths.length > 0,
		changedPaths,
		pathStatuses,
		pathDigests,
		changedSinceBefore: [...changedPaths],
		diffHash: computeDiffHash(changedPaths, pathDigests, pathStatuses),
	};
}

function completeReport(paths: readonly string[] = ["src/changed.ts"]): string {
	return [
		"## Completed",
		"- Built immutable records.",
		"## Files Changed",
		...paths.map((path) => `- \`${path}\``),
		"## Verification",
		"- `npm test` — pass",
		"## Remaining Risks",
		"- None.",
	].join("\n");
}

function worker(report = completeReport()): LedgerWorkerFacts {
	return {
		provider: WORKER_PROVIDER,
		model: WORKER_MODEL_ID,
		status: "success",
		exitCode: 0,
		turns: 3,
		stopReason: "end_turn",
		errorMessage: null,
		usage: {
			input: 100,
			output: 40,
			cacheRead: 20,
			cacheWrite: 0,
			totalTokens: 160,
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0, total: 3.1 },
		},
		cacheHitRatio: 1 / 6,
		budget: {
			maxContextTokens: 160,
			maxContextRatio: 0.00016,
			softBudgetReached: false,
			hardBudgetExceeded: false,
			compactionCount: 0,
			compactionReasons: [],
		},
		spendProfile: "standard",
		spendState: { turns: 3, totalTokens: 160, outputTokens: 40 },
		spendBand: "ok",
		spendReasons: [],
		spendSoftReached: { turns: false, totalTokens: false, outputTokens: false },
		spendHardExceeded: { turns: false, totalTokens: false, outputTokens: false },
		reportSummary: report,
	};
}

function guard(facts: Readonly<GitFacts>, workerIdentity: StreamingPathIdentity): WorkspaceGuardRecord {
	const entries = facts.changedPaths.map((path, index) => ({
		path,
		status: (facts.pathStatuses[path] ?? " M").padStart(2, " "),
		identity: path === workerIdentity.path && workerIdentity.kind === "file"
			? { kind: "file" as const, byte_size: workerIdentity.byte_size, stat: { ...workerIdentity.stat } }
			: {
				kind: "file" as const,
				byte_size: 9,
				stat: { dev: "11", ino: String(12 + index), mtime_ns: "13", ctime_ns: "14" },
			},
	}));
	return {
		schema_version: 2,
		git_head: facts.gitHead,
		entries,
		irrelevant_artifact_paths: [],
		meter: { status_bytes: entries.length === 0 ? 0 : 18, relevant_paths: entries.length, irrelevant_paths: 0, stat_calls: entries.length * 2, content_bytes_read: 0 },
		workspace_guard_hash: computeWorkspaceGuardHash(HEAD, entries),
	};
}

function lifecycle(
	kind: DelegationTaskKind,
	contractHash: string,
	beforeFacts: Readonly<GitFacts>,
	afterFacts: Readonly<AfterFacts>,
): Readonly<FinalizedDelegationChangeSetLifecycleV2> {
	const path = "src/changed.ts";
	const missing: StreamingPathIdentity = { schema_version: 2, kind: "missing", path };
	const present: StreamingPathIdentity = {
		schema_version: 2, kind: "file", path, byte_size: 7, sha256: "2".repeat(64),
		stat: { dev: "1", ino: "2", mtime_ns: "3", ctime_ns: "4" },
	};
	const middle: StreamingPathIdentity = {
		...present, byte_size: 5, sha256: "3".repeat(64),
		stat: { ...present.stat, mtime_ns: "2", ctime_ns: "2" },
	};
	const limits = {
		max_unique_paths: 500, max_operations: 1000, max_identity_paths: 500,
		max_total_bytes: 256 * 1024 * 1024, max_file_bytes: 64 * 1024 * 1024, max_serialized_bytes: 4 * 1024 * 1024,
	};
	const open: WorkerWriteJournalRecord = {
		schema_version: 2, delegation_id: ID, contract_hash: contractHash, state: "OPEN", revision: 0,
		limits, meter: { paths_attempted: 0, paths_completed: 0, bytes_read: 0 }, operations: [], journal_hash: null,
	};
	const operations = kind === "implementation" ? [
		{
			sequence: 1, operation_id: "1".repeat(64), kind: "write" as const, path, status: "completed" as const,
			before: missing, after: middle, outcome: "succeeded" as const,
		},
		{
			sequence: 2, operation_id: "2".repeat(64), kind: "edit" as const, path, status: "completed" as const,
			before: middle, after: present, outcome: "succeeded" as const,
		},
	] : [];
	const sealedBase: WorkerWriteJournalRecord = {
		...open, state: "SEALED", revision: kind === "implementation" ? 5 : 1,
		meter: kind === "implementation"
			? { paths_attempted: 4, paths_completed: 4, bytes_read: 17 }
			: { paths_attempted: 0, paths_completed: 0, bytes_read: 0 },
		operations, journal_hash: "0".repeat(64),
	};
	const sealed = { ...sealedBase, journal_hash: computeWorkerWriteJournalHash(sealedBase) };
	const beforeGuard = guard(beforeFacts, present);
	const afterGuard = guard(afterFacts, present);
	const computed = computeChangeSet({
		delegation_id: ID, contract_hash: contractHash, journal_hash: sealed.journal_hash!, journal: sealed,
		before_guard: beforeGuard, after_guard: afterGuard, dependency_paths: beforeFacts.changedPaths,
		final_identities: kind === "implementation" ? [present] : [],
		finalization_meter: kind === "implementation"
			? { paths_attempted: 1, paths_completed: 1, bytes_read: 7 }
			: { paths_attempted: 0, paths_completed: 0, bytes_read: 0 },
	});
	if (!computed.ok) throw new Error(computed.error.code);
	return {
		prepared: {
			schema_version: 2, project_root: "/tmp/artifact-fixture", delegation_id: ID, contract_hash: contractHash,
			dependency_paths: [...beforeFacts.changedPaths], before_guard: beforeGuard, journal: open,
		},
		sealed_journal: sealed,
		after_guard: afterGuard,
		change_set: computed.value,
	};
}

function committing(
	kind: DelegationTaskKind,
	reportComplete: boolean,
	afterFacts = after(kind),
): {
	state: DelegationTransactionRecord;
	contract: ReturnType<typeof bindDelegationBoundedTaskContractV2> & { ok: true };
	changeSetLifecycle: Readonly<FinalizedDelegationChangeSetLifecycleV2>;
} {
	const contract = bindDelegationBoundedTaskContractV2(payload(kind));
	if (!contract.ok) throw new Error(contract.error.message);
	assert.equal(contract.ok, true);
	const prepared = createPreparedDelegationTransaction({
		delegation_id: ID,
		task_kind: kind,
		contract_hash: contract.value.contract_hash,
		allowed_paths: contract.value.allowed_paths,
		worker_identity: IDENTITY,
		generation: 1,
		now: at(0),
	});
	if (!prepared.ok) throw new Error(prepared.error);
	assert.equal(prepared.ok, true);
	const running = startDelegationTransaction(prepared.state, {
		delegation_id: ID,
		contract_hash: contract.value.contract_hash,
		worker_identity: IDENTITY,
		expected_generation: 1,
		expected_revision: 0,
		now: at(1),
	});
	if (!running.ok) throw new Error(running.error);
	assert.equal(running.ok, true);
	const beforeFacts: GitFacts = afterFacts.changedSinceBefore.length === afterFacts.changedPaths.length
		? BEFORE
		: {
			gitHead: afterFacts.gitHead,
			gitDirty: true,
			changedPaths: afterFacts.changedPaths.filter((path) => !afterFacts.changedSinceBefore.includes(path)),
			pathStatuses: Object.fromEntries(afterFacts.changedPaths.filter((path) => !afterFacts.changedSinceBefore.includes(path)).map((path) => [path, afterFacts.pathStatuses[path]!])),
			pathDigests: Object.fromEntries(afterFacts.changedPaths.filter((path) => !afterFacts.changedSinceBefore.includes(path)).map((path) => [path, afterFacts.pathDigests[path]!])),
		};
	const changeSetLifecycle = lifecycle(kind, contract.value.contract_hash, beforeFacts, afterFacts);
	const outcome: DelegationTerminalOutcome = {
		delegation_id: ID,
		task_kind: kind,
		worker_identity: { ...IDENTITY },
		provider_success: true,
		exit_code: 0,
		report_complete: reportComplete,
		terminal_facts_complete: true,
		scope_complete: true,
		change_set_status: changeSetLifecycle.change_set.status,
		changed_paths: changeSetLifecycle.change_set.worker_delta.map((entry) => entry.path),
		successful_write_count: changeSetLifecycle.sealed_journal.operations.filter((operation) => operation.status === "completed" && operation.outcome === "succeeded").length,
		denied_write_count: 0,
		delta_hash: kind === "implementation" ? changeSetLifecycle.change_set.worker_delta_hash : null,
	};
	const result = beginDelegationCommit(running.state, {
		delegation_id: ID,
		contract_hash: contract.value.contract_hash,
		worker_identity: IDENTITY,
		expected_generation: 1,
		expected_revision: 1,
		now: at(2),
		outcome,
	});
	if (!result.ok) throw new Error(result.error);
	assert.equal(result.ok, true);
	return { state: result.state, contract: contract as typeof contract & { ok: true }, changeSetLifecycle };
}

function artifactWorkspaceFacts(changeSetLifecycle: Readonly<FinalizedDelegationChangeSetLifecycleV2>) {
	const derived = deriveFinalizedDelegationWorkspaceFactsV2(changeSetLifecycle);
	if (!derived.ok) throw new Error(derived.error.code);
	return { before: derived.value.before, after: derived.value.after };
}

test("artifact v2: implementation builds deterministic exact records without mutating inputs", () => {
	const report = completeReport();
	const facts = after("implementation");
	const { state, contract, changeSetLifecycle } = committing("implementation", true, facts);
	const input = { transaction: state, contract: contract.value, ...artifactWorkspaceFacts(changeSetLifecycle), changeSetLifecycle, worker: worker(report), reportText: report };
	const snapshot = structuredClone(input);
	const first = buildDelegationCommittedArtifactsV2(input);
	const second = buildDelegationCommittedArtifactsV2(input);
	assert.equal(first.ok, true);
	assert.deepEqual(input.before.pathDigests, {}, "create-then-edit keeps the original missing before authority");
	assert.equal(changeSetLifecycle.change_set.worker_delta[0]?.operation_count, 2);
	assert.equal(changeSetLifecycle.change_set.worker_delta[0]?.before.kind, "missing");
	assert.deepEqual(first, second);
	assert.deepEqual(input, snapshot);
	if (!first.ok) return;
	assert.deepEqual(Object.keys(first.value.records).sort(), [
		"after.json", "before.json", "identity.json", "review.json", "scope.json", "usage.json", "worker-report.md", "worker-summary.json",
	].sort());
	assert.deepEqual(Object.keys(first.value.records["identity.json"] as object).sort(),
		["schema_version", "delegation_id", "task_kind", "contract_hash", "generation", "revision", "worker_identity"].sort());
	assert.deepEqual(Object.keys(first.value.records["scope.json"] as object).sort(),
		["schema_version", "delegation_id", "task_kind", "contract_hash", "allowed_paths", "changed_paths", "write_journal", "change_set"].sort());
	assert.equal(first.value.reportComplete, true);
	assert.equal(first.value.reportTruncated, false);
	assert.equal(first.value.reportPath, `.pi/workbench/delegations/${ID}/v2/generations/g00000001/worker-report.md`);
	assert.deepEqual(first.value.workerSummary.changed_paths, ["src/changed.ts"]);
	assert.deepEqual(first.value.reportedPaths, ["src/changed.ts"]);
	assert.equal(first.value.workerSummary.parse_warning, null);
	const usage = first.value.records["usage.json"] as Record<string, unknown>;
	assert.deepEqual(usage.spend, first.value.workerSummary.spend, "usage and summary share the same input-derived spend facts");
	assert.deepEqual(usage.usage, first.value.workerSummary.usage);
});

test("artifact v2: tagged W file digests require exact ChangeSet keys and bytes", () => {
	const report = completeReport();
	const facts = after("implementation");
	const { state, contract, changeSetLifecycle } = committing("implementation", true, facts);
	const workspace = artifactWorkspaceFacts(changeSetLifecycle);
	const variants: Array<Record<string, string>> = [
		{},
		{ "src/changed.ts": "f".repeat(64) },
		{ "src/changed.ts": "2".repeat(64), "src/extra.ts": "e".repeat(64) },
	];
	const invalidBeforeVariants: Array<Record<string, string>> = [
		{ "src/changed.ts": "f".repeat(64) },
		{ "src/extra.ts": "e".repeat(64) },
	];
	for (const pathDigests of variants) {
		const afterFacts = { ...workspace.after, pathDigests };
		const built = buildDelegationCommittedArtifactsV2({
			transaction: state, contract: contract.value, before: workspace.before, after: afterFacts,
			changeSetLifecycle, worker: worker(report), reportText: report,
		});
		assert.equal(built.ok, false);
	}
	for (const pathDigests of invalidBeforeVariants) {
		const beforeFacts = { ...workspace.before, pathDigests };
		const built = buildDelegationCommittedArtifactsV2({
			transaction: state, contract: contract.value, before: beforeFacts, after: workspace.after,
			changeSetLifecycle, worker: worker(report), reportText: report,
		});
		assert.equal(built.ok, false);
	}
});

test("artifact v2: diagnosis binds zero actual writes and a generation-local report", () => {
	const report = completeReport([]);
	const facts = after("diagnosis");
	const { state, contract, changeSetLifecycle } = committing("diagnosis", true, facts);
	const result = buildDelegationCommittedArtifactsV2({
		transaction: state, contract: contract.value, ...artifactWorkspaceFacts(changeSetLifecycle), changeSetLifecycle, worker: worker(report), reportText: report,
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.value.workerSummary.changed_paths, []);
	assert.deepEqual((result.value.records["scope.json"] as Record<string, unknown>).changed_paths, []);
	assert.equal(result.value.workerSummary.report_path.includes("/v2/generations/g00000001/"), true);
	assert.equal(result.value.workerSummary.report_path.endsWith("worker-report.md"), true);
});

test("artifact v2: canonical contract hashing preserves array order and omits absent repair_of", () => {
	const ordinary = bindDelegationBoundedTaskContractV2(payload());
	const same = bindDelegationBoundedTaskContractV2(structuredClone(payload()));
	const reorderedPayload = payload();
	reorderedPayload.verification = ["npm run typecheck", "npm test"];
	const reordered = bindDelegationBoundedTaskContractV2(reorderedPayload);
	const reversedPayload = structuredClone(reorderedPayload);
	reversedPayload.verification.reverse();
	const reversed = bindDelegationBoundedTaskContractV2(reversedPayload);
	assert.equal(ordinary.ok, true);
	assert.deepEqual(ordinary, same);
	assert.equal(Object.prototype.hasOwnProperty.call(ordinary.ok && ordinary.value, "repair_of"), false);
	assert.equal(reordered.ok && reversed.ok && reordered.value.contract_hash !== reversed.value.contract_hash, true);
	assert.equal(bindDelegationBoundedTaskContractV2({ ...payload(), repair_of: undefined }).ok, false);
	assert.equal(bindDelegationBoundedTaskContractV2({ ...payload(), task_kind: "mechanical" }).ok, false);
	assert.equal(bindDelegationBoundedTaskContractV2({ ...payload(), allowed_paths: ["z/**", "a/**"] }).ok, false);
	assert.equal(bindDelegationBoundedTaskContractV2({ ...payload(), allowed_paths: ["src/**", "src/**"] }).ok, false);
});

test("artifact v2: public contract normalizer trims and defaults before strict binding without mutating input", () => {
	const raw = {
		task_kind: "implementation",
		task: "  Implement a bounded change.  ",
		allowed_paths: [" tests/** ", " src/**  "],
		acceptance_criteria: ["  First criterion. ", "Second criterion.  "],
		verification: [" npm test ", "  npm run typecheck"],
		timeout_seconds: undefined,
		budget_profile: undefined,
		repair_of: undefined,
	};
	const snapshot = structuredClone(raw);
	const normalized = normalizeDelegationBoundedTaskContractV2(raw);
	assert.equal(normalized.ok, true);
	assert.deepEqual(raw, snapshot);
	if (!normalized.ok) return;
	assert.equal(normalized.value.task, "Implement a bounded change.");
	assert.deepEqual(normalized.value.allowed_paths, ["src/**", "tests/**"]);
	assert.deepEqual(normalized.value.acceptance_criteria, ["First criterion.", "Second criterion."]);
	assert.deepEqual(normalized.value.verification, ["npm test", "npm run typecheck"]);
	assert.equal(normalized.value.timeout_seconds, 1_800);
	assert.equal(normalized.value.budget_profile, "standard");
	assert.equal(Object.prototype.hasOwnProperty.call(normalized.value, "repair_of"), false);
	assert.deepEqual(bindDelegationBoundedTaskContractV2({
		task_kind: "implementation",
		task: "Implement a bounded change.",
		allowed_paths: ["src/**", "tests/**"],
		acceptance_criteria: ["First criterion.", "Second criterion."],
		verification: ["npm test", "npm run typecheck"],
		timeout_seconds: 1_800,
		budget_profile: "standard",
	}), normalized);
});

test("artifact v2: public verification defaults empty while acceptance criteria remain non-empty", () => {
	const raw = {
		task_kind: "diagnosis",
		task: "Diagnose the bounded issue.",
		allowed_paths: ["src/**"],
		acceptance_criteria: ["Evidence is bounded."],
	};
	const normalized = normalizeDelegationBoundedTaskContractV2(raw);
	const explicitlyEmpty = normalizeDelegationBoundedTaskContractV2({ ...raw, verification: [] });
	assert.equal(normalized.ok, true);
	assert.deepEqual(normalized, explicitlyEmpty);
	if (!normalized.ok) return;
	assert.deepEqual(normalized.value.verification, []);
	assert.equal(normalizeDelegationBoundedTaskContractV2({ ...raw, acceptance_criteria: [] }).ok, false);
	assert.equal(bindDelegationBoundedTaskContractV2({ ...payload(), acceptance_criteria: [] }).ok, false);
	const { verification: _verification, ...missingVerification } = payload();
	assert.equal(bindDelegationBoundedTaskContractV2(missingVerification).ok, false,
		"the strict binder does not supply the public default");
});

test("artifact v2: public contract normalizer rejects invalid and over-bound values without truncating or mutating", () => {
	const base = {
		task_kind: "diagnosis",
		task: "Diagnose the bounded issue.",
		allowed_paths: ["src/**"],
		acceptance_criteria: ["Evidence is bounded."],
		verification: ["npm test"],
	};
	const cases: Array<[string, unknown]> = [
		["unresolved kind", { ...base, task_kind: "mechanical" }],
		["duplicate normalized paths", { ...base, allowed_paths: ["src/**", " src/** "] }],
		["empty normalized path", { ...base, allowed_paths: ["   "] }],
		["invalid path", { ...base, allowed_paths: ["../escape/**"] }],
		["over-bound task", { ...base, task: "x".repeat(20_001) }],
		["empty normalized criterion", { ...base, acceptance_criteria: ["  "] }],
		["over-bound criterion", { ...base, acceptance_criteria: ["x".repeat(1_001)] }],
		["over-bound verification", { ...base, verification: ["x".repeat(501)] }],
		["invalid timeout", { ...base, timeout_seconds: 59 }],
		["invalid budget", { ...base, budget_profile: "huge" }],
		["invalid repair", { ...base, repair_of: "not-an-id" }],
		["unknown field", { ...base, extra: true }],
	];
	for (const [name, candidate] of cases) {
		const snapshot = structuredClone(candidate);
		assert.equal(normalizeDelegationBoundedTaskContractV2(candidate).ok, false, name);
		assert.deepEqual(candidate, snapshot, `${name}: input is unchanged`);
	}
});

test("artifact v2: report authority helper derives complete, missing, truncated, and redacted facts", () => {
	const complete = deriveDelegationPersistedReportV2(completeReport());
	assert.equal(complete.ok, true);
	if (!complete.ok) return;
	assert.equal(complete.value.report_complete, true);
	assert.equal(complete.value.report_truncated, false);
	assert.deepEqual(complete.value.reported_paths, ["src/changed.ts"]);

	const missing = deriveDelegationPersistedReportV2("## Completed\n- incomplete");
	assert.equal(missing.ok, true);
	if (!missing.ok) return;
	assert.equal(missing.value.report_complete, false);
	assert.match(missing.value.parsed_report.parseWarning ?? "", /missing required section/);

	const secret = "report-secret";
	const secrets = [secret];
	const secretsSnapshot = structuredClone(secrets);
	const redacted = deriveDelegationPersistedReportV2(`${secret}\n${completeReport()}`, secrets);
	assert.equal(redacted.ok, true);
	assert.deepEqual(secrets, secretsSnapshot);
	if (!redacted.ok) return;
	assert.equal(redacted.value.report_complete, true);
	assert.equal(redacted.value.persisted_text.includes(secret), false);
	assert.equal(redacted.value.persisted_text.includes("[REDACTED]"), true);

	const oversized = deriveDelegationPersistedReportV2(`${"界".repeat(DELEGATION_TRANSACTION_REPORT_MAX_BYTES)}\n${completeReport()}`);
	assert.equal(oversized.ok, true);
	if (!oversized.ok) return;
	assert.equal(oversized.value.report_complete, false);
	assert.equal(oversized.value.report_truncated, true);
	assert.equal(oversized.value.persisted_text.endsWith(WORKER_REPORT_TRUNCATION_MARKER), true);

	complete.value.parsed_report.completed.push("caller mutation");
	complete.value.reported_paths.push("caller/path.ts");
	const repeated = deriveDelegationPersistedReportV2(completeReport());
	assert.equal(repeated.ok, true);
	if (!repeated.ok) return;
	assert.equal(repeated.value.parsed_report.completed.includes("caller mutation"), false);
	assert.equal(repeated.value.reported_paths.includes("caller/path.ts"), false);
	assert.equal(deriveDelegationPersistedReportV2("bad\0report").ok, false);
});

test("artifact v2: worker delta hash excludes unchanged pre-existing workspace dirt", () => {
	const clean = after("implementation");
	const dirty: AfterFacts = {
		gitHead: HEAD,
		gitDirty: true,
		changedPaths: ["preexisting.ts", "src/changed.ts"],
		pathStatuses: { "preexisting.ts": " M", "src/changed.ts": "??" },
		pathDigests: { "preexisting.ts": "3".repeat(64), "src/changed.ts": "2".repeat(64) },
		changedSinceBefore: ["src/changed.ts"],
		diffHash: "",
	};
	dirty.diffHash = computeDiffHash(dirty.changedPaths, dirty.pathDigests, dirty.pathStatuses);
	assert.notEqual(dirty.diffHash, clean.diffHash, "the whole-workspace after hash includes pre-existing dirt");
	assert.equal(computeDelegationDeltaHashV2(dirty), computeDelegationDeltaHashV2(clean));
	const removed = { changedSinceBefore: ["src/deleted.ts"], pathStatuses: { "src/deleted.ts": "D" }, pathDigests: {} };
	assert.equal(computeDelegationDeltaHashV2(removed), computeDelegationDeltaHashV2(structuredClone(removed)),
		"a missing digest has a fixed deterministic marker");
	assert.notEqual(computeDelegationDeltaHashV2(removed), computeDelegationDeltaHashV2({
		...removed, pathDigests: { "src/deleted.ts": "4".repeat(64) },
	}), "the fixed missing marker cannot collide with a present digest");

	const dirtyBefore: GitFacts = {
		gitHead: HEAD,
		gitDirty: true,
		changedPaths: ["preexisting.ts"],
		pathStatuses: { "preexisting.ts": " M" },
		pathDigests: { "preexisting.ts": "3".repeat(64) },
	};
	const report = completeReport();
	const { state, contract, changeSetLifecycle } = committing("implementation", true, dirty);
	const result = buildDelegationCommittedArtifactsV2({
		transaction: state, contract: contract.value, ...artifactWorkspaceFacts(changeSetLifecycle), changeSetLifecycle, worker: worker(report), reportText: report,
	});
	assert.equal(result.ok, true, "a worker-only delta remains valid in an already dirty workspace");
});

test("artifact v2: redaction precedes the report cap so a surviving tail remains complete", () => {
	const secret = `secret-${"s".repeat(DELEGATION_TRANSACTION_REPORT_MAX_BYTES + 1_000)}`;
	const tail = completeReport();
	const raw = `${secret}\n${tail}`;
	const facts = after("implementation");
	const { state, contract, changeSetLifecycle } = committing("implementation", true, facts);
	const result = buildDelegationCommittedArtifactsV2({
		transaction: state, contract: contract.value, ...artifactWorkspaceFacts(changeSetLifecycle), changeSetLifecycle, worker: worker(tail), reportText: raw, secrets: [secret],
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	const persisted = result.value.records["worker-report.md"];
	assert.equal(persisted.includes(secret), false);
	assert.equal(persisted.includes("[REDACTED]"), true);
	assert.equal(persisted.endsWith("- None."), true, "tail after the removed secret is retained");
	assert.equal(persisted.includes(WORKER_REPORT_TRUNCATION_MARKER), false);
	assert.equal(result.value.reportComplete, true);
});

test("artifact v2: UTF-8-safe truncation is explicit and cannot be a complete report", () => {
	const raw = `${"界".repeat(DELEGATION_TRANSACTION_REPORT_MAX_BYTES)}\n${completeReport()}`;
	const facts = after("implementation");
	const { state, contract, changeSetLifecycle } = committing("implementation", false, facts);
	const result = buildDelegationCommittedArtifactsV2({
		transaction: state, contract: contract.value, ...artifactWorkspaceFacts(changeSetLifecycle), changeSetLifecycle, worker: worker(raw), reportText: raw,
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	const persisted = result.value.records["worker-report.md"];
	assert.ok(Buffer.byteLength(persisted, "utf8") <= DELEGATION_TRANSACTION_REPORT_MAX_BYTES);
	assert.ok(Buffer.byteLength(persisted, "utf8") >= DELEGATION_TRANSACTION_REPORT_MAX_BYTES - 3);
	assert.equal(persisted.endsWith(WORKER_REPORT_TRUNCATION_MARKER), true);
	assert.equal(persisted.includes("�"), false);
	assert.equal(result.value.reportTruncated, true);
	assert.equal(result.value.reportComplete, false);
	assert.match(result.value.workerSummary.parse_warning ?? "", /truncated/);
});

test("artifact v2: missing section is parser-incomplete and actual-vs-reported divergence is warned", () => {
	const report = "## Completed\n- done\n## Files Changed\n- `src/not-actual.ts`\n## Verification\n- pass";
	const facts = after("implementation");
	const { state, contract, changeSetLifecycle } = committing("implementation", false, facts);
	const result = buildDelegationCommittedArtifactsV2({
		transaction: state, contract: contract.value, ...artifactWorkspaceFacts(changeSetLifecycle), changeSetLifecycle, worker: worker(report), reportText: report,
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.reportComplete, false);
	assert.match(result.value.workerSummary.parse_warning ?? "", /missing required section/);
	assert.match(result.value.workerSummary.parse_warning ?? "", /diverge/);
});

test("artifact v2: foreign state, contract, identity, changed paths, or report-completeness fail closed", () => {
	const report = completeReport();
	const facts = after("implementation");
	const { state, contract, changeSetLifecycle } = committing("implementation", true, facts);
	const base = { transaction: state, contract: contract.value, ...artifactWorkspaceFacts(changeSetLifecycle), changeSetLifecycle, worker: worker(report), reportText: report };
	const cases = [
		{ ...base, transaction: { ...state, status: "RUNNING", revision: 1, terminal_outcome: null } as DelegationTransactionRecord },
		{ ...base, contract: { ...contract.value, contract_hash: "f".repeat(64) } },
		{ ...base, after: { ...facts, changedPaths: [] } },
		{ ...base, after: { ...facts, gitDirty: false } },
		{ ...base, after: { ...facts, pathStatuses: { "src/changed.ts": " M" } } },
		{
			...base,
			changeSetLifecycle: {
				...changeSetLifecycle,
				sealed_journal: { ...changeSetLifecycle.sealed_journal, journal_hash: "f".repeat(64) },
			},
		},
		{
			...base,
			changeSetLifecycle: {
				...changeSetLifecycle,
				after_guard: { ...changeSetLifecycle.after_guard, workspace_guard_hash: "f".repeat(64) },
			},
		},
		{
			...base,
			changeSetLifecycle: {
				...changeSetLifecycle,
				change_set: { ...changeSetLifecycle.change_set, worker_delta_hash: "f".repeat(64) },
			},
		},
		{ ...base, worker: { ...worker(report), provider: "foreign" } },
		{ ...base, reportText: "## Completed\n- incomplete" },
	];
	for (const candidate of cases) {
		const snapshot = structuredClone(candidate);
		assert.equal(buildDelegationCommittedArtifactsV2(candidate).ok, false);
		assert.deepEqual(candidate, snapshot);
	}
});

test("artifact v2: worker identity, profile, counters, and derived spend facts are exact authority bindings", () => {
	const report = completeReport();
	const facts = after("implementation");
	const { state, contract, changeSetLifecycle } = committing("implementation", true, facts);
	const validWorker = worker(report);
	const cases: Array<[string, LedgerWorkerFacts]> = [
		["null provider", { ...validWorker, provider: null }],
		["null model", { ...validWorker, model: null }],
		["foreign provider", { ...validWorker, provider: "foreign-provider" }],
		["foreign model", { ...validWorker, model: "foreign-model" }],
		["profile mismatch", { ...validWorker, spendProfile: "low" }],
		["turn counter mismatch", { ...validWorker, spendState: { ...validWorker.spendState!, turns: 4 } }],
		["spend total below positive raw aggregate", { ...validWorker, spendState: { ...validWorker.spendState!, totalTokens: 159 } }],
		["spend total above aggregate fallback ceiling", { ...validWorker, spendState: { ...validWorker.spendState!, totalTokens: 321 } }],
		["output counter mismatch", { ...validWorker, spendState: { ...validWorker.spendState!, outputTokens: 41 } }],
		["band mismatch", { ...validWorker, spendBand: "soft" }],
		["reason mismatch", { ...validWorker, spendReasons: ["turns"] }],
		["soft flag mismatch", { ...validWorker, spendSoftReached: { ...validWorker.spendSoftReached!, turns: true } }],
		["hard flag mismatch", { ...validWorker, spendHardExceeded: { ...validWorker.spendHardExceeded!, outputTokens: true } }],
	];
	for (const [name, workerFacts] of cases) {
		const input = { transaction: state, contract: contract.value, ...artifactWorkspaceFacts(changeSetLifecycle), changeSetLifecycle, worker: workerFacts, reportText: report };
		const snapshot = structuredClone(input);
		assert.equal(buildDelegationCommittedArtifactsV2(input).ok, false, name);
		assert.deepEqual(input, snapshot, `${name}: input is unchanged`);
	}
});

test("artifact v2: fallback spend and raw aggregate usage remain distinct persisted facts", () => {
	const report = completeReport();
	const facts = after("implementation");
	const { state, contract, changeSetLifecycle } = committing("implementation", true, facts);
	const fallbackWorker = worker(report);
	fallbackWorker.usage = { ...fallbackWorker.usage, totalTokens: 0 };
	const result = buildDelegationCommittedArtifactsV2({
		transaction: state,
		contract: contract.value,
		...artifactWorkspaceFacts(changeSetLifecycle),
		changeSetLifecycle,
		worker: fallbackWorker,
		reportText: report,
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.workerSummary.usage.totalTokens, 0);
	const summarySpend = result.value.workerSummary.spend;
	assert.ok(summarySpend);
	assert.equal(summarySpend.totalTokens, 160);
	const usageRecord = result.value.records["usage.json"] as {
		usage: { totalTokens: number };
		spend: { totalTokens: number };
	};
	assert.equal(usageRecord.usage.totalTokens, 0);
	assert.equal(usageRecord.spend.totalTokens, 160);
});
