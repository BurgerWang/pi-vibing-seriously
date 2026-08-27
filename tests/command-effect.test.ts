import assert from "node:assert/strict";
import test from "node:test";

import {
	beginRecipeCommandEffectCapture,
	buildRecipeCommandEffectRecord,
	commandEffectBlockingReason,
	commandEffectTerminalReasons,
	completeRecipeCommandEffectCapture,
	recipeCommandEffectPreCaptureError,
	validateCommandEffectRecord,
	type CommandEffectExactOutputEvidence,
} from "../extensions/workbench-runtime/core/command-effect.ts";
import {
	STREAMING_IDENTITY_SCHEMA_VERSION,
	type StreamingPathIdentity,
} from "../extensions/workbench-runtime/core/streaming-identity.ts";
import {
	computeWorkspaceGuardHash,
	type WorkspaceGuardEntry,
	type WorkspaceGuardRecord,
} from "../extensions/workbench-runtime/core/workspace-guard.ts";

const RUN_ID = "20260827-120000-a1B2";
const HEAD = "a".repeat(40);

function entry(path: string, seed: number): WorkspaceGuardEntry {
	return {
		path,
		status: " M",
		identity: {
			kind: "file",
			byte_size: seed,
			stat: {
				dev: "1",
				ino: String(seed + 1),
				mtime_ns: String(seed + 2),
				ctime_ns: String(seed + 3),
			},
		},
	};
}

function guard(entries: readonly WorkspaceGuardEntry[]): WorkspaceGuardRecord {
	const sorted = [...entries].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
	return {
		schema_version: 2,
		git_head: HEAD,
		entries: sorted,
		irrelevant_artifact_paths: [],
		meter: {
			status_bytes: 0,
			relevant_paths: sorted.length,
			irrelevant_paths: 0,
			stat_calls: sorted.length * 2,
			content_bytes_read: 0,
		},
		workspace_guard_hash: computeWorkspaceGuardHash(HEAD, sorted),
	};
}

function missing(path: string): StreamingPathIdentity {
	return { schema_version: STREAMING_IDENTITY_SCHEMA_VERSION, kind: "missing", path };
}

function fileIdentity(path: string, seed: number, sha256 = seed.toString(16).padStart(64, "0")): StreamingPathIdentity {
	return {
		schema_version: STREAMING_IDENTITY_SCHEMA_VERSION,
		kind: "file",
		path,
		byte_size: seed,
		sha256,
		stat: { dev: "1", ino: "2", mtime_ns: "3", ctime_ns: "4" },
	};
}

function exactEvidence(identities: readonly StreamingPathIdentity[]): CommandEffectExactOutputEvidence {
	return {
		identities,
		error: null,
		meter: {
			paths_attempted: identities.length,
			paths_completed: identities.length,
			bytes_read: identities.reduce((sum, identity) => sum + (identity.kind === "file" ? identity.byte_size : 0), 0),
		},
	};
}

function unavailableExactEvidence(
	code: "path_symlink" | "path_not_regular",
	path: string,
): CommandEffectExactOutputEvidence {
	return {
		identities: [],
		error: { code, message: `closed ${code}`, path },
		meter: { paths_attempted: 1, paths_completed: 0, bytes_read: 0 },
	};
}

const NO_EXACT_OUTPUTS = exactEvidence([]);

const BASE = {
	run_id: RUN_ID,
	recipe: "verify",
	actor: "worker" as const,
	worker_delegation_id: "20260827-115900-z9Y8",
	worker_contract_hash: "b".repeat(64),
};

test("mutation:none workspace changes are declaration violations, never generic drift", () => {
	const record = buildRecipeCommandEffectRecord({
		...BASE,
		mutation_declaration: "none",
		declared_writes: [],
		before_guard: guard([]),
		after_guard: guard([entry("src/hidden.ts", 10)]),
		before_exact_output_evidence: NO_EXACT_OUTPUTS,
		after_exact_output_evidence: NO_EXACT_OUTPUTS,
	});
	assert.equal(record.status, "RECIPE_DECLARATION_VIOLATION");
	assert.equal(record.observed_changes[0]?.classification, "RECIPE_DECLARATION_VIOLATION");
	assert.equal(commandEffectBlockingReason(record), "RECIPE_DECLARATION_VIOLATION");
	assert.equal(record.semantic_acceptance, "NOT_GRANTED");
	assert.equal(validateCommandEffectRecord(record), true);
});

