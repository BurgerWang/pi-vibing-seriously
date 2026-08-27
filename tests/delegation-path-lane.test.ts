import assert from "node:assert/strict";
import test from "node:test";

import {
	decideDelegationPathLaneV1,
	type DelegationPathLaneBlockerV1,
} from "../extensions/workbench-runtime/core/delegation-path-lane.ts";

const A = "20260826-100000-aaaa";
const B = "20260826-110000-bbbb";
const C = "20260826-120000-cccc";

function known(
	delegationId: string,
	changedPaths: readonly string[] = [],
	carriedPaths: readonly string[] = [],
	renameSources: Readonly<Record<string, string>> = {},
): DelegationPathLaneBlockerV1 {
	return {
		kind: "known",
		delegation_id: delegationId,
		changed_paths: changedPaths,
		carried_paths: carriedPaths,
		rename_sources: renameSources,
	};
}

function decide(allowedPaths: readonly string[], blockers: readonly unknown[]) {
	return decideDelegationPathLaneV1({
		schema_version: 1,
		kind: "delegation-path-lane-request-v1",
		allowed_paths: allowedPaths,
		blockers,
	});
}

test("normalizes exact and subtree rules into a deterministic minimal byte-sorted lane", () => {
	const decision = decide([
		"z/",
		"src/a.ts",
		"src/**",
		"docs/readme.md",
		"src/",
	], []);
	assert.equal(decision.decision, "ALLOW");
	assert.deepEqual(decision.block_reasons, []);
	assert.deepEqual(decision.normalized_allowed_paths, ["docs/readme.md", "src/**", "z/**"]);
	assert.deepEqual(decision.conflicts, []);
	assert.deepEqual(decision.authority_failures, []);
	assert.deepEqual(decision.maintenance_warnings, []);
	assert.deepEqual(Object.keys(decision).sort(), [
		"authority_failures",
		"block_reasons",
		"conflicts",
		"decision",
		"kind",
		"maintenance_warnings",
		"normalized_allowed_paths",
		"schema_version",
	]);
});

test("same immutable changed path blocks the requested lane with a closed conflict record", () => {
	const decision = decide(["src/a.ts"], [known(A, ["src/a.ts"])]);
	assert.equal(decision.decision, "BLOCK");
	assert.deepEqual(decision.block_reasons, ["PATH_OVERLAP"]);
	assert.deepEqual(decision.conflicts, [{
		code: "HISTORICAL_PATH_OVERLAP",
		delegation_id: A,
		requested_rule: "src/a.ts",
		historical_path: "src/a.ts",
		relation: "same_path",
		historical_sources: ["changed_path"],
	}]);
	assert.deepEqual(Object.keys(decision.conflicts[0]!).sort(), [
		"code",
		"delegation_id",
		"historical_path",
		"historical_sources",
		"relation",
		"requested_rule",
	]);
	assert.deepEqual(decision.maintenance_warnings, []);
});

test("subtree ancestor relations block without turning an exact parent into a subtree", () => {
	const requestedAncestor = decide(["src/parser/**"], [known(A, ["src/parser/index.ts"])]);
	assert.equal(requestedAncestor.decision, "BLOCK");
	assert.equal(requestedAncestor.conflicts[0]?.relation, "requested_ancestor");

	const exactParent = decide(["src/parser"], [known(A, ["src/parser/index.ts"])]);
	assert.equal(exactParent.decision, "ALLOW");
	assert.deepEqual(exactParent.conflicts, []);

	const subtreeParent = decide(["src/parser/**"], [known(A, ["src/parser/index.ts"])]);
	assert.equal(subtreeParent.decision, "BLOCK");
	assert.equal(subtreeParent.conflicts[0]?.relation, "requested_ancestor");

	const historicalAncestor = decide(["src/parser/index/**"], [known(A, ["src/parser"])]);
	assert.equal(historicalAncestor.decision, "BLOCK");
	assert.equal(historicalAncestor.conflicts[0]?.relation, "historical_ancestor");

	const componentBoundary = decide(["src/parser/**"], [known(A, ["src/parser-old/index.ts"])]);
	assert.equal(componentBoundary.decision, "ALLOW");
	assert.deepEqual(componentBoundary.conflicts, []);
	assert.deepEqual(componentBoundary.maintenance_warnings, [{
		code: "NON_OVERLAPPING_HISTORICAL_BLOCKER",
		delegation_id: A,
		relevant_paths: ["src/parser-old/index.ts"],
	}]);
});

test("immutable carried paths and both sides of a sealed rename participate in overlap", () => {
	const carried = decide(["src/rejected.ts"], [known(A, ["src/new.ts"], ["src/rejected.ts"])]);
	assert.equal(carried.decision, "BLOCK");
	assert.deepEqual(carried.conflicts[0]?.historical_sources, ["carried_path"]);

	const source = decide(["old/name.ts"], [known(B, ["new/name.ts"], [], { "new/name.ts": "old/name.ts" })]);
	assert.equal(source.decision, "BLOCK");
	assert.equal(source.conflicts[0]?.historical_path, "old/name.ts");
	assert.deepEqual(source.conflicts[0]?.historical_sources, ["rename_source"]);

	const destination = decide(["new/name.ts"], [known(B, ["new/name.ts"], [], { "new/name.ts": "old/name.ts" })]);
	assert.equal(destination.decision, "BLOCK");
	assert.deepEqual(destination.conflicts[0]?.historical_sources, ["changed_path", "rename_destination"]);
});

