import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import {
	DELEGATION_LIFECYCLE_EVENT_KIND_V1,
	delegationLifecycleSnapshotFromPathLaneAdmissionV1,
	resolveDelegationLifecycleV1,
} from "../extensions/workbench-runtime/core/delegation-lifecycle-resolver.ts";
import {
	admitProjectDelegationPathLaneV1,
	type DelegationPathLaneAdmissionReadersV1,
	type DelegationPathLaneAdmissionV1,
	type DelegationPathLaneImmutablePathsV1,
} from "../extensions/workbench-runtime/core/delegation-path-lane-admission.ts";
import type { DelegationSemanticRepairDecisionV1 } from "../extensions/workbench-runtime/core/delegation-transaction-storage.ts";
import {
	parseDelegationTransaction,
	type DelegationTransactionRecord,
} from "../extensions/workbench-runtime/core/delegation-transaction.ts";

const FIXTURE_IDS = ["mace", "onchain", "scalper"] as const;
const FIXTURE_ROOT = new URL("fixtures/delegation-history-replay/", import.meta.url);
const FIXED_CONTENT = Buffer.from("pi-workbench-replay-fixture-v1\n", "utf8");

interface ReplayTransaction {
	state: DelegationTransactionRecord;
	semantic_repair_decision?: DelegationSemanticRepairDecisionV1;
	auxiliary: {
		inactive_closure: boolean;
		empty_repair_attempt_supersession: boolean;
		repair_abandonment: boolean;
		semantic_review_closure: boolean;
		semantic_repair_sidecar: boolean;
		terminal_negative_repair_sidecar: boolean;
	};
	immutable_paths?: DelegationPathLaneImmutablePathsV1;
}