test("worker command-effect identity requires one canonical delegation id and contract hash", () => {
	for (const [delegationId, contractHash] of [
		[null, null],
		["", "b".repeat(64)],
		["20260827-115900-z9Y8", ""],
		["not-a-delegation", "b".repeat(64)],
		["20260827-115900-z9Y8", "B".repeat(64)],
	] as const) {
		assert.throws(() => buildRecipeCommandEffectRecord({
			...BASE,
			worker_delegation_id: delegationId,
			worker_contract_hash: contractHash,
			mutation_declaration: "none",
			declared_writes: [],
			before_guard: guard([]),
			after_guard: guard([]),
			before_exact_output_evidence: NO_EXACT_OUTPUTS,
			after_exact_output_evidence: NO_EXACT_OUTPUTS,
		}), /worker command-effect identity is invalid/u);
	}
});

test("only an exact declared output is command-attributed and it grants no semantic acceptance", () => {
	const before = entry("generated/result.json", 5);
	const after = entry("generated/result.json", 9);
	const record = buildRecipeCommandEffectRecord({
		...BASE,
		actor: "workbench",
		worker_delegation_id: null,
		worker_contract_hash: null,
		mutation_declaration: "artifacts",
		declared_writes: ["generated/result.json"],
		before_guard: guard([before]),
		after_guard: guard([after]),
		before_exact_output_evidence: exactEvidence([fileIdentity("generated/result.json", 5)]),
		after_exact_output_evidence: exactEvidence([fileIdentity("generated/result.json", 9)]),
	});
	assert.equal(record.status, "COMMAND_ATTRIBUTED");
	assert.deepEqual(record.exact_declared_output_paths, ["generated/result.json"]);
	assert.equal(record.observed_changes[0]?.classification, "COMMAND_ATTRIBUTED");
	assert.equal(commandEffectBlockingReason(record), undefined);
	assert.equal(record.semantic_acceptance, "NOT_GRANTED");
});

test("exact output content hashes detect a change even when both workspace guard and stat identity collide", () => {
	const path = "generated/collision.bin";
	const beforeIdentity = fileIdentity(path, 4, "1".repeat(64));
	const afterIdentity = fileIdentity(path, 4, "2".repeat(64));
	assert.deepEqual(beforeIdentity.kind === "file" ? beforeIdentity.stat : null, afterIdentity.kind === "file" ? afterIdentity.stat : null);
	const record = buildRecipeCommandEffectRecord({
		...BASE,
		actor: "workbench",
		worker_delegation_id: null,
		worker_contract_hash: null,
		mutation_declaration: "artifacts",
		declared_writes: [path],
		before_guard: guard([]),
		after_guard: guard([]),
		before_exact_output_evidence: exactEvidence([beforeIdentity]),
		after_exact_output_evidence: exactEvidence([afterIdentity]),
	});
	assert.equal(record.status, "COMMAND_ATTRIBUTED");
	assert.equal(record.observed_changes[0]?.path, path);
	assert.equal(record.observed_changes[0]?.before, null);
	assert.equal(record.observed_changes[0]?.after, null);
	assert.equal(record.observed_changes[0]?.before_exact_output?.kind, "file");
	assert.equal(record.observed_changes[0]?.after_exact_output?.kind, "file");
});

test("exact output symlinks and directories close as unavailable evidence instead of being followed or guessed", () => {
	const path = "generated/result.zip";
	const symlink = buildRecipeCommandEffectRecord({
		...BASE,
		actor: "workbench",
		worker_delegation_id: null,
		worker_contract_hash: null,
		mutation_declaration: "artifacts",
		declared_writes: [path],
		before_guard: guard([]),
		after_guard: guard([]),
		before_exact_output_evidence: unavailableExactEvidence("path_symlink", path),
		after_exact_output_evidence: exactEvidence([missing(path)]),
	});
	assert.equal(symlink.capture_error, "BEFORE_EXACT_OUTPUT_UNAVAILABLE");
	assert.equal(symlink.status, "EVIDENCE_UNAVAILABLE");

	const directory = buildRecipeCommandEffectRecord({
		...BASE,
		actor: "workbench",
		worker_delegation_id: null,
		worker_contract_hash: null,
		mutation_declaration: "artifacts",
		declared_writes: [path],
		before_guard: guard([]),
		after_guard: guard([]),
		before_exact_output_evidence: exactEvidence([missing(path)]),
		after_exact_output_evidence: unavailableExactEvidence("path_not_regular", path),
	});
	assert.equal(directory.capture_error, "AFTER_EXACT_OUTPUT_UNAVAILABLE");
	assert.equal(directory.status, "EVIDENCE_UNAVAILABLE");
});

