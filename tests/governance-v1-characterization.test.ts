/**
 * S1.0 governance-v1 characterization.
 *
 * These tests freeze observable v1 readers/parsers and deliberately keep
 * current defects separate from target contracts. All authority fixtures are
 * physical files. Readers operate only on copied temp trees; the repository
 * fixture bytes are hashed before and after the suite.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { canonicalHash } from "../extensions/workbench-runtime/cache/canonical-hash.ts";
import {
	DELEGATION_SCHEMA_VERSION,
	MAX_DIGEST_BYTES,
	digestFromPrefix,
	readDelegationLedger,
} from "../extensions/workbench-runtime/core/delegation-ledger.ts";
import { GATE_SCHEMA_VERSION, readPersistedGateRunFacts } from "../extensions/workbench-runtime/core/gate-engine.ts";
import { readManifest, RUN_SCHEMA_VERSION, type RunRecord } from "../extensions/workbench-runtime/core/runs.ts";
import {
	WORKBENCH_TOOL_METADATA,
	WORKBENCH_TOOL_NAMES,
	WORKBENCH_TOOL_PARAMETERS,
	workbenchToolMetadataV1Ordered,
} from "../extensions/workbench-runtime/core/tool-catalog.ts";
import {
	beginBlockReason,
	finalizeUnavailableCode,
	parseFinalizedArtifact,
	parseStartedArtifact,
	recoverFailureText,
	recoverReceipt,
	SCHEMA_VERSION as RECEIPT_SCHEMA_VERSION,
	toolResultsDir,
	type BeginOutcome,
	type FinalizeOutcome,
	type FinalizedReceipt,
	type StartedReceipt,
} from "../extensions/workbench-runtime/core/tool-result-recovery.ts";
import {
	evaluateValidationReuse,
	parseValidationEvidenceBlock,
	VALIDATION_BINDING_SCHEMA_VERSION,
	VALIDATION_EVIDENCE_SCHEMA_VERSION,
	VALIDATION_REFUSAL_REASONS,
	type ValidationCurrentState,
} from "../extensions/workbench-runtime/core/validation-evidence.ts";
import { withTempDir } from "./helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "governance-v1");
const RECEIPT_ID = `wtr1-${"1".repeat(64)}`;

interface Scenario {
	case: string;
	base?: string;
	overlay?: string;
	path?: string;
	directory?: string;
	expected_id?: string;
	directory_id?: string;
	run_id?: string;
	read: string;
	recover: string;
	gate_eligible: boolean | string;
}

interface Inventory {
	authority_types: Record<string, { scenarios: Scenario[] }>;
}

interface ContractSnapshot {
	catalog_hash: string;
	tools: Array<{ name: string; parameters_hash: string; metadata_hash: string }>;
	observable_result_semantics: Array<{ name: string; envelope: string; category: string; source_symbols: string[] }>;
	error_semantics: {
		begin_block_reason_hashes: Record<string, string>;
		finalize_unavailable_codes: string[];
		recover_codes: string[];
		recover_failure_hashes: Record<string, string>;
		validation_refusal_reasons: string[];
	};
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readJsonOrRaw(path: string): Promise<unknown> {
	const raw = await readFile(path, "utf8");
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return raw;
	}
}

async function overlayDirectory(source: string, destination: string): Promise<void> {
	await mkdir(destination, { recursive: true });
	for (const entry of await readdir(source, { withFileTypes: true })) {
		const from = join(source, entry.name);
		const to = join(destination, entry.name);
		if (entry.isDirectory()) await overlayDirectory(from, to);
		else if (entry.isFile()) await copyFile(from, to);
	}
}

async function materialize(scenario: Scenario, destination: string): Promise<void> {
	await rm(destination, { recursive: true, force: true });
	if (scenario.base) await overlayDirectory(join(FIXTURES, scenario.base), destination);
	if (scenario.overlay) await overlayDirectory(join(FIXTURES, scenario.overlay), destination);
	if (scenario.directory) await overlayDirectory(join(FIXTURES, scenario.directory), destination);
	if (scenario.path) {
		await mkdir(destination, { recursive: true });
		await copyFile(join(FIXTURES, scenario.path), join(destination, scenario.path.endsWith("manifest.json") ? "manifest.json" : "summary.json"));
	}
}

async function treeFingerprint(root: string): Promise<Array<{ path: string; bytes: number; sha256: string; mtime_ms: number }>> {
	const rows: Array<{ path: string; bytes: number; sha256: string; mtime_ms: number }> = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) {
				const [bytes, facts] = await Promise.all([readFile(path), stat(path)]);
				rows.push({
					path: relative(root, path),
					bytes: bytes.byteLength,
					sha256: createHash("sha256").update(bytes).digest("hex"),
					mtime_ms: facts.mtimeMs,
				});
			}
		}
	}
	await walk(root);
	return rows;
}

const CURRENT_VALIDATION_STATE: ValidationCurrentState = {
	collectionFailed: false,
	collectionReason: null,
	commit: "afca84f4f6d3cc810b953b16625a1756a7dbc850",
	diffHash: "a".repeat(64),
	lockfiles: {
		"package-lock.json": "missing",
		"npm-shrinkwrap.json": "missing",
		"yarn.lock": "missing",
		"pnpm-lock.yaml": "missing",
		"bun.lockb": "missing",
		"uv.lock": "missing",
		"poetry.lock": "missing",
		"Pipfile.lock": "missing",
		"Cargo.lock": "missing",
		"go.sum": "missing",
		"Gemfile.lock": "missing",
		"composer.lock": "missing",
		"requirements.lock": "missing",
	},
	configHash: "b".repeat(64),
	gateStateHash: "c".repeat(64),
	profile: "generic",
	mode: "DEV",
	target: {
		kind: "recipe",
		name: "unit-test",
		definition_hash: "d".repeat(64),
		invocation_hash: "e".repeat(64),
		cwd: ".",
	},
};

test("governance v1 fixture inventory covers every required authority failure class and remains read-only", async () => {
	const before = await treeFingerprint(FIXTURES);
	const inventory = await readJson<Inventory>(join(FIXTURES, "inventory.json"));
	assert.deepEqual(Object.keys(inventory.authority_types).sort(), ["delegation", "gate", "receipt", "run", "validation-evidence"]);
	const requiredCases = ["valid", "missing-field", "corrupt-truncated", "partial-write", "identity-conflict", "unknown-schema"].sort();
	for (const authority of Object.values(inventory.authority_types)) {
		assert.deepEqual(authority.scenarios.map((scenario) => scenario.case).sort(), requiredCases);
	}
	assert.deepEqual(await treeFingerprint(FIXTURES), before, "inventory inspection never changes fixture bytes or mtimes");
});

test("governance v1 freezes schema constants, public tool input/output categories, metadata and fixed error semantics", async () => {
	assert.deepEqual(
		{
			delegation: DELEGATION_SCHEMA_VERSION,
			run: RUN_SCHEMA_VERSION,
			gate: GATE_SCHEMA_VERSION,
			receipt: RECEIPT_SCHEMA_VERSION,
			validation_evidence: VALIDATION_EVIDENCE_SCHEMA_VERSION,
			validation_binding: VALIDATION_BINDING_SCHEMA_VERSION,
		},
		{ delegation: 1, run: 1, gate: 1, receipt: 1, validation_evidence: 1, validation_binding: 1 },
	);

	const snapshot = await readJson<ContractSnapshot>(join(FIXTURES, "public-tool-contract.json"));
	const v1Catalog = workbenchToolMetadataV1Ordered();
	assert.equal(canonicalHash(v1Catalog), snapshot.catalog_hash);
	assert.deepEqual(WORKBENCH_TOOL_NAMES, snapshot.tools.map((tool) => tool.name));
	for (const tool of snapshot.tools) {
		const v1Tool = v1Catalog.find((entry) => entry.name === tool.name);
		assert.ok(v1Tool, `${tool.name} missing from v1 catalog`);
		const { parameters, ...metadata } = v1Tool;
		assert.equal(canonicalHash(parameters), tool.parameters_hash, `${tool.name} v1 parameter schema drift`);
		assert.equal(canonicalHash(metadata), tool.metadata_hash, `${tool.name} v1 metadata drift`);
	}

	const currentDelegate = WORKBENCH_TOOL_PARAMETERS.workbench_delegate_worker as unknown as {
		required?: string[];
		properties: Record<string, unknown>;
	};
	const v1Delegate = v1Catalog.find((entry) => entry.name === "workbench_delegate_worker")?.parameters as {
		required?: string[];
		properties: Record<string, unknown>;
	};
	assert.ok(v1Delegate);
	assert.deepEqual(
		Object.keys(currentDelegate.properties),
		[...Object.keys(v1Delegate.properties), "task_kind", "plan_ref", "extended_reason"],
		"current delegate input appends only the explicit v2 task, plan and extended-contract fields",
	);
	assert.deepEqual(currentDelegate.required, v1Delegate.required, "task_kind remains optional and cannot rewrite v1 required fields");
	const {
		task_kind: _taskKind,
		plan_ref: _planRef,
		extended_reason: _extendedReason,
		budget_profile: currentBudgetProfile,
		verification: currentVerification,
		...currentStableProperties
	} = currentDelegate.properties;
	const { budget_profile: v1BudgetProfile, verification: v1Verification, ...v1StableProperties } = v1Delegate.properties;
	assert.equal(canonicalHash(currentStableProperties), canonicalHash(v1StableProperties), "non-budget governance-v1 delegate properties stay exact");
	assert.notEqual(canonicalHash(currentBudgetProfile), canonicalHash(v1BudgetProfile), "current budget description may identify the Luna policy without rewriting the frozen v1 catalog");
	assert.notEqual(canonicalHash(currentVerification), canonicalHash(v1Verification), "current verification grammar evolves without rewriting the frozen v1 catalog");
	assert.deepEqual(
		(currentBudgetProfile as { anyOf?: Array<{ const?: unknown }> }).anyOf?.map((entry) => entry.const),
		["standard", "extended"],
		"current budget exposes only the active profile enum",
	);
	assert.equal((currentBudgetProfile as { default?: unknown }).default, "extended");
	const currentMetadata = WORKBENCH_TOOL_METADATA.workbench_delegate_worker;
	const currentMetadataText = [
		currentMetadata.description,
		currentMetadata.promptSnippet,
		...currentMetadata.promptGuidelines,
	].join("\n");
	assert.match(currentMetadataText, /GPT-5\.6 Luna xhigh/);
	assert.match(currentMetadataText, /diagnosis is strictly read-only/i);
	assert.match(currentMetadataText, /repair_of .* minimal authority-derived repair capsule/is);
	assert.match(currentMetadataText, /Sol retains architecture, semantic review, final verification, Gates/i);

	// Output contracts are deliberately categories + source symbols, not an
	// invented universal return interface. Every tool is still registered by
	// the catalog and every claimed renderer/authority symbol exists in source.
	const runtimeCore = join(HERE, "..", "extensions", "workbench-runtime", "core");
	const source = [
		await readFile(join(HERE, "..", "extensions", "workbench-runtime", "index.ts"), "utf8"),
		...await Promise.all(
			(await readdir(runtimeCore))
				.filter((name) => name.endsWith(".ts"))
				.sort()
				.map((name) => readFile(join(runtimeCore, name), "utf8")),
		),
	].join("\n");
	assert.deepEqual(snapshot.observable_result_semantics.map((entry) => entry.name), [...WORKBENCH_TOOL_NAMES]);
	for (const entry of snapshot.observable_result_semantics) {
		assert.equal(entry.envelope, "text-content+bounded-details");
		assert.ok(entry.category.length > 0);
		assert.match(source, new RegExp(`WORKBENCH_TOOL_METADATA\\.${entry.name}\\b`));
		for (const symbol of entry.source_symbols) assert.ok(source.includes(symbol), `${entry.name} output source symbol ${symbol} missing`);
	}

	const started = parseStartedArtifact(
		await readFile(join(FIXTURES, "receipt", "valid", `${RECEIPT_ID}.started`), "utf8"),
		RECEIPT_ID,
	);
	const finalized = parseFinalizedArtifact(
		await readFile(join(FIXTURES, "receipt", "valid", `${RECEIPT_ID}.json`), "utf8"),
		RECEIPT_ID,
	);
	assert.equal(started.ok, true);
	assert.equal(finalized.ok, true);
	if (!started.ok || !finalized.ok) return;
	const beginSamples: Record<string, BeginOutcome> = {
		completed_replay: { ok: false, kind: "completed_replay", receipt: finalized.value },
		incomplete_replay: { ok: false, kind: "incomplete_replay", started: started.value },
		corrupt_receipt: { ok: false, kind: "corrupt_receipt" },
		identity_conflict: { ok: false, kind: "identity_conflict" },
		invalid_identity: { ok: false, kind: "invalid_identity" },
		storage_error: { ok: false, kind: "storage_error", reason: "read_failed" },
	};
	assert.deepEqual(Object.keys(beginSamples), Object.keys(snapshot.error_semantics.begin_block_reason_hashes));
	for (const [kind, outcome] of Object.entries(beginSamples)) {
		assert.equal(canonicalHash(beginBlockReason(outcome)), snapshot.error_semantics.begin_block_reason_hashes[kind]);
	}

	const finalizeSamples: FinalizeOutcome[] = [
		{ ok: false, kind: "invalid_handle" },
		{ ok: false, kind: "missing_started" },
		{ ok: false, kind: "corrupt_started" },
		{ ok: false, kind: "identity_conflict" },
		{ ok: false, kind: "already_finalized" },
		{ ok: false, kind: "write_error", reason: "read_failed" },
	];
	assert.deepEqual(finalizeSamples.map(finalizeUnavailableCode), snapshot.error_semantics.finalize_unavailable_codes);
	for (const code of snapshot.error_semantics.recover_codes) {
		assert.equal(canonicalHash(recoverFailureText(code)), snapshot.error_semantics.recover_failure_hashes[code]);
	}
	assert.deepEqual(VALIDATION_REFUSAL_REASONS, snapshot.error_semantics.validation_refusal_reasons);
});

test("governance v1 delegation fixtures characterize permissive reads but keep incomplete or foreign records gate-ineligible", async () => {
	const inventory = await readJson<Inventory>(join(FIXTURES, "inventory.json"));
	for (const scenario of inventory.authority_types.delegation!.scenarios) {
		await withTempDir(async (projectRoot) => {
			const id = scenario.expected_id!;
			const destination = join(projectRoot, CONFIG_DIR_NAME, "workbench", "delegations", id);
			await materialize(scenario, destination);
			const before = await treeFingerprint(projectRoot);
			const ledger = await readDelegationLedger(projectRoot, id);
			const acceptedByReader = ledger !== null;
			assert.equal(acceptedByReader, scenario.read.startsWith("accepted"), scenario.case);
			const completeV1 =
				ledger !== null &&
				ledger.manifest.schema_version === 1 &&
				ledger.before.schema_version === 1 &&
				ledger.after?.schema_version === 1 &&
				ledger.workerSummary?.schema_version === 1 &&
				ledger.manifest.status === "finished" &&
				ledger.manifest.delegation_id === id &&
				ledger.before.delegation_id === id &&
				ledger.after.delegation_id === id &&
				ledger.workerSummary.delegation_id === id;
			assert.equal(completeV1, scenario.case === "valid", `${scenario.case} must not be upgraded to complete v1 authority`);
			assert.equal(scenario.gate_eligible, false, "delegation ledger is not direct formal gate evidence");
			assert.deepEqual(await treeFingerprint(projectRoot), before, `${scenario.case} reader must be read-only`);
		});
	}
});

test("governance v1 run fixtures expose current identity-validation defect without granting gate eligibility", async () => {
	const inventory = await readJson<Inventory>(join(FIXTURES, "inventory.json"));
	for (const scenario of inventory.authority_types.run!.scenarios) {
		await withTempDir(async (projectRoot) => {
			const id = scenario.directory_id!;
			const destination = join(projectRoot, CONFIG_DIR_NAME, "workbench", "runs", id);
			await materialize(scenario, destination);
			const before = await treeFingerprint(projectRoot);
			const manifest = await readManifest(projectRoot, id);
			assert.equal(manifest !== null, scenario.read.startsWith("accepted"), scenario.case);
			const identityComplete =
				manifest !== null &&
				manifest.schema_version === 1 &&
				manifest.run_id === id &&
				typeof manifest.finished_at === "string" &&
				manifest.exit_code !== null &&
				!manifest.timed_out &&
				!manifest.cancelled;
			assert.equal(identityComplete, scenario.case === "valid", `${scenario.case} standalone run is not complete/current gate evidence`);
			assert.deepEqual(await treeFingerprint(projectRoot), before, `${scenario.case} reader must be read-only`);
		});
	}
});

test("governance v1 gate fixtures remain historical and legacy manual provenance cannot regain authority", async () => {
	const inventory = await readJson<Inventory>(join(FIXTURES, "inventory.json"));
	for (const scenario of inventory.authority_types.gate!.scenarios) {
		await withTempDir(async (projectRoot) => {
			const id = scenario.run_id!;
			const destination = join(projectRoot, CONFIG_DIR_NAME, "workbench", "runs", id);
			await materialize(scenario, destination);
			const before = await treeFingerprint(projectRoot);
			const manifest = await readManifest(projectRoot, id);
			assert.ok(manifest, `${scenario.case} carries a parseable v1 manifest so artifact reconstruction is isolated`);
			const facts = await readPersistedGateRunFacts(projectRoot, id, manifest as RunRecord);
			assert.equal(facts, null, `${scenario.case} cannot satisfy the repaired strict provenance reader`);
			assert.equal(scenario.gate_eligible, scenario.case === "valid" ? "conditional" : false);
			assert.deepEqual(await treeFingerprint(projectRoot), before, `${scenario.case} gate reader must be read-only`);
		});
	}
});

test("governance v1 receipt fixtures freeze strict phase parsing and deterministic read-only recovery classes", async () => {
	const inventory = await readJson<Inventory>(join(FIXTURES, "inventory.json"));
	for (const scenario of inventory.authority_types.receipt!.scenarios) {
		await withTempDir(async (projectRoot) => {
			await materialize(scenario, toolResultsDir(projectRoot));
			const before = await treeFingerprint(projectRoot);
			const startedRaw = await readFile(join(toolResultsDir(projectRoot), `${RECEIPT_ID}.started`), "utf8").catch(() => null);
			const finalizedRaw = await readFile(join(toolResultsDir(projectRoot), `${RECEIPT_ID}.json`), "utf8").catch(() => null);
			const started = startedRaw === null ? null : parseStartedArtifact(startedRaw, RECEIPT_ID);
			const finalized = finalizedRaw === null ? null : parseFinalizedArtifact(finalizedRaw, RECEIPT_ID);
			if (scenario.case === "valid" || scenario.case === "partial-write" || scenario.case === "identity-conflict") {
				assert.equal(started?.ok, true, scenario.case);
			} else {
				assert.equal(started?.ok, false, scenario.case);
			}
			if (scenario.case === "valid" || scenario.case === "identity-conflict") assert.equal(finalized?.ok, true, scenario.case);
			const recovered = await recoverReceipt({ projectRoot, id: RECEIPT_ID });
			assert.equal(recovered.kind, scenario.recover, scenario.case);
			assert.equal(scenario.gate_eligible, false, "receipt summaries are presentation, never gate evidence");
			assert.deepEqual(await treeFingerprint(projectRoot), before, `${scenario.case} recovery must not change bytes or mtimes`);
		});
	}
});

test("governance v1 validation-evidence fixtures parse and reuse only an exact complete current-state binding", async () => {
	const inventory = await readJson<Inventory>(join(FIXTURES, "inventory.json"));
	for (const scenario of inventory.authority_types["validation-evidence"]!.scenarios) {
		const raw = await readJsonOrRaw(join(FIXTURES, scenario.path!));
		const parsed = parseValidationEvidenceBlock(raw);
		assert.equal(parsed.ok, scenario.read === "accepted", scenario.case);
		const verdict = evaluateValidationReuse(raw, CURRENT_VALIDATION_STATE);
		if (scenario.case === "valid") {
			assert.deepEqual(verdict, { reusable: true, reasons: [] });
			assert.equal(scenario.gate_eligible, "conditional", "exact current-state reuse is still only one condition of formal gate authority");
		} else {
			assert.equal(verdict.reusable, false, scenario.case);
			assert.equal(verdict.reasons[0], scenario.recover, scenario.case);
			assert.equal(scenario.gate_eligible, false);
		}
	}
});

test("governance v1 per-file missing and parse failures remain classified and never become complete authority", async () => {
	await withTempDir(async (projectRoot) => {
		const id = "20260817-010000-a001";
		const destination = join(projectRoot, CONFIG_DIR_NAME, "workbench", "delegations", id);
		await overlayDirectory(join(FIXTURES, "delegation", "valid"), destination);
		const validBytes = new Map<string, Buffer>();
		for (const name of ["manifest.json", "before.json", "after.json", "worker-summary.json"]) {
			validBytes.set(name, await readFile(join(destination, name)));
		}
		const corrupt = await readFile(join(FIXTURES, "delegation", "corrupt-truncated", "manifest.json"));
		for (const name of validBytes.keys()) {
			await rm(join(destination, name));
			const missing = await readDelegationLedger(projectRoot, id);
			assert.equal(missing === null, name === "manifest.json" || name === "before.json", `${name} missing classification drift`);
			await copyFile(join(FIXTURES, "delegation", "valid", name), join(destination, name));
			await copyFile(join(FIXTURES, "delegation", "corrupt-truncated", "manifest.json"), join(destination, name));
			const malformed = await readDelegationLedger(projectRoot, id);
			assert.equal(malformed === null, name === "manifest.json" || name === "before.json", `${name} corrupt classification drift`);
			await copyFile(join(FIXTURES, "delegation", "valid", name), join(destination, name));
		}
		assert.ok(corrupt.byteLength > 0);
	});

	await withTempDir(async (projectRoot) => {
		const id = "20260817-030000-c001";
		const destination = join(projectRoot, CONFIG_DIR_NAME, "workbench", "runs", id);
		await overlayDirectory(join(FIXTURES, "gate", "valid"), destination);
		const manifest = await readManifest(projectRoot, id);
		assert.ok(manifest);
		for (const name of ["gates.json", "evidence.json"]) {
			await rm(join(destination, name));
			assert.equal(await readPersistedGateRunFacts(projectRoot, id, manifest), null, `${name} missing must fail closed`);
			await copyFile(join(FIXTURES, "gate", "valid", name), join(destination, name));
			await copyFile(join(FIXTURES, "gate", "corrupt-truncated", "gates.json"), join(destination, name));
			assert.equal(await readPersistedGateRunFacts(projectRoot, id, manifest), null, `${name} parse failure must fail closed`);
			await copyFile(join(FIXTURES, "gate", "valid", name), join(destination, name));
		}
	});
});

test("governance v1 defect characterization: equal 4 MiB prefixes hide equal-size tail changes", () => {
	const totalBytes = MAX_DIGEST_BYTES + 1;
	const leftContent = Buffer.alloc(totalBytes, 0x61);
	const rightContent = Buffer.from(leftContent);
	rightContent[MAX_DIGEST_BYTES] = 0x62;

	const leftFullHash = createHash("sha256").update(leftContent).digest("hex");
	const rightFullHash = createHash("sha256").update(rightContent).digest("hex");
	assert.notEqual(leftFullHash, rightFullHash, "different tail bytes must change the full-content SHA-256");

	const left = digestFromPrefix(leftContent.subarray(0, MAX_DIGEST_BYTES), totalBytes);
	const right = digestFromPrefix(rightContent.subarray(0, MAX_DIGEST_BYTES), totalBytes);
	assert.equal(left, right, "current v1 prefix digest cannot distinguish bytes beyond the captured prefix");
	assert.match(left, new RegExp(`:${totalBytes}$`));
});