interface ReplayFixture {
	schema_version: 1;
	kind: "delegation-history-replay-fixture-v1";
	fixture_id: string;
	source_project: string;
	collected_at: string;
	sanitization_version: 1;
	synthetic_root: string;
	source_fingerprint: string;
	coverage: string[];
	inventory: {
		transaction_count: number;
		root_count: number;
		lineage_count: number;
		max_lineage_depth: number;
		sanitized_path_count: number;
		semantic_repair_sidecars: number;
		terminal_negative_repair_sidecars: number;
		inactive_closures: number;
		empty_attempt_supersessions: number;
		semantic_review_closures: number;
		session_file_count: number;
		fault_counts: Record<string, number>;
		runtime_source_hashes: string[];
	};
	fixed_content: {
		encoding: "base64";
		bytes: string;
		sha256: string;
	};
	expected: {
		probe_path: string;
		closure: {
			ok: true;
			unresolvedTipId: string | null;
			rootCount: number;
			lineageCount: number;
		};
		ordinary_blocker_ids: string[];
		repair_tip_ids: string[];
		blockers: DelegationPathLaneAdmissionV1["blockers"];
		decision: DelegationPathLaneAdmissionV1["decision"];
	};
	transactions: ReplayTransaction[];
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateFixtureShell(value: unknown, expectedId: string): asserts value is ReplayFixture {
	assert.ok(isRecord(value));
	assert.equal(value.schema_version, 1);
	assert.equal(value.kind, "delegation-history-replay-fixture-v1");
	assert.equal(value.fixture_id, expectedId);
	assert.equal(value.sanitization_version, 1);
	assert.equal(value.synthetic_root, `/fixture/${expectedId}`);
	assert.equal(typeof value.source_project, "string");
	assert.match(String(value.collected_at), /^\d{4}-\d{2}-\d{2}T/u);
	assert.match(String(value.source_fingerprint), /^[a-f0-9]{64}$/u);
	assert.ok(Array.isArray(value.coverage));
	assert.ok(isRecord(value.inventory));
	assert.ok(isRecord(value.fixed_content));
	assert.ok(isRecord(value.expected));
	assert.ok(Array.isArray(value.transactions));
}

async function readFixture(id: typeof FIXTURE_IDS[number]): Promise<{ fixture: ReplayFixture; raw: string }> {
	const raw = await readFile(new URL(`${id}/history.json`, FIXTURE_ROOT), "utf8");
	const parsed: unknown = JSON.parse(raw);
	validateFixtureShell(parsed, id);
	return { fixture: parsed, raw };
}

function fixtureReaders(fixture: ReplayFixture): DelegationPathLaneAdmissionReadersV1 {
	const transactions = new Map(fixture.transactions.map((entry) => [entry.state.delegation_id, entry]));
	const missing = () => ({ ok: false as const, error: { code: "not_found" as const } });
	const entry = (delegationId: string): ReplayTransaction | undefined => transactions.get(delegationId);
	return {
		listDelegationIds: async () => ({ ok: true, value: [...transactions.keys()].sort(byteCompare) }),
		readTransaction: async (_root, delegationId) => {
			const found = entry(delegationId);
			return found === undefined ? missing() : { ok: true, value: found.state };
		},
		readSemanticRepairDecision: async (_root, delegationId) => {
			const found = entry(delegationId);
			return found === undefined ? missing() : { ok: true, value: found.semantic_repair_decision };
		},
		readTerminalNegativeRepairDecision: async (_root, transaction) => {
			const found = entry(transaction.delegation_id);
			return found === undefined ? missing() : { ok: true, value: found.semantic_repair_decision };
		},
		readInactiveClosure: async (_root, transaction) => {
			const found = entry(transaction.delegation_id);
			return found === undefined ? missing() : { ok: true, value: found.auxiliary.inactive_closure };
		},
		readEmptyRepairAttemptSupersession: async (_root, transaction) => {
			const found = entry(transaction.delegation_id);
			return found === undefined
				? missing()
				: { ok: true, value: found.auxiliary.empty_repair_attempt_supersession };
		},
		readRepairAbandonment: async (_root, tip) => {
			const found = entry(tip.delegation_id);
			return found === undefined ? missing() : { ok: true, value: found.auxiliary.repair_abandonment };
		},
		readSemanticReviewClosure: async (_root, transaction) => {
			const found = entry(transaction.delegation_id);
			return found === undefined ? missing() : { ok: true, value: found.auxiliary.semantic_review_closure };
		},
		readImmutablePaths: async (_root, transaction) => {
			const found = entry(transaction.delegation_id);
			return found?.immutable_paths === undefined ? missing() : { ok: true, value: found.immutable_paths };
		},
	};
}

test("real-history fixtures replay independently through the production path-lane classifier", async (t) => {
	for (const id of FIXTURE_IDS) {
		await t.test(id, async (t) => {
			const { fixture, raw } = await readFixture(id);
			const tempRoot = await mkdtemp(join(tmpdir(), `workbench-history-${id}-`));
			t.after(async () => rm(tempRoot, { recursive: true, force: true }));
			const copiedFixture = join(tempRoot, "history.json");
			await writeFile(copiedFixture, raw, "utf8");
			const reparsed = JSON.parse(await readFile(copiedFixture, "utf8")) as ReplayFixture;
			const readers = fixtureReaders(reparsed);
			const input = { project_root: tempRoot, allowed_paths: [reparsed.expected.probe_path] };
			const first = await admitProjectDelegationPathLaneV1(input, readers);
			const replay = await admitProjectDelegationPathLaneV1(input, readers);
			assert.deepEqual(replay, first, "replaying identical fixture bytes is deterministic");
			assert.deepEqual(first.ordinary_blocker_ids, reparsed.expected.ordinary_blocker_ids);
			assert.deepEqual(first.repair_tip_ids, reparsed.expected.repair_tip_ids);
			assert.deepEqual(first.blockers, reparsed.expected.blockers);
			assert.deepEqual(first.decision, reparsed.expected.decision);
			const lifecycle = resolveDelegationLifecycleV1(
				delegationLifecycleSnapshotFromPathLaneAdmissionV1(first),
				{
					schema_version: 1,
					kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
					event: "OBSERVE",
					expected_snapshot_hash: null,
				},
			);
			assert.equal(lifecycle.state, "TERMINAL_NON_BLOCKING");
			assert.equal(lifecycle.primary_action.action, "CONTINUE_DEVELOPMENT");
			assert.equal(lifecycle.primary_action.reason, "NO_CURRENT_BLOCKER");
		});
	}
});

test("WP3 AC08: three real histories converge or expose one exact external blocker", async () => {
	const externalBlockers: Array<{ project: string; delegation_id: string }> = [];
	for (const id of FIXTURE_IDS) {
		const { fixture } = await readFixture(id);
		const readers = fixtureReaders(fixture);
		const unresolvedTip = fixture.expected.closure.unresolvedTipId;
		if (unresolvedTip === null) {
			assert.deepEqual(fixture.expected.ordinary_blocker_ids, [], fixture.source_project);
			assert.deepEqual(fixture.expected.repair_tip_ids, [], fixture.source_project);
			continue;
		}
		assert.deepEqual(fixture.expected.repair_tip_ids, [unresolvedTip], fixture.source_project);
		assert.equal(fixture.expected.blockers.length, 1, fixture.source_project);
		const blocker = fixture.expected.blockers[0];
		assert.equal(blocker?.kind, "known", fixture.source_project);
		if (blocker?.kind !== "known") continue;
		assert.equal(blocker.delegation_id, unresolvedTip, fixture.source_project);
		const overlapPath = blocker.changed_paths[0] ?? blocker.carried_paths[0];
		assert.notEqual(overlapPath, undefined, fixture.source_project);
		if (overlapPath === undefined) continue;
		const admission = await admitProjectDelegationPathLaneV1({
			project_root: `/fixture/${id}`,
			allowed_paths: [overlapPath],
		}, readers);
		assert.equal(admission.decision.decision, "BLOCK", fixture.source_project);
		assert.equal(admission.decision.conflicts.length, 1, fixture.source_project);
		assert.equal(admission.decision.conflicts[0]?.delegation_id, unresolvedTip, fixture.source_project);
		const lifecycle = resolveDelegationLifecycleV1(
			delegationLifecycleSnapshotFromPathLaneAdmissionV1(admission),
			{
				schema_version: 1,
				kind: DELEGATION_LIFECYCLE_EVENT_KIND_V1,
				event: "OBSERVE",
				expected_snapshot_hash: null,
			},
		);
		assert.equal(lifecycle.primary_action.action, "BLOCK_OVERLAPPING_PATHS", fixture.source_project);
		externalBlockers.push({ project: fixture.source_project, delegation_id: unresolvedTip });
	}
	assert.deepEqual(externalBlockers, [{
		project: "Scalper_V2",
		delegation_id: "20260828-145820-71ji",
	}]);
});

test("fixture lifecycle records and every derived hash remain internally valid after sanitization", async () => {
	for (const id of FIXTURE_IDS) {
		const { fixture } = await readFixture(id);
		assert.equal(fixture.transactions.length, fixture.inventory.transaction_count);
		assert.equal(fixture.expected.closure.rootCount, fixture.inventory.root_count);
		assert.equal(fixture.expected.closure.lineageCount, fixture.inventory.lineage_count);
		const ids = fixture.transactions.map((entry) => entry.state.delegation_id);
		assert.deepEqual(ids, [...ids].sort(byteCompare));
		for (const entry of fixture.transactions) {
			const parsed = parseDelegationTransaction(entry.state);
			assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
			if (entry.semantic_repair_decision !== undefined) {
				const { decision_hash: decisionHash, ...projection } = entry.semantic_repair_decision;
				assert.equal(decisionHash, canonicalHash(projection));
				assert.equal(
					entry.semantic_repair_decision.repair_reason_hash,
					createHash("sha256").update(entry.semantic_repair_decision.repair_reason, "utf8").digest("hex"),
				);
				assert.equal(entry.semantic_repair_decision.contract_hash, entry.state.contract_hash);
			}
		}
		const fixed = Buffer.from(fixture.fixed_content.bytes, "base64");
		assert.deepEqual(fixed, FIXED_CONTENT);
		assert.equal(createHash("sha256").update(fixed).digest("hex"), fixture.fixed_content.sha256);
	}
});

test("fixtures retain the real topology and recurring fault coverage without sensitive content", async () => {
	const coverage = new Set<string>();
	let hasDeepRealShape = false;
	for (const id of FIXTURE_IDS) {
		const { fixture, raw } = await readFixture(id);
		fixture.coverage.forEach((item) => coverage.add(item));
		hasDeepRealShape ||= fixture.inventory.root_count > 1 && fixture.inventory.max_lineage_depth > 5;
		assert.doesNotMatch(raw, /\/(?:mnt|home)\//u);
		assert.doesNotMatch(raw, /"(?:task|acceptance_criteria|prompt|worker_report|report_text|transcript|secret|account)"\s*:/iu);
		assert.doesNotMatch(raw, /(?:configs|crates|python|schemas|reports|tools)\//u);
		assert.match(fixture.synthetic_root, /^\/fixture\/[a-z0-9-]+$/u);
		for (const entry of fixture.transactions) {
			for (const path of [
				...entry.state.allowed_paths,
				...(entry.state.terminal_outcome?.changed_paths ?? []),
				...(entry.state.repair_lineage?.carried_paths ?? []),
			]) {
				assert.match(path, /^s\d{4}(?:\/s\d{4})*(?:\/\*\*)?\/?$/u);
			}
			assert.match(entry.state.worker_identity.worker_id, /^fixture-/u);
		}
	}
	assert.equal(hasDeepRealShape, true, "at least one replay keeps multiple roots and lineage depth > 5");
	for (const required of [
		"current-binding-changed",
		"readable-invalid-derived-review",
		"terminal-negative-sidecar",
		"zero-delta-supersession",
		"accepted-successor-closure",
		"lineage-presentation-gap",
		"command-outcome-vs-mutation-attribution",
		"runtime-identity-stale",
	]) {
		assert.equal(coverage.has(required), true, `missing replay coverage: ${required}`);
	}
});