test("broad declarations stay unknown and undeclared paths stay out of scope", () => {
	const broad = buildRecipeCommandEffectRecord({
		...BASE,
		actor: "workbench",
		worker_delegation_id: null,
		worker_contract_hash: null,
		mutation_declaration: "artifacts",
		declared_writes: ["generated/**"],
		before_guard: guard([]),
		after_guard: guard([entry("generated/result.json", 9)]),
		before_exact_output_evidence: NO_EXACT_OUTPUTS,
		after_exact_output_evidence: NO_EXACT_OUTPUTS,
	});
	assert.equal(broad.status, "UNKNOWN_ORIGIN");
	assert.equal(broad.observed_changes[0]?.classification, "UNKNOWN_ORIGIN");
	assert.equal(commandEffectBlockingReason(broad), "COMMAND_EFFECT_UNKNOWN_ORIGIN");
	const broadWithoutGitVisibleChange = buildRecipeCommandEffectRecord({
		...BASE,
		actor: "workbench",
		worker_delegation_id: null,
		worker_contract_hash: null,
		mutation_declaration: "artifacts",
		declared_writes: ["ignored/**"],
		before_guard: guard([]),
		after_guard: guard([]),
		before_exact_output_evidence: NO_EXACT_OUTPUTS,
		after_exact_output_evidence: NO_EXACT_OUTPUTS,
	});
	assert.equal(broadWithoutGitVisibleChange.status, "UNKNOWN_ORIGIN");
	assert.deepEqual(broadWithoutGitVisibleChange.observed_changes, []);

	const outside = buildRecipeCommandEffectRecord({
		...BASE,
		actor: "workbench",
		worker_delegation_id: null,
		worker_contract_hash: null,
		mutation_declaration: "source",
		declared_writes: ["generated/result.json"],
		before_guard: guard([]),
		after_guard: guard([entry("src/unexpected.ts", 12)]),
		before_exact_output_evidence: exactEvidence([missing("generated/result.json")]),
		after_exact_output_evidence: exactEvidence([missing("generated/result.json")]),
	});
	assert.equal(outside.status, "OUT_OF_SCOPE");
	assert.equal(outside.observed_changes[0]?.classification, "OUT_OF_SCOPE");
	assert.equal(commandEffectBlockingReason(outside), "COMMAND_EFFECT_OUT_OF_SCOPE");
});

test("guard fault injection closes an evidence-unavailable record and terminal projection", async () => {
	let calls = 0;
	const collect = async () => {
		calls += 1;
		if (calls === 2) throw new Error("fault after command");
		return { ok: true as const, guard: guard([]) };
	};
	const captureIdentities = async () => ({ ok: true as const, identities: [], meter: { paths_attempted: 0, paths_completed: 0, bytes_read: 0 } });
	const started = await beginRecipeCommandEffectCapture({
		project_root: "/repo",
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		declared_writes: [],
	}, { collect_guard: collect, capture_identities: captureIdentities });
	assert.equal(recipeCommandEffectPreCaptureError(started), undefined);
	const record = await completeRecipeCommandEffectCapture({
		...BASE,
		project_root: "/repo",
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		mutation_declaration: "none",
		declared_writes: [],
		started,
	}, { collect_guard: collect, capture_identities: captureIdentities });
	assert.equal(record.capture_error, "AFTER_GUARD_UNAVAILABLE");
	assert.equal(record.status, "EVIDENCE_UNAVAILABLE");
	assert.deepEqual(record.observed_changes, []);
	assert.equal(commandEffectBlockingReason(record), "COMMAND_EFFECT_EVIDENCE_UNAVAILABLE");
	assert.deepEqual(commandEffectTerminalReasons([record]), ["COMMAND_EFFECT_EVIDENCE_UNAVAILABLE"]);
	assert.equal(validateCommandEffectRecord(record), true);
});

test("before evidence unavailability is detectable before any subprocess is authorized", async () => {
	const started = await beginRecipeCommandEffectCapture({
		project_root: "/repo",
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		declared_writes: [],
	}, {
		collect_guard: async () => { throw new Error("injected before guard failure"); },
		capture_identities: async () => ({ ok: true, identities: [], meter: { paths_attempted: 0, paths_completed: 0, bytes_read: 0 } }),
	});
	assert.equal(recipeCommandEffectPreCaptureError(started), "BEFORE_GUARD_UNAVAILABLE");
});

test("closed validator rejects forged attribution even with a recomputed-looking shape", () => {
	const record = buildRecipeCommandEffectRecord({
		...BASE,
		mutation_declaration: "none",
		declared_writes: [],
		before_guard: guard([]),
		after_guard: guard([entry("src/hidden.ts", 10)]),
		before_exact_output_evidence: NO_EXACT_OUTPUTS,
		after_exact_output_evidence: NO_EXACT_OUTPUTS,
	});
	const forged = structuredClone(record) as any;
	forged.observed_changes[0].classification = "COMMAND_ATTRIBUTED";
	assert.equal(validateCommandEffectRecord(forged), false);
});