test("a known non-overlapping old blocker is a maintenance warning and does not serialize the lane", () => {
	const decision = decide(["src/current/**"], [
		known(C, [], []),
		known(A, ["z/old.ts"], ["docs/rejected.md"]),
	]);
	assert.equal(decision.decision, "ALLOW");
	assert.deepEqual(decision.block_reasons, []);
	assert.deepEqual(decision.maintenance_warnings, [
		{
			code: "NON_OVERLAPPING_HISTORICAL_BLOCKER",
			delegation_id: A,
			relevant_paths: ["docs/rejected.md", "z/old.ts"],
		},
		{
			code: "NON_OVERLAPPING_HISTORICAL_BLOCKER",
			delegation_id: C,
			relevant_paths: [],
		},
	]);
});

test("unknown and explicitly invalid authority remain global fail-closed beside unrelated known history", () => {
	const decision = decide(["src/current.ts"], [
		{ kind: "unknown", delegation_id: B, reason: "STORAGE_FAILURE" },
		known(C, ["docs/old.md"]),
		{ kind: "invalid", delegation_id: A, reason: "HASH_MISMATCH" },
	]);
	assert.equal(decision.decision, "BLOCK");
	assert.deepEqual(decision.block_reasons, ["INVALID_AUTHORITY", "UNKNOWN_AUTHORITY"]);
	assert.deepEqual(decision.authority_failures, [
		{ delegation_id: A, authority_state: "INVALID", reason: "HASH_MISMATCH" },
		{ delegation_id: B, authority_state: "UNKNOWN", reason: "STORAGE_FAILURE" },
	]);
	assert.deepEqual(decision.maintenance_warnings, [{
		code: "NON_OVERLAPPING_HISTORICAL_BLOCKER",
		delegation_id: C,
		relevant_paths: ["docs/old.md"],
	}]);
});

test("damaged known authority is never normalized into trusted history", async (context) => {
	const cases: Array<[string, unknown]> = [
		["unsorted immutable paths", {
			kind: "known", delegation_id: A, changed_paths: ["z.ts", "a.ts"], carried_paths: [], rename_sources: {},
		}],
		["duplicate immutable paths", {
			kind: "known", delegation_id: A, changed_paths: ["a.ts", "a.ts"], carried_paths: [], rename_sources: {},
		}],
		["unsafe path", {
			kind: "known", delegation_id: A, changed_paths: ["../escape.ts"], carried_paths: [], rename_sources: {},
		}],
		["rename destination absent from changed authority", {
			kind: "known", delegation_id: A, changed_paths: ["new/other.ts"], carried_paths: [],
			rename_sources: { "new/name.ts": "old/name.ts" },
		}],
		["open schema", {
			kind: "known", delegation_id: A, changed_paths: ["a.ts"], carried_paths: [], rename_sources: {}, extra: true,
		}],
	];
	for (const [name, blocker] of cases) {
		await context.test(name, () => {
			const decision = decide(["unrelated.ts"], [blocker]);
			assert.equal(decision.decision, "BLOCK");
			assert.deepEqual(decision.block_reasons, ["INVALID_AUTHORITY"]);
			assert.deepEqual(decision.authority_failures, [{
				delegation_id: A,
				authority_state: "INVALID",
				reason: "INVALID_RECORD",
			}]);
			assert.deepEqual(decision.maintenance_warnings, []);
		});
	}
});

test("duplicate observations for one blocker are ambiguous and fail closed", () => {
	const decision = decide(["src/current.ts"], [
		known(A, ["docs/old.ts"]),
		{ kind: "unknown", delegation_id: A, reason: "NOT_FOUND" },
	]);
	assert.equal(decision.decision, "BLOCK");
	assert.deepEqual(decision.block_reasons, ["INVALID_AUTHORITY"]);
	assert.deepEqual(decision.authority_failures, [{
		delegation_id: A,
		authority_state: "INVALID",
		reason: "DUPLICATE_AUTHORITY",
	}]);
	assert.deepEqual(decision.maintenance_warnings, []);
});

test("semantically identical request permutations produce byte-identical decisions", () => {
	const blockers = [
		known(C, ["z/old.ts"], ["é/rejected.ts"]),
		known(A, ["src/a.ts"]),
	];
	const first = decide(["é/current.ts", "src/**", "src/a.ts"], blockers);
	const second = decide(["src/a.ts", "src/**", "é/current.ts"], [...blockers].reverse());
	assert.deepEqual(first, second);
	assert.equal(JSON.stringify(first), JSON.stringify(second));
	assert.deepEqual(first.normalized_allowed_paths, ["src/**", "é/current.ts"]);
	assert.deepEqual(first.maintenance_warnings[0]?.relevant_paths, ["z/old.ts", "é/rejected.ts"]);
});

test("invalid or open request schemas fail closed without partial authority output", async (context) => {
	const requests: unknown[] = [
		{ schema_version: 1, kind: "delegation-path-lane-request-v1", allowed_paths: [], blockers: [] },
		{ schema_version: 1, kind: "delegation-path-lane-request-v1", allowed_paths: ["../escape/**"], blockers: [] },
		{ schema_version: 1, kind: "delegation-path-lane-request-v1", allowed_paths: ["src\\a.ts"], blockers: [] },
		{ schema_version: 1, kind: "delegation-path-lane-request-v1", allowed_paths: ["src/a.ts"], blockers: [], extra: true },
	];
	for (const [index, request] of requests.entries()) {
		await context.test(String(index), () => {
			assert.deepEqual(decideDelegationPathLaneV1(request), {
				schema_version: 1,
				kind: "delegation-path-lane-decision-v1",
				decision: "BLOCK",
				block_reasons: ["INVALID_REQUEST"],
				normalized_allowed_paths: [],
				conflicts: [],
				authority_failures: [],
				maintenance_warnings: [],
			});
		});
	}
});
