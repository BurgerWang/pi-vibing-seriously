/**
 * Workbench Gate Engine — runs the validation ladder and persists gate runs.
 *
 * A gate run writes `<project-root>/.pi/workbench/runs/<run-id>/`:
 *   manifest.json, gates.json, evidence.json, summary.json, stdout.log,
 *   stderr.log, artifacts/ (copied evidence sources)
 *
 * Status model (spec §3): PASS | FAIL | BLOCKED | NOT_RUN.
 *   - a required check that is NOT_RUN can never make a gate PASS
 *   - a non-PASS outcome of a blocking prerequisite BLOCKs dependents
 *     (the complete prerequisite closure executes in the same run, so a
 *     historical gate result can never satisfy current-run authority)
 *   - warnings never upgrade a status; a check with no verified assertion
 *     is NOT_RUN or FAIL, never PASS
 *   - numeric constraints are only evaluated against structured artifacts
 *   - manual evidence is only ever recorded with type "manual" — model
 *     prose can never masquerade as machine verification
 */

import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { globSync } from "node:fs";
import { basename, join, matchesGlob, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";

import { loadProjectConfig, runsDir, type ConfigIssue, type ExecFn, type ProjectConfig } from "./config.ts";
import { GATE_CATALOG } from "./gate-catalog.ts";
import {
	effectiveGates,
	orderGates,
	parseGatesDocument,
	resolveSelector,
	type Gate,
	type GateCheck,
	type GateStatus,
	type WorkerFirstCheckName,
	type WorkerFirstGateFacts,
	WORKER_FIRST_CHECK_NAMES,
	QUANT_GATE_ID_RE,
	GATE_STATUSES,
} from "./gate-schema.ts";
import { validateQuantResearchEvidence, validateQuantResult } from "./quant-result.ts";
import { validateQuantContract } from "../cache/quant-contracts.ts";
import { realpathContained } from "./path-guard.ts";
import { runRecipe } from "./recipe-runner.ts";
import type { Recipe } from "./recipe-schema.ts";
import { recipeMutationBlockReason, type RecipeMutationFacts } from "./worker-policy.ts";
import {
	iterateGateRunCandidates,
	latestRunAttemptForRecipe,
	makeRunId,
	readCommittedManifest,
	registerGateRunAttemptIndex,
	RUN_MANIFEST_SCHEMA_VERSION_V2,
	type RunRecord,
} from "./runs.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import {
	assessRecipeSourceValidation,
	captureGateValidationEvidence,
	unavailableEvidenceBlock,
	validationEvidenceIdentity,
	validationEvidenceSourceEligible,
	type TrustedWorkbenchConfigFileDigest,
} from "./validation-evidence.ts";
import { readJsonFileBounded, readUtf8FileBounded, type BoundedFileIoHooks } from "./bounded-file-io.ts";
import { validateCommittedArtifactsV2 } from "./artifact-contract.ts";
import { beginRunTransaction, commitRunTransaction } from "./run-transaction.ts";
import { readCurrentDelegationPlanAuthority, type CurrentDelegationPlanAuthority } from "./delegation-plan-reference.ts";
import type { GatePlanValidationFacts } from "./validation-evidence.ts";
import {
	gateCandidateSourceAuthorityV1,
	parseGateCandidateBindingV1,
	type GateCandidateBindingV1,
} from "./candidate-binding.ts";
import { currentRunRuntimeIdentityV1 } from "./candidate-identity.ts";

export const GATE_SCHEMA_VERSION = 1;
/** Persisted gate/evidence records are authority inputs, never unbounded JSON channels. */
export const GATE_AUTHORITY_RECORD_MAX_BYTES = 1_048_576 as const;
/** Project gate configuration uses the exact gate-authority ceiling and may never raise it. */
export const GATE_CONFIG_MAX_BYTES = GATE_AUTHORITY_RECORD_MAX_BYTES;
/** Fixed fail-closed result for every present gate configuration that cannot be read as one stable UTF-8 file. */
export const GATE_CONFIG_READ_ERROR = "gates.yaml: bounded gate config read failed under fixed 1048576-byte regular UTF-8 file policy" as const;
/** Fixed fail-closed result when a complete gate authority record cannot fit. */
export const GATE_AUTHORITY_PERSISTENCE_ERROR = "gate authority persistence failed: complete record exceeds fixed 1048576-byte limit" as const;
/** Gate-declared JSON artifacts use the same fixed same-open preflight ceiling. */
export const GATE_JSON_ARTIFACT_MAX_BYTES = 1_048_576 as const;

/**
 * P4b: the caller's manual-evidence map trimmed for EVALUATION — every
 * note trimmed, empty-after-trim notes dropped (a check with an empty
 * note is NOT_RUN and records NO evidence entry). This is what checks see
 * and what type "manual" evidence entries persist; it may carry
 * extra/unknown caller keys that no check consumes — those keys never
 * reach the persisted evidence and therefore must never enter the
 * validation binding (see persistedManualEvidence below).
 */
export function trimmedManualEvidence(raw: Readonly<Record<string, string>> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [checkId, note] of Object.entries(raw ?? {})) {
		if (typeof note !== "string") continue;
		const trimmed = note.trim();
		if (trimmed.length === 0) continue;
		out[checkId] = trimmed;
	}
	return out;
}

/**
 * P4b: the manual evidence map EXACTLY as the persisted evidence.json
 * records it — recovered from the ACTUAL type "manual" evidence entries of
 * this run with the SAME check-id/note semantics and last-entry-wins
 * recovery as readPersistedGateRunFacts (an entry must name its own check;
 * the trimmed note must be non-empty). The gate binding hash must cover
 * exactly this map so the persisted gate evidence can reproduce the
 * privacy-safe hash at assessment time. Extra/unknown caller keys that no
 * check consumed never appear in evidence.json — they must not enter the
 * binding either.
 */
export function persistedManualEvidence(evidenceByCheck: Readonly<Record<string, CheckRunEntry>>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [checkId, check] of Object.entries(evidenceByCheck)) {
		for (const entry of check.evidence) {
			if (entry.type !== "manual" || entry.check_id !== checkId || entry.provided_by !== "user-command") continue;
			const note = entry.detail.trim();
			if (note.length > 0) out[checkId] = note;
		}
	}
	return out;
}

export class GateSetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GateSetupError";
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvidenceEntry {
	type: "config" | "recipe_run" | "artifact" | "file" | "json" | "numeric" | "manual" | "schema" | "worker_first";
	source?: string;
	detail: string;
	run_id?: string;
	recipe?: string;
	exit_code?: number | null;
	/** P6-C: "exec" (executed) or "cache" (reused from the action cache). */
	execution_source?: string;
	value?: unknown;
	paths?: string[];
	check_id?: string;
	provided_by?: string;
	/** SHA-256 identity of the source validation binding for authority edges. */
	authority_digest?: string;
	authority_freshness?: "current" | "immutable-snapshot";
	errors?: string[];
	warnings?: string[];
	artifact_path?: string;
}

export interface CheckRunEntry {
	check_id: string;
	gate_id: string;
	status: GateStatus;
	kind: string;
	required: boolean;
	blocking: boolean;
	evidence: EvidenceEntry[];
	failure_reason: string | null;
	blocked_reason: string | null;
	warnings: string[];
	started_at: string;
	finished_at: string;
	duration_ms: number;
}

export interface GateRunEntry {
	id: string;
	title: string;
	description: string;
	status: GateStatus;
	required: boolean;
	blocking: boolean;
	prerequisites: string[];
	prerequisite_status: Record<string, { status: GateStatus; source: string }>;
	checks: CheckRunEntry[];
	failure_reason: string | null;
	blocked_reason: string | null;
	warnings: string[];
	evidence_paths: string[];
	declared_evidence: string[];
	started_at: string;
	finished_at: string;
	duration_ms: number;
}

export interface RunGatesInput {
	projectRoot: string;
	selector: string;
	mode: WorkbenchMode;
	exec: ExecFn;
	signal?: AbortSignal;
	now?: () => Date;
	manualEvidence?: Record<string, string>;
	/**
	 * Provenance of manual evidence. Only the user-command path may satisfy a
	 * human check. Model-tool notes remain advisory and evaluate NOT_RUN.
	 * Direct programmatic callers retain the historical trusted-user default.
	 */
	manualEvidenceProvenance?: "user-command" | "model-tool";
	/**
	 * P7: bounded worker-first compliance facts injected by the runtime.
	 * Missing facts make every worker-first check NOT_RUN (never PASS).
	 */
	workerFirstFacts?: WorkerFirstGateFacts;
	/** P7: actor facts for the shared recipe mutation policy in recipe checks. */
	actorFacts?: RecipeMutationFacts;
	/** Test-only allocation observation; cannot raise the fixed JSON artifact cap. */
	jsonFileReadHooks?: BoundedFileIoHooks;
	/** Test-only stable-snapshot observation; cannot raise the gate config cap. */
	gateConfigReadHooks?: GateConfigReadHooks;
	/** WP5 strict-lane identity; accepted only in VERIFY and persisted everywhere authority is reconstructed. */
	candidateBinding?: GateCandidateBindingV1;
}

export interface RunGatesResult {
	ok: boolean;
	status: GateStatus;
	runId: string;
	runDir: string;
	gates: GateRunEntry[];
	requested: string[];
	profile: string | undefined;
	candidateIdentity?: string;
}

export interface GateFileRecord {
	schema_version: number;
	run_id: string;
	requested: string[];
	profile: string | undefined;
	mode: string;
	candidate_binding?: GateCandidateBindingV1;
	gates: GateRunEntry[];
}

// ---------------------------------------------------------------------------
// Gate loading (catalog + gates.yaml)
// ---------------------------------------------------------------------------

/**
 * Test instrumentation for the gate authority read. `afterStableSnapshot`
 * runs only after same-handle verification and strict gate parsing have
 * completed, immediately before the parsed document is handed to the generic
 * config parser. It receives no content and cannot alter any limit.
 */
export interface GateConfigReadHooks extends BoundedFileIoHooks {
	afterStableSnapshot?: () => void | Promise<void>;
}

async function readGatesYaml(
	projectRoot: string,
	hooks?: GateConfigReadHooks,
): Promise<{ doc: unknown; errors: string[]; trustedConfigFileDigest?: TrustedWorkbenchConfigFileDigest }> {
	const path = join(projectRoot, CONFIG_DIR_NAME, "workbench", "gates.yaml");
	// Preserve the documented optional-file semantics without treating every
	// I/O failure as absence. Once a path exists, the shared bounded reader
	// opens it, stats the SAME handle, rejects non-regular/oversized sources
	// before allocation, validates UTF-8, and verifies that opened handle's
	// identity after the read. Any read failure after this presence probe
	// fails closed instead of silently dropping project gates.
	try {
		await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			// Missing gates.yaml means "no project gates" — the built-in catalog applies.
			return {
				doc: undefined,
				errors: [],
				trustedConfigFileDigest: { key: "gates.yaml", path, digest: "missing" },
			};
		}
		return { doc: undefined, errors: [GATE_CONFIG_READ_ERROR] };
	}
	const read = await readUtf8FileBounded(path, GATE_CONFIG_MAX_BYTES, hooks);
	if (!read.ok) return { doc: undefined, errors: [GATE_CONFIG_READ_ERROR] };
	// The bounded reader proves and decodes one stable open-handle snapshot.
	// Valid UTF-8 round-trips byte-for-byte except that TextDecoder consumes a
	// leading BOM. Reconstruct that sole case from the exact source byte count
	// and hash incrementally, avoiding a second file read or full-size buffer.
	const decodedBytes = Buffer.byteLength(read.value.text, "utf8");
	const digest = createHash("sha256");
	if (decodedBytes === read.value.bytes) {
		digest.update(read.value.text, "utf8");
	} else if (decodedBytes + 3 === read.value.bytes) {
		digest.update(Uint8Array.of(0xef, 0xbb, 0xbf));
		digest.update(read.value.text, "utf8");
	} else {
		return { doc: undefined, errors: [GATE_CONFIG_READ_ERROR] };
	}
	const trustedConfigFileDigest: TrustedWorkbenchConfigFileDigest = {
		key: "gates.yaml",
		path,
		digest: digest.digest("hex"),
	};
	try {
		const doc = parseYaml(read.value.text);
		if (doc === null || doc === undefined) return { doc: undefined, errors: [], trustedConfigFileDigest };
		return { doc, errors: [], trustedConfigFileDigest };
	} catch (error) {
		return { doc: undefined, errors: [`gates.yaml: ${(error as Error).message}`] };
	}
}

/**
 * Load the effective gate catalog for a project. Deep parse errors in
 * gates.yaml abort with GateSetupError — a broken gate declaration must
 * never silently drop checks from the ladder.
 */
async function loadGateSelectionConfig(
	projectRoot: string,
	hooks?: GateConfigReadHooks,
): Promise<{ config: ProjectConfig; gates: Gate[]; trustedConfigFileDigest: TrustedWorkbenchConfigFileDigest }> {
	const yaml = await readGatesYaml(projectRoot, hooks);
	if (yaml.errors.length > 0) throw new GateSetupError(yaml.errors.join("; "));
	if (!yaml.trustedConfigFileDigest) throw new GateSetupError(GATE_CONFIG_READ_ERROR);
	const parsed = parseGatesDocument(yaml.doc);
	if (parsed.errors.length > 0) throw new GateSetupError(parsed.errors.join("; "));
	await hooks?.afterStableSnapshot?.();
	const config = await loadProjectConfig(projectRoot, {
		trusted: true,
		parsedGatesDocument: { value: yaml.doc },
	});
	let gates: Gate[];
	try {
		gates = effectiveGates(config.profile, GATE_CATALOG, parsed.gates);
	} catch (error) {
		throw new GateSetupError((error as Error).message);
	}
	return { config, gates, trustedConfigFileDigest: yaml.trustedConfigFileDigest };
}

export async function loadGates(projectRoot: string, hooks?: GateConfigReadHooks): Promise<Gate[]> {
	return (await loadGateSelectionConfig(projectRoot, hooks)).gates;
}

// ---------------------------------------------------------------------------
// Gate selection (shared, non-writing)
// ---------------------------------------------------------------------------

interface GateSelection {
	config: ProjectConfig;
	gates: Gate[];
	/** Exact stable gates.yaml bytes used by selection, for validation binding. */
	trustedConfigFileDigest: TrustedWorkbenchConfigFileDigest;
	/** Selector-expanded requested gate ids, in selector order. */
	requestedIds: string[];
	/** Complete prerequisite closure in topological execution order. */
	ordered: string[];
}

/**
 * Shared non-writing selection step for runGates and the Phase 3A preflight:
 * load the project config + effective gate catalog, resolve the selector and
 * fail closed (GateSetupError) on empty/unknown/profile-invalid selectors and
 * prerequisite cycles — exactly the validation formal gate runs apply. Never
 * writes, never executes anything, never reads run records.
 */
async function selectGates(projectRoot: string, selector: string, hooks?: GateConfigReadHooks): Promise<GateSelection> {
	// One fixed-size, same-handle gates.yaml snapshot supplies BOTH the strict
	// executable Gate[] and config.gates (the gate-state binding input). The
	// generic loader receives the parsed authority directly and cannot reread
	// the path into a different snapshot.
	const { gates, config, trustedConfigFileDigest } = await loadGateSelectionConfig(projectRoot, hooks);

	const requestedIds = resolveSelector(selector, gates);
	if (requestedIds.length === 0) {
		throw new GateSetupError(`selector "${selector}" matched no gates`);
	}
	const known = new Set(gates.map((g) => g.id));
	const unknown = requestedIds.filter((id) => !known.has(id));
	if (unknown.length > 0) {
		const quantOnly = QUANT_GATE_ID_RE.test(unknown[0] ?? "");
		throw new GateSetupError(
			`gate(s) not available for profile ${config.profile ?? "(none)"}: ${unknown.join(", ")}${quantOnly ? " (quant gates load only for quant-research profiles)" : ""}`,
		);
	}

	let ordered: string[];
	try {
		ordered = orderGates(requestedIds, gates);
	} catch (error) {
		throw new GateSetupError((error as Error).message);
	}
	return { config, gates, trustedConfigFileDigest, requestedIds, ordered };
}

function carriesInjectedPlanFacts(facts: WorkerFirstGateFacts | undefined): boolean {
	return facts?.planReferenceHash !== undefined || facts?.requiredGateIds !== undefined ||
		facts?.planReferenceCurrent !== undefined || facts?.planReferenceBlockedReason !== undefined;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isFinalPlanSelector(selector: string): boolean {
	const token = selector.trim();
	return token === "base" || token === "all";
}

interface GatePlanRunAuthority {
	authority: CurrentDelegationPlanAuthority;
	validation?: GatePlanValidationFacts;
}

/**
 * Re-read and verify the immutable delegation plan immediately before a Gate
 * run is allocated. The bounded injected facts must exactly match the strict
 * contract projection; model input and plan prose are never consulted.
 */
async function resolveGatePlanRunAuthority(
	projectRoot: string,
	selector: string,
	gates: readonly Gate[],
	effectiveGateIds: readonly string[],
	facts: WorkerFirstGateFacts | undefined,
): Promise<GatePlanRunAuthority> {
	const authority = await readCurrentDelegationPlanAuthority(projectRoot, facts?.latestDelegationId);
	if (authority.status === "blocked") {
		throw new GateSetupError(`PLAN_REFERENCE_BLOCKED:${authority.reason}`);
	}
	if (authority.status === "absent") {
		if (carriesInjectedPlanFacts(facts)) throw new GateSetupError("PLAN_REFERENCE_FACTS_MISMATCH");
		return { authority };
	}
	const expectedGates = [...authority.requiredGateIds].sort();
	const injectedGates = [...new Set(facts?.requiredGateIds ?? [])].sort();
	if (facts?.planReferenceHash !== authority.planReferenceHash || facts.planReferenceCurrent !== true ||
		facts.planReferenceBlockedReason !== undefined || !sameStrings(injectedGates, expectedGates)) {
		throw new GateSetupError("PLAN_REFERENCE_FACTS_MISMATCH");
	}
	const known = new Set(gates.map((gate) => gate.id));
	const unavailable = expectedGates.filter((gateId) => !known.has(gateId));
	if (unavailable.length > 0) {
		throw new GateSetupError(`PLAN_REFERENCE_GATE_UNAVAILABLE:${unavailable.join(",")}`);
	}
	const effective = new Set(effectiveGateIds);
	const unselected = expectedGates.filter((gateId) => !effective.has(gateId));
	const finalSelector = isFinalPlanSelector(selector);
	if (finalSelector && unselected.length > 0) {
		const quantMapped = unselected.some((gateId) => QUANT_GATE_ID_RE.test(gateId));
		throw new GateSetupError(
			`PLAN_REFERENCE_SELECTOR_INCOMPLETE:${unselected.join(",")}${quantMapped ? ":use-all-for-quant-plan-gates" : ""}`,
		);
	}
	return {
		authority,
		validation: {
			plan_reference_hash: authority.planReferenceHash,
			required_gate_ids: expectedGates,
			coverage: finalSelector && unselected.length === 0 ? "FULL" : "PARTIAL",
		},
	};
}

// ---------------------------------------------------------------------------
// Phase 3A: pure/read-only manual-evidence preflight
// ---------------------------------------------------------------------------

export interface RequiredManualCheckFacts {
	gate_id: string;
	check_id: string;
	/** The declared manual_prompt (undefined when the gate sets none). */
	prompt: string | undefined;
	/** True iff the caller's evidence satisfies this check under exact trimmedManualEvidence semantics. */
	provided: boolean;
}

export interface PreflightManualEvidenceResult {
	/** The selector exactly as passed. */
	selector: string;
	/** Selector-expanded requested gate ids, in selector order. */
	requested: string[];
	profile: string | undefined;
	/**
	 * Required (kind=manual && required) checks of the effective prerequisite
	 * closure, in
	 * deterministic effective gate/check order (gates sorted by id, checks in
	 * declaration order). Optional manual checks are excluded.
	 */
	required_manual_checks: RequiredManualCheckFacts[];
	/** Required manual check ids the caller's evidence satisfies (trimmed, non-empty note). */
	provided_required_ids: string[];
	/** Required manual check ids with no satisfying evidence. */
	missing_required_ids: string[];
	/** True iff every required manual check of the effective prerequisite closure is provided. */
	manual_evidence_ready: boolean;
}

/**
 * Phase 3A: pure/read-only manual-evidence preflight — machine facts only.
 *
 * Resolves the SAME selection as runGates (project config, effective gate
 * catalog, selector expansion, unknown/profile validation, prerequisite
 * ordering) and reports exactly which required manual checks the caller's
 * evidence map satisfies — under the exact trimmedManualEvidence semantics
 * formal runs evaluate with. Raw notes are never returned.
 *
 * PURE READ-ONLY: reads config/gates.yaml only — no run id, no mkdir, no
 * git/exec, no recipe execution, no check evaluation, no latest-status read,
 * no persistence. It assigns no Gate status and can never return
 * PASS/FAIL/BLOCKED/NOT_RUN: `manual_evidence_ready` is the only readiness
 * signal.
 */
export async function preflightGateManualEvidence(input: {
	projectRoot: string;
	selector: string;
	manualEvidence?: Record<string, string>;
}): Promise<PreflightManualEvidenceResult> {
	const { config, gates, requestedIds, ordered } = await selectGates(input.projectRoot, input.selector);
	const trimmed = trimmedManualEvidence(input.manualEvidence);
	const effectiveSet = new Set(ordered);

	const requiredChecks: RequiredManualCheckFacts[] = [];
	const providedRequiredIds: string[] = [];
	const missingRequiredIds: string[] = [];
	for (const gate of gates) {
		if (!effectiveSet.has(gate.id)) continue;
		for (const check of gate.checks) {
			if (check.kind !== "manual" || !check.required) continue;
			const provided = trimmed[check.id] !== undefined;
			requiredChecks.push({ gate_id: gate.id, check_id: check.id, prompt: check.manual_prompt, provided });
			if (provided) providedRequiredIds.push(check.id);
			else missingRequiredIds.push(check.id);
		}
	}

	return {
		selector: input.selector,
		requested: requestedIds,
		profile: config.profile,
		required_manual_checks: requiredChecks,
		provided_required_ids: providedRequiredIds,
		missing_required_ids: missingRequiredIds,
		manual_evidence_ready: missingRequiredIds.length === 0,
	};
}

// ---------------------------------------------------------------------------
// Persisted gate run record reader (P4b, fail-closed)
// ---------------------------------------------------------------------------

const MAX_MANUAL_NOTE_CHARS = 262_144;

/**
 * The bounded source facts a gate-run assessment recovers from the
 * persisted gate artifacts — gate ids + their resolved prerequisite
 * statuses (status ONLY; sources/run ids dropped) and the recovered manual
 * evidence (check id → note, hashed, never rendered raw).
 */
export interface PersistedGateRunFacts {
	/** selector-expanded requested gate ids (as persisted). */
	requested: string[];
	gates: Array<{ id: string; prerequisiteStatus: Record<string, GateStatus> }>;
	/** check id → manual note, recovered from evidence.json type "manual" entries. */
	manualEvidence: Record<string, string>;
	/** External artifact authority edges recovered from persisted evidence. */
	artifactSources: Array<{
		checkId: string;
		recipe: string;
		runId: string;
		authorityDigest: string;
		freshness: "current" | "immutable-snapshot";
	}>;
	/** Frozen Candidate edge, present only on WP5 strict-lane Gate runs. */
	candidateBinding?: GateCandidateBindingV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Privacy/resource-safe identity for an individual JSON value. The compact
 * serialization is used only to compute fixed-size facts; raw hostile values
 * never enter a failure reason, evidence detail, log line, or authority
 * record. Values parsed from gate JSON artifacts have already passed the
 * fixed 1 MiB same-open read cap.
 */
function jsonValueFacts(value: unknown): string {
	const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) return `type=${type}, json_bytes=unavailable, sha256=unavailable`;
		return `type=${type}, json_bytes=${Buffer.byteLength(serialized, "utf8")}, sha256=${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
	} catch {
		return `type=${type}, json_bytes=unavailable, sha256=unavailable`;
	}
}

/**
 * Compile exactly the bytes that will be written, before either authority
 * file is opened. Authority facts are never silently truncated: an otherwise
 * legitimate but too-large run fails setup with one fixed bounded error and
 * cannot be returned as a successful gate run.
 */
function compileGateAuthorityRecord(value: unknown): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value, null, 2);
	} catch {
		throw new GateSetupError(GATE_AUTHORITY_PERSISTENCE_ERROR);
	}
	if (Buffer.byteLength(serialized, "utf8") > GATE_AUTHORITY_RECORD_MAX_BYTES) {
		throw new GateSetupError(GATE_AUTHORITY_PERSISTENCE_ERROR);
	}
	return serialized;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= 500 && value.every((item) => typeof item === "string" && item.length <= 200);
}

function isBoundedStrings(value: unknown, maxItems: number, maxChars: number): value is string[] {
	return Array.isArray(value) && value.length <= maxItems
		&& value.every((item) => typeof item === "string" && item.length <= maxChars);
}

/** Deterministic sorted-set identity of a string array (order-insensitive, duplicate-insensitive). */
function sortedSetIdentity(values: readonly string[]): string {
	return [...new Set(values)].sort().join("\u0000");
}

/** profile is OPTIONAL like the binding: absent or a bounded string — never null. */
function isOptionalProfile(value: unknown): value is string | undefined {
	return value === undefined || (typeof value === "string" && value.length <= 200);
}

/**
 * Read the persisted gate run artifacts (gates.json + evidence.json) for a
 * gate run, STRICTLY FAIL CLOSED — any missing/malformed artifact, foreign
 * schema version, contradictory gates/evidence/manifest identity fact (run
 * id, requested set, profile/mode), or malformed/extra gate/check shape
 * returns null — the assessment then refuses reuse. Never throws.
 *
 * Strict reconstruction identity:
 *   - BOTH artifacts must carry the exact current GATE_SCHEMA_VERSION and
 *     the run id (a missing/foreign evidence schema version is never
 *     accepted as source evidence);
 *   - gates.json and evidence.json must agree on the requested set,
 *     profile (both absent when the project has none) and mode, and both
 *     must agree with the run manifest's own profile/mode identity;
 *   - the manifest must identify the run as a gate run of the same id;
 *   - every gate entry carries a bounded id and a well-formed
 *     prerequisite_status (status enum only) and its checks array; every
 *     evidence.json check key is a bounded id that EXACTLY equals its
 *     check_id AND the gate entries' check-id set — extra (foreign) or
 *     missing evidence checks are contradictory source evidence;
 *   - only type "manual" evidence entries are recovered (the source facts
 *     needed to reproduce the privacy-safe hash): the entry must name its
 *     own check and carry a bounded note, trimmed exactly like
 *     trimmedManualEvidence at capture time. Raw notes are hashed by the
 *     caller and never rendered.
 */
export function validatePersistedGateRunRecords(
	runId: string,
	manifest: RunRecord,
	gatesValue: unknown,
	evidenceValue: unknown,
): PersistedGateRunFacts | null {
	try {
		const gatesRaw = gatesValue;
		const evidenceRaw = evidenceValue;
		if (!isRecord(gatesRaw) || !isRecord(evidenceRaw)) return null;
		if (gatesRaw.schema_version !== GATE_SCHEMA_VERSION || gatesRaw.run_id !== runId) return null;
		// Strict evidence schema identity: a missing or foreign
		// schema_version on the evidence artifact is never accepted.
		if (evidenceRaw.schema_version !== GATE_SCHEMA_VERSION || evidenceRaw.run_id !== runId) return null;
		if (!isStringArray(gatesRaw.requested) || !isStringArray(evidenceRaw.requested)) return null;
		if (gatesRaw.requested.length === 0 || new Set(gatesRaw.requested).size !== gatesRaw.requested.length) return null;
		if (evidenceRaw.requested.length === 0 || new Set(evidenceRaw.requested).size !== evidenceRaw.requested.length) return null;
		// Contradictory requested sets between the two persisted artifacts
		// cannot be faithfully reconstructed.
		if (sortedSetIdentity(gatesRaw.requested) !== sortedSetIdentity(evidenceRaw.requested)) return null;
		// Profile/mode identity must agree across the manifest and BOTH
		// artifacts (profile is optional — absent on every side when the
		// project has none; mode is always present).
		if (!isOptionalProfile(gatesRaw.profile) || !isOptionalProfile(evidenceRaw.profile)) return null;
		if ((gatesRaw.profile ?? undefined) !== (evidenceRaw.profile ?? undefined)) return null;
		if (manifest.profile !== (gatesRaw.profile ?? undefined)) return null;
		if (typeof gatesRaw.mode !== "string" || gatesRaw.mode.length === 0 || gatesRaw.mode.length > 200
			|| typeof evidenceRaw.mode !== "string" || evidenceRaw.mode.length === 0 || evidenceRaw.mode.length > 200) return null;
		if (gatesRaw.mode !== evidenceRaw.mode || manifest.mode !== gatesRaw.mode) return null;
		const persistedCandidateBindings = [manifest.candidate_binding, gatesRaw.candidate_binding, evidenceRaw.candidate_binding];
		const candidateBindingAbsent = persistedCandidateBindings.every((binding) => binding === undefined);
		let candidateBinding: GateCandidateBindingV1 | undefined;
		if (!candidateBindingAbsent) {
			const parsedBindings = persistedCandidateBindings.map((binding) => parseGateCandidateBindingV1(binding));
			if (parsedBindings.some((binding) => binding === null)) return null;
			candidateBinding = parsedBindings[0]!;
			if (!parsedBindings.every((binding) => isDeepStrictEqual(binding, candidateBinding))) return null;
			if (manifest.mode !== "VERIFY") return null;
		}
		// Manifest identity: the run must be a gate run of the same id.
		if (manifest.recipe !== "gate" || manifest.run_id !== runId) return null;
		if (!Array.isArray(gatesRaw.gates) || gatesRaw.gates.length === 0 || gatesRaw.gates.length > 500) return null;

		const gates: PersistedGateRunFacts["gates"] = [];
		const gateIds = new Set<string>();
		const knownCheckIds = new Set<string>();
		const checkRecords = new Map<string, Record<string, unknown>>();
		const authoritativeGates: GateRunEntry[] = [];
		const priorGateFacts = new Map<string, { status: GateStatus; blocking: boolean }>();
		for (const rawGate of gatesRaw.gates) {
			if (!isRecord(rawGate) || typeof rawGate.id !== "string" || rawGate.id.length === 0 || rawGate.id.length > 200) return null;
			if (gateIds.has(rawGate.id)) return null;
			gateIds.add(rawGate.id);
			if (typeof rawGate.title !== "string" || typeof rawGate.description !== "string"
				|| typeof rawGate.status !== "string" || !GATE_STATUSES.includes(rawGate.status as GateStatus)
				|| typeof rawGate.required !== "boolean" || typeof rawGate.blocking !== "boolean"
				|| !isStringArray(rawGate.prerequisites)
				|| !(rawGate.failure_reason === null || typeof rawGate.failure_reason === "string")
				|| !(rawGate.blocked_reason === null || typeof rawGate.blocked_reason === "string")
				|| !isBoundedStrings(rawGate.warnings, 500, 4_096)
				|| !isBoundedStrings(rawGate.evidence_paths, 10_000, 4_096)
				|| !isBoundedStrings(rawGate.declared_evidence, 500, 4_096)
				|| typeof rawGate.started_at !== "string" || !Number.isFinite(Date.parse(rawGate.started_at))
				|| typeof rawGate.finished_at !== "string" || !Number.isFinite(Date.parse(rawGate.finished_at))
				|| typeof rawGate.duration_ms !== "number" || !Number.isSafeInteger(rawGate.duration_ms) || rawGate.duration_ms < 0
			) return null;
			if (rawGate.duration_ms !== Math.max(0, Date.parse(rawGate.finished_at) - Date.parse(rawGate.started_at))) return null;
			const prerequisiteIds = rawGate.prerequisites as string[];
			if (new Set(prerequisiteIds).size !== prerequisiteIds.length || prerequisiteIds.some((id) =>
				typeof id !== "string" || id.length === 0 || id.length > 200 || id === rawGate.id)) return null;
			const prerequisiteStatus: Record<string, GateStatus> = {};
			const rawPrereq = rawGate.prerequisite_status;
			if (!isRecord(rawPrereq)) return null;
			const expectedPrerequisiteIds: string[] = [];
			let firstBlockingPrerequisite: { id: string; status: GateStatus } | undefined;
			for (const prerequisiteId of prerequisiteIds) {
				const prior = priorGateFacts.get(prerequisiteId);
				if (prior === undefined) return null;
				expectedPrerequisiteIds.push(prerequisiteId);
				if (prior.status !== "PASS" && prior.blocking) {
					firstBlockingPrerequisite = { id: prerequisiteId, status: prior.status };
					break;
				}
			}
			const persistedPrerequisiteIds = Object.keys(rawPrereq);
			if (persistedPrerequisiteIds.length !== expectedPrerequisiteIds.length ||
				persistedPrerequisiteIds.some((id, index) => id !== expectedPrerequisiteIds[index])) return null;
			if (rawPrereq !== undefined && rawPrereq !== null) {
				for (const [prereqId, facts] of Object.entries(rawPrereq)) {
					if (!isRecord(facts)) return null;
					const status = facts.status;
					if (typeof status !== "string" || !GATE_STATUSES.includes(status as GateStatus)) return null;
					const prior = priorGateFacts.get(prereqId);
					if (facts.source !== "this-run" || prior === undefined || prior.status !== status) return null;
					prerequisiteStatus[prereqId] = status as GateStatus;
				}
			}
			// Gate/check shapes: every gate entry carries its checks array;
			// each check must be a record with a bounded non-empty id.
			const rawChecks = rawGate.checks;
			if (!Array.isArray(rawChecks) || rawChecks.length > 500) return null;
			const parsedChecks: CheckRunEntry[] = [];
			for (const rawCheck of rawChecks) {
				if (!isRecord(rawCheck)) return null;
				const checkId = rawCheck.check_id;
				if (typeof checkId !== "string" || checkId.length === 0 || checkId.length > 200) return null;
				if (rawCheck.gate_id !== rawGate.id
					|| typeof rawCheck.status !== "string" || !GATE_STATUSES.includes(rawCheck.status as GateStatus)
					|| typeof rawCheck.kind !== "string" || rawCheck.kind.length === 0 || rawCheck.kind.length > 200
					|| typeof rawCheck.required !== "boolean" || typeof rawCheck.blocking !== "boolean"
					|| !Array.isArray(rawCheck.evidence)
					|| !(rawCheck.failure_reason === null || typeof rawCheck.failure_reason === "string")
					|| !(rawCheck.blocked_reason === null || typeof rawCheck.blocked_reason === "string")
					|| !isBoundedStrings(rawCheck.warnings, 500, 4_096)
					|| typeof rawCheck.started_at !== "string" || !Number.isFinite(Date.parse(rawCheck.started_at))
					|| typeof rawCheck.finished_at !== "string" || !Number.isFinite(Date.parse(rawCheck.finished_at))
					|| typeof rawCheck.duration_ms !== "number" || !Number.isSafeInteger(rawCheck.duration_ms) || rawCheck.duration_ms < 0
				) return null;
				if (rawCheck.duration_ms !== Math.max(0, Date.parse(rawCheck.finished_at) - Date.parse(rawCheck.started_at))) return null;
				if (rawCheck.status === "PASS" && (rawCheck.failure_reason !== null || rawCheck.blocked_reason !== null)) return null;
				if (rawCheck.status === "FAIL" && (typeof rawCheck.failure_reason !== "string" || rawCheck.failure_reason.length === 0)) return null;
				if (rawCheck.status === "BLOCKED" && (typeof rawCheck.blocked_reason !== "string" || rawCheck.blocked_reason.length === 0)) return null;
				knownCheckIds.add(checkId);
				checkRecords.set(checkId, rawCheck);
				parsedChecks.push(rawCheck as unknown as CheckRunEntry);
			}
			const blockedByPrerequisite = rawChecks.length === 0 && rawGate.status === "BLOCKED";
			if (blockedByPrerequisite) {
				if (firstBlockingPrerequisite === undefined || rawGate.failure_reason !== null ||
					rawGate.blocked_reason !== `prerequisite ${firstBlockingPrerequisite.id} is ${firstBlockingPrerequisite.status} (this-run)`) return null;
			} else {
				if (firstBlockingPrerequisite !== undefined) return null;
				const derived = gateStatusFromChecks(parsedChecks);
				if (rawGate.status !== derived.status || rawGate.failure_reason !== derived.failure_reason || rawGate.blocked_reason !== derived.blocked_reason) return null;
			}
			authoritativeGates.push(rawGate as unknown as GateRunEntry);
			gates.push({ id: rawGate.id, prerequisiteStatus });
			priorGateFacts.set(rawGate.id, { status: rawGate.status as GateStatus, blocking: rawGate.blocking });
		}
		if (gatesRaw.requested.some((id) => !gateIds.has(id))) return null;

		// Evidence check shapes: the checks map must be a record whose keys
		// EXACTLY equal the gate entries' check-id set — extra (foreign) or
		// missing checks are contradictory source evidence, never accepted.
		const checks = isRecord(evidenceRaw.checks) ? evidenceRaw.checks : null;
		if (!checks) return null;
		if (Object.keys(checks).length !== knownCheckIds.size) return null;
		// Recover ONLY the manual evidence needed to reproduce the
		// privacy-safe hash: type "manual" evidence entries only, notes
		// trimmed exactly like trimmedManualEvidence at capture time. Raw
		// notes are hashed by the caller and never rendered.
		const manualEvidence: Record<string, string> = {};
		const artifactSources: PersistedGateRunFacts["artifactSources"] = [];
		for (const [key, rawCheck] of Object.entries(checks)) {
			if (!isRecord(rawCheck)) return null;
			const checkId = rawCheck.check_id;
			if (typeof checkId !== "string" || checkId.length === 0 || checkId.length > 200 || checkId !== key) return null;
			if (!knownCheckIds.has(checkId)) return null;
			if (!isDeepStrictEqual(rawCheck, checkRecords.get(checkId))) return null;
			const evidence = rawCheck.evidence;
			if (!Array.isArray(evidence)) return null;
			for (const entry of evidence) {
				if (!isRecord(entry)) return null;
				if (typeof entry.type !== "string") return null;
				// A manual entry must name its own check — a contradictory
				// check_id is malformed source evidence.
				if (entry.type === "manual") {
					if (entry.check_id !== checkId) return null;
					if (entry.provided_by !== "user-command") return null;
					if (typeof entry.detail !== "string" || entry.detail.length > MAX_MANUAL_NOTE_CHARS) return null;
					const note = entry.detail.trim();
					if (note.length > 0) manualEvidence[checkId] = note;
				} else if (entry.type === "artifact") {
					if (entry.check_id !== undefined && entry.check_id !== checkId) return null;
					if (typeof entry.recipe !== "string" || entry.recipe.length === 0 || entry.recipe.length > 200) return null;
					if (typeof entry.run_id !== "string" || entry.run_id.length === 0 || entry.run_id.length > 200) return null;
					const completeAuthority = typeof entry.authority_digest === "string" && /^[0-9a-f]{64}$/.test(entry.authority_digest)
						&& (entry.authority_freshness === "current" || entry.authority_freshness === "immutable-snapshot");
					// A failed artifact check may truthfully retain only diagnostic
					// source identity.  PASS is authority-bearing and therefore must
					// carry the complete digest/freshness edge.
					if (!completeAuthority && rawCheck.status === "PASS") return null;
					if (completeAuthority) {
						artifactSources.push({
							checkId,
							recipe: entry.recipe,
							runId: entry.run_id,
							authorityDigest: entry.authority_digest as string,
							freshness: entry.authority_freshness as "current" | "immutable-snapshot",
						});
					}
				} else if (entry.check_id !== undefined && entry.check_id !== checkId) {
					return null;
				}
			}
		}
		let overall: GateStatus = "PASS";
		const requested = new Set(gatesRaw.requested);
		for (const gate of authoritativeGates) {
			if (requested.has(gate.id) || gate.required) overall = worstStatus(overall, gate.status);
		}
		const successful = overall === "PASS";
		if (successful !== (manifest.run_outcome === "SUCCESS")) return null;
		if (successful !== (manifest.exit_code !== null && manifest.expected_exit_codes.includes(manifest.exit_code))) return null;
		return { requested: gatesRaw.requested, gates, manualEvidence, artifactSources, candidateBinding };
	} catch {
		return null;
	}
}

export async function readPersistedGateRunFacts(
	projectRoot: string,
	runId: string,
	manifest: RunRecord,
	hooks?: { gates?: BoundedFileIoHooks; evidence?: BoundedFileIoHooks },
): Promise<PersistedGateRunFacts | null> {
	const dir = join(runsDir(projectRoot), runId);
	try {
		const gatesRead = await readJsonFileBounded(join(dir, "gates.json"), GATE_AUTHORITY_RECORD_MAX_BYTES, hooks?.gates);
		if (!gatesRead.ok) return null;
		const evidenceRead = await readJsonFileBounded(join(dir, "evidence.json"), GATE_AUTHORITY_RECORD_MAX_BYTES, hooks?.evidence);
		if (!evidenceRead.ok) return null;
		return validatePersistedGateRunRecords(runId, manifest, gatesRead.value.value, evidenceRead.value.value);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Latest persisted gate status (history and presentation compatibility)
// ---------------------------------------------------------------------------

interface PersistedGateStatusRecord {
	gates: Array<{ id: string; status: GateStatus }>;
}

async function readGatesFile(
	projectRoot: string,
	runId: string,
	hooks?: BoundedFileIoHooks,
	indexedStartedAt?: string,
): Promise<PersistedGateStatusRecord | null> {
	const manifest = await readCommittedManifest(projectRoot, runId);
	if (!manifest || manifest.recipe !== "gate") return null;
	if (indexedStartedAt !== undefined && manifest.started_at !== indexedStartedAt) return null;
	if (!await readPersistedGateRunFacts(projectRoot, runId, manifest, { gates: hooks })) return null;
	try {
		const read = await readJsonFileBounded(join(runsDir(projectRoot), runId, "gates.json"), GATE_AUTHORITY_RECORD_MAX_BYTES, hooks);
		if (!read.ok || !isRecord(read.value.value)) return null;
		const parsed = read.value.value;
		if (parsed.schema_version !== GATE_SCHEMA_VERSION || parsed.run_id !== runId || !Array.isArray(parsed.gates)) return null;
		const gates: PersistedGateStatusRecord["gates"] = [];
		for (const candidate of parsed.gates) {
			if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.length === 0 || candidate.id.length > 200) return null;
			if (typeof candidate.status !== "string" || !GATE_STATUSES.includes(candidate.status as GateStatus)) return null;
			gates.push({ id: candidate.id, status: candidate.status as GateStatus });
		}
		if (!await readCommittedManifest(projectRoot, runId)) return null;
		return { gates };
	} catch {
		return null;
	}
}

/** Most recent persisted status of a gate, if any. */
export async function latestGateStatus(projectRoot: string, gateId: string, hooks?: BoundedFileIoHooks): Promise<{ status: GateStatus; run_id: string } | null> {
	for await (const candidate of iterateGateRunCandidates(projectRoot)) {
		if (candidate.source === "marker-invalid") return null;
		const record = await readGatesFile(
			projectRoot,
			candidate.run_id,
			hooks,
			candidate.source === "marker" ? candidate.started_at : undefined,
		);
		// A newer gate run that advertises itself through a readable manifest
		// but is partial/corrupt must not make us fall back to older optimism.
		if (!record) return null;
		const gate = record.gates.find((g) => g.id === gateId);
		if (gate) return { status: gate.status, run_id: candidate.run_id };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Check evaluation
// ---------------------------------------------------------------------------

export interface CheckContext {
	projectRoot: string;
	/**
	 * P8: safe effective project root (project.yaml project_dir; repo root by
	 * default). File-type content checks — kind=file (unless the check carries
	 * the internal catalog-only `file_root: "repository"` metadata) and the
	 * files read by json/numeric/schema checks — resolve against this root
	 * with realpath containment; everything else (the b0.4 repository-root
	 * workbench-config check, recipe/artifact checks, git, run persistence)
	 * stays repository-root based on `projectRoot`.
	 */
	effectiveProjectRoot: string;
	runDir: string;
	configIssues: ConfigIssue[];
	/** Recipes from the same project-config load used by gate selection. */
	recipes: readonly Recipe[];
	/** Raw project gate declarations from the same trusted config snapshot. */
	projectGates: readonly unknown[];
	profile: string | undefined;
	mode: WorkbenchMode;
	exec: ExecFn;
	signal?: AbortSignal;
	now: () => Date;
	manualEvidence: Record<string, string>;
	manualEvidenceProvenance: "user-command" | "model-tool";
	/** P7: injected worker-first compliance facts (undefined => NOT_RUN checks). */
	workerFirstFacts?: WorkerFirstGateFacts;
	/** P7: actor facts for the shared recipe mutation decision in recipe checks. */
	actorFacts?: RecipeMutationFacts;
	artifactExternalRoots: Readonly<Record<string, string>>;
	/** Test-only allocation observation; cannot raise the fixed JSON artifact cap. */
	jsonFileReadHooks?: BoundedFileIoHooks;
	log: (line: string) => void;
}

async function assertPathContained(projectRoot: string, target: string, label: string): Promise<string> {
	const real = await realpathContained(projectRoot, target);
	if (real === undefined) {
		throw new GateSetupError(`${label} path escapes the project root: ${target}`);
	}
	return real;
}

/**
 * The base root a kind=file check resolves against: the effective project
 * root by default; the repository root only when the check carries the
 * INTERNAL catalog-only `file_root: "repository"` metadata. Only the
 * built-in b0.4 workbench-config check sets it — .pi/workbench always
 * lives at the repository root, so a nested `.pi/workbench` can never
 * impersonate the repository configuration. gates.yaml cannot set
 * file_root: parseCheck rejects both `root` and `file_root` as unknown
 * fields.
 */
export function fileCheckRoot(ctx: CheckContext, check: GateCheck): string {
	return check.file_root === "repository" ? ctx.projectRoot : ctx.effectiveProjectRoot;
}

/** Copy an evidence source into runDir/artifacts/ and return the relative path. */
async function copyEvidenceFile(projectRoot: string, runDir: string, checkId: string, absolutePath: string): Promise<string> {
	const rel = relative(projectRoot, absolutePath);
	const safe = checkId.replace(/[^A-Za-z0-9._-]/g, "-");
	const name = `${safe}-${basename(rel)}`;
	const target = join(runDir, "artifacts", name);
	try {
		await copyFile(absolutePath, target);
	} catch {
		return `artifacts/${name}`; // unreadable source; record the intended path
	}
	return `artifacts/${name}`;
}

async function copyRecipeSummary(runDir: string, checkId: string, recipeRunId: string, recipeRunDir: string): Promise<string> {
	const safe = checkId.replace(/[^A-Za-z0-9._-]/g, "-");
	const target = join(runDir, "artifacts", `${safe}-recipe-${recipeRunId}.summary.json`);
	try {
		await copyFile(join(recipeRunDir, "summary.json"), target);
		return `artifacts/${basename(target)}`;
	} catch {
		return "";
	}
}

class JsonArtifactError extends Error {
	constructor(message: string, readonly missing: boolean) {
		super(message);
	}
}

async function resolveJsonFile(ctx: CheckContext, file: string, label: string): Promise<{ path: string; value: unknown }> {
	const absolute = await assertPathContained(ctx.effectiveProjectRoot, file, label);
	const read = await readJsonFileBounded(absolute, GATE_JSON_ARTIFACT_MAX_BYTES, ctx.jsonFileReadHooks);
	if (!read.ok) {
		switch (read.error.code) {
			case "io_error": throw new JsonArtifactError("missing", true);
			case "source_oversized": throw new JsonArtifactError("source_oversized (maximum 1048576 bytes)", false);
			case "source_not_regular": throw new JsonArtifactError("source_not_regular", false);
			case "invalid_json":
			case "invalid_utf8": throw new JsonArtifactError("invalid JSON", false);
			default: throw new JsonArtifactError("bounded read failed", false);
		}
	}
	return { path: absolute, value: read.value.value };
}

/** Dot-path resolution; arrays support `.length`. */
export function resolveJsonPath(value: unknown, path: string): { found: boolean; value?: unknown } {
	const segments = path.split(".").filter((s) => s.length > 0);
	let cur: unknown = value;
	for (const segment of segments) {
		if (cur === null || cur === undefined) return { found: false };
		if (segment === "length" && Array.isArray(cur)) {
			cur = cur.length;
			continue;
		}
		if (typeof cur !== "object") return { found: false };
		cur = (cur as Record<string, unknown>)[segment];
	}
	return { found: cur !== undefined, value: cur };
}

interface EvaluatedCheck {
	entry: CheckRunEntry;
	artifactPaths: string[];
}

// ---------------------------------------------------------------------------
// P7 worker-first compliance assertions (machine-backed, injected facts only)
// ---------------------------------------------------------------------------

/**
 * Evaluate one worker-first assertion against the injected facts. The
 * runtime constructed the facts from actor/policy/lease/delegation/review
 * state — model prose and manual evidence can never influence them.
 *   - PASS      — the compliance condition holds (vacuous PASS for "no
 *                 delegation" review checks: nothing to review)
 *   - FAIL      — a negative compliance fact
 *   - NOT_RUN   — the required fact is missing (required NOT_RUN can never
 *                 make the gate PASS)
 * A facts-level `blockedReason` is handled by the caller BEFORE this
 * function (every worker-first check then evaluates BLOCKED).
 */
export function evaluateWorkerFirstAssertion(
	name: WorkerFirstCheckName,
	facts: WorkerFirstGateFacts,
): { status: "PASS" | "FAIL" | "NOT_RUN"; detail: string } {
	switch (name) {
		case "strict-policy-active": {
			if (facts.writePolicy === "worker-first-strict") return { status: "PASS", detail: "development-first direct-write policy is active (legacy compatibility id worker-first-strict)" };
			// The runtime always resolves the policy for the current actor
			// (worker-first-strict for approved Sol, null otherwise) — null is
			// a negative compliance fact, not a missing one.
			return { status: "FAIL", detail: `worker-first-strict policy is not active for this actor (got ${facts.writePolicy ?? "not applicable"})` };
		}
		case "no-unauthorized-commander-writes": {
			if (facts.commanderWritesDenied === true) {
				return { status: "PASS", detail: "high-risk commander writes require an explicit lease; ordinary project writes remain direct" };
			}
			if (facts.blockedCommanderWriteAttempts !== null && facts.blockedCommanderWriteAttempts === 0) {
				return { status: "PASS", detail: "zero unauthorized commander write attempts" };
			}
			if (facts.blockedCommanderWriteAttempts !== null && facts.blockedCommanderWriteAttempts > 0) {
				return { status: "FAIL", detail: `${facts.blockedCommanderWriteAttempts} unauthorized commander write attempt(s) while the hard denial was inactive` };
			}
			return { status: "NOT_RUN", detail: "no hard-denial / blocked-write fact injected" };
		}
		case "no-pending-review": {
			if (facts.hasDelegation === false) return { status: "PASS", detail: "no delegation — nothing pending" };
			if (facts.reviewStatus === null) return { status: "NOT_RUN", detail: "no review-status fact injected" };
			if (facts.reviewStatus === "PENDING_REVIEW") {
				return { status: "FAIL", detail: `delegation ${facts.latestDelegationId ?? "?"} is PENDING_REVIEW — review the worker diff first` };
			}
			return { status: "PASS", detail: `latest delegation ${facts.latestDelegationId ?? "?"} is ${facts.reviewStatus}` };
		}
		case "no-stale-review": {
			if (facts.hasDelegation === false) return { status: "PASS", detail: "no delegation — nothing stale" };
			if (facts.reviewStatus === null) return { status: "NOT_RUN", detail: "no review-status fact injected" };
			if (facts.reviewStatus === "STALE") {
				return { status: "FAIL", detail: `delegation ${facts.latestDelegationId ?? "?"} is STALE — the diff changed since the review` };
			}
			return { status: "PASS", detail: `latest delegation ${facts.latestDelegationId ?? "?"} is ${facts.reviewStatus}` };
		}
		case "reviewed-hash-matches-current": {
			if (facts.hasDelegation === false) return { status: "PASS", detail: "no delegation — nothing reviewed yet" };
			if (facts.reviewStatus === "PENDING_REVIEW") {
				return { status: "NOT_RUN", detail: "no reviewed hash yet — the delegation is PENDING_REVIEW" };
			}
			if (facts.reviewedDiffHash === null || facts.currentDiffHash === null) {
				return { status: "NOT_RUN", detail: "reviewed/current diff-hash facts not injected" };
			}
			if (facts.reviewedDiffHash === facts.currentDiffHash) {
				return { status: "PASS", detail: `reviewed hash ${facts.reviewedDiffHash.slice(0, 12)}… equals the current diff hash` };
			}
			return { status: "FAIL", detail: `reviewed hash ${facts.reviewedDiffHash.slice(0, 12)}… differs from the current diff hash ${facts.currentDiffHash.slice(0, 12)}…` };
		}
		case "worker-paths-within-contracts": {
			if (facts.hasDelegation === false) return { status: "PASS", detail: "no delegation — no worker paths to check" };
			if (facts.reviewVerdict === null && facts.reviewViolationCount === null) {
				return { status: "NOT_RUN", detail: "no completed review facts injected" };
			}
			const violations = facts.reviewViolationCount ?? 0;
			if (facts.reviewVerdict === "PASS" && violations === 0) {
				return { status: "PASS", detail: `latest review PASS — every worker path is within the approved contracts` };
			}
			return { status: "FAIL", detail: `${violations} worker path(s) outside the approved contracts (latest review ${facts.reviewVerdict ?? "FAIL"})` };
		}
		case "no-active-unexplained-lease": {
			if (facts.leaseStatus === null) return { status: "NOT_RUN", detail: "no lease-status fact injected" };
			if (facts.leaseStatus === "active") {
				if (facts.leaseReason !== null) {
					return { status: "PASS", detail: `active lease with audited fixed reason ${facts.leaseReason}` };
				}
				return { status: "FAIL", detail: "an active commander write lease has no audited fixed reason" };
			}
			return { status: "PASS", detail: `write lease is ${facts.leaseStatus}` };
		}
		case "commander-initiated-final-verification": {
			if (facts.gateRunInitiatedByCommander === null) return { status: "NOT_RUN", detail: "no gate-run initiator fact injected" };
			if (facts.gateRunInitiatedByCommander === true) {
				return { status: "PASS", detail: "this gate run was initiated by the approved GPT-5.6 Sol commander" };
			}
			return { status: "FAIL", detail: "this gate run was not initiated by the approved Sol commander — final verification is a commander-owned act" };
		}
	}
}

async function evaluateCheck(gateId: string, check: GateCheck, ctx: CheckContext): Promise<EvaluatedCheck> {
	const startedAt = ctx.now();
	const entry: CheckRunEntry = {
		check_id: check.id,
		gate_id: gateId,
		status: "NOT_RUN",
		kind: check.kind,
		required: check.required,
		blocking: check.blocking,
		evidence: [],
		failure_reason: null,
		blocked_reason: null,
		warnings: [],
		started_at: startedAt.toISOString(),
		finished_at: startedAt.toISOString(),
		duration_ms: 0,
	};
	const artifactPaths: string[] = [];
	const fail = (reason: string, evidence: EvidenceEntry[]): void => {
		entry.status = "FAIL";
		entry.failure_reason = reason;
		entry.evidence.push(...evidence);
	};
	const pass = (evidence: EvidenceEntry[]): void => {
		entry.status = "PASS";
		entry.evidence.push(...evidence);
	};

	const label = `gate "${gateId}" check "${check.id}"`;
	ctx.log(`    ${check.id} (${check.kind}) ...`);

	try {
		switch (check.kind) {
			case "config": {
				if (ctx.configIssues.length === 0) {
					pass([{ type: "config", source: ".pi/workbench", detail: "workbench config loads with 0 issues" }]);
				} else {
					const detail = ctx.configIssues.map((i) => `${i.file}: ${i.message}`).join("; ");
					fail(`workbench config has issues: ${detail}`, [{ type: "config", source: ".pi/workbench", detail }]);
				}
				break;
			}

			case "recipe": {
				const candidates = check.recipe ? [check.recipe] : (check.recipes ?? []);
				const declared = ctx.recipes.find((recipe) => candidates.includes(recipe.name));
				if (!declared) {
					fail(`no declared recipe among: ${candidates.join(", ")}`, [
						{ type: "config", source: ".pi/workbench/recipes.yaml", detail: `none of ${candidates.join(", ")} is declared` },
					]);
					break;
				}
				if (!declared.allowed_modes.includes(ctx.mode)) {
					entry.status = "BLOCKED";
					entry.blocked_reason = `recipe "${declared.name}" is not allowed in ${ctx.mode} mode`;
					break;
				}
				// P7: gate-engine recipe checks apply the SAME shared mutation
				// decision as direct recipe execution — strict Sol is denied
				// mutation: source, workers run only mutation: none, other
				// controllers keep prior behavior. A policy denial BLOCKs the
				// check (it can never run), and runRecipe re-enforces it below.
				const mutationBlock = recipeMutationBlockReason(ctx.actorFacts, declared.name, declared.mutation);
				if (mutationBlock) {
					entry.status = "BLOCKED";
					entry.blocked_reason = mutationBlock;
					break;
				}
				const result = await runRecipe({
					projectRoot: ctx.projectRoot,
					recipeName: declared.name,
					params: {},
					mode: ctx.mode,
					exec: ctx.exec,
					signal: ctx.signal,
					now: ctx.now,
					actorFacts: ctx.actorFacts,
				});
				if (!result.ok && result.error) {
					fail(`recipe "${declared.name}" could not run: ${result.error}`, [
						{ type: "recipe_run", recipe: declared.name, detail: result.error },
					]);
					break;
				}
				const summary = result.summary;
				const ok = result.ok === true;
				const evidence: EvidenceEntry[] = [
					{
						type: "recipe_run",
						run_id: result.record?.run_id,
						recipe: declared.name,
						exit_code: result.record?.exit_code ?? null,
						execution_source: result.record?.execution_source ?? "exec",
						detail: ok ? `recipe "${declared.name}" exited ${result.record?.exit_code} as expected` : `recipe "${declared.name}" failed (exit ${result.record?.exit_code ?? "killed"}, timed_out=${result.record?.timed_out})`,
					},
				];
				if (result.runDir) {
					const copied = await copyRecipeSummary(ctx.runDir, check.id, result.record?.run_id ?? "", result.runDir);
					if (copied) {
						artifactPaths.push(copied);
						evidence[0]!.artifact_path = copied;
					}
				}
				if (summary && summary.stderr.trim().length > 0) {
					entry.warnings.push(`recipe "${declared.name}" wrote to stderr`);
				}
				if (ok) pass(evidence);
				else fail(evidence[0]!.detail, evidence);
				break;
			}

			case "artifact": {
				const recipeName = check.artifact_recipe as string;
				// Select from diagnostic manifests first. The newest same-recipe
				// attempt owns the decision even when its transaction is partial or
				// corrupt; strict verification below then fails it closed instead of
				// silently falling back to an older success.
				const attempt = await latestRunAttemptForRecipe(ctx.projectRoot, recipeName);
				if (attempt.state === "NOT_FOUND") {
					fail(`no run of recipe "${recipeName}" found`, [
						{ type: "config", source: ".pi/workbench/recipes.yaml", detail: `no persisted run of "${recipeName}"` },
					]);
					break;
				}
				if (attempt.state === "CORRUPT") {
					fail(`run ${attempt.run_id} of "${recipeName}" failed diagnostic identity verification`, [
						{ type: "artifact", run_id: attempt.run_id, recipe: recipeName, detail: attempt.reason },
					]);
					break;
				}
				const run = attempt.manifest;
				const strictRun = await readCommittedManifest(ctx.projectRoot, run.run_id);
				if (!strictRun) {
					fail(`run ${run.run_id} of "${recipeName}" failed committed identity verification`, [
						{ type: "artifact", run_id: run.run_id, recipe: recipeName, paths: run.artifact_paths, detail: "run transaction identity failed" },
					]);
					break;
				}
				if (strictRun.run_outcome !== "SUCCESS" || strictRun.exit_code === null || !strictRun.expected_exit_codes.includes(strictRun.exit_code) || strictRun.timed_out || strictRun.cancelled) {
					fail(`latest run ${strictRun.run_id} of "${recipeName}" is not a successful committed run`, [
						{ type: "artifact", run_id: strictRun.run_id, recipe: recipeName, paths: strictRun.artifact_paths, detail: `run outcome ${strictRun.run_outcome ?? "legacy"}` },
					]);
					break;
				}
				// A committed artifact transaction is necessary but not sufficient:
				// the producer must carry a complete successful Sol-owned validation
				// binding. Current artifacts additionally require that binding to match
				// today's commit/diff/config/dependency/recipe state; immutable
				// snapshots intentionally retain their copied-content semantics.
				const authorityDigest = validationEvidenceIdentity(strictRun.validation_evidence);
				if (
					strictRun.recipe !== recipeName
					|| !authorityDigest
					|| !validationEvidenceSourceEligible(strictRun.validation_evidence, { recipe: recipeName, argvHash: strictRun.argv_hash })
				) {
					fail(`run ${strictRun.run_id} of "${recipeName}" has no usable validation authority`, [
						{ type: "artifact", run_id: strictRun.run_id, recipe: recipeName, paths: strictRun.artifact_paths, detail: "validation binding is missing, malformed, incomplete, unsuccessful, or not Sol-owned" },
					]);
					break;
				}
				const currentArtifacts = await validateCommittedArtifactsV2(ctx.projectRoot, join(runsDir(ctx.projectRoot), run.run_id), run.run_id, { authorizedExternalRoots: ctx.artifactExternalRoots, exec: ctx.exec });
				if (!currentArtifacts.ok) {
					fail(`run ${run.run_id} of "${recipeName}" has invalid artifact authority (${currentArtifacts.code})`, [
						{ type: "artifact", run_id: run.run_id, recipe: recipeName, paths: run.artifact_paths, detail: currentArtifacts.code },
					]);
					break;
				}
				const authorityArtifacts = currentArtifacts.manifest.artifacts.map((artifact) => ({
					artifact,
					path: artifact.root === "project" ? artifact.path : `external:${artifact.external_root}/${artifact.path}`,
				}));
				const matchedArtifacts = check.artifact_glob
					? authorityArtifacts.filter(({ path }) => matchesGlob(path, check.artifact_glob as string))
					: authorityArtifacts;
				if (matchedArtifacts.length === 0) {
					fail(`run ${run.run_id} of "${recipeName}" produced no matching artifacts${check.artifact_glob ? ` (glob: ${check.artifact_glob})` : ""}`, [
						{ type: "artifact", run_id: run.run_id, recipe: recipeName, paths: run.artifact_paths, detail: "no matching artifacts" },
					]);
					break;
				}
				const authorityFreshness = matchedArtifacts.some(({ artifact }) => artifact.freshness === "current")
					? "current"
					: "immutable-snapshot";
				if (authorityFreshness === "current") {
					const sourceRecipe = ctx.recipes.find((candidate) => candidate.name === recipeName);
					if (!sourceRecipe) {
						fail(`artifact source recipe "${recipeName}" is not currently declared`, [
							{ type: "artifact", run_id: strictRun.run_id, recipe: recipeName, paths: strictRun.artifact_paths, detail: "source recipe missing from current trusted config" },
						]);
						break;
					}
					const sourceAssessment = await assessRecipeSourceValidation({
						projectRoot: ctx.projectRoot,
						profile: ctx.profile,
						mode: ctx.mode,
						exec: ctx.exec,
						projectGates: ctx.projectGates,
						recipe: sourceRecipe,
						argvHash: strictRun.argv_hash,
						validationEvidence: strictRun.validation_evidence,
					});
					if (!sourceAssessment.reusable) {
						fail(`run ${strictRun.run_id} of "${recipeName}" is not current reusable authority`, [
							{
								type: "artifact",
								run_id: strictRun.run_id,
								recipe: recipeName,
								paths: strictRun.artifact_paths,
								detail: `source validation refused: ${sourceAssessment.reasons.join(",") || "unknown"}`,
							},
						]);
						break;
					}
				}
				const matched = matchedArtifacts.map(({ path }) => path);
				pass([
					{
						type: "artifact",
						run_id: run.run_id,
						recipe: recipeName,
						paths: matched,
						authority_digest: authorityDigest,
						authority_freshness: authorityFreshness,
						detail: `run ${run.run_id} artifacts: ${matched.join(", ")}`,
					},
				]);
				break;
			}

			case "file": {
				const patterns = check.any_of ?? (check.path ? [check.path] : []);
				const baseRoot = fileCheckRoot(ctx, check);
				const matched: string[] = [];
				const matchedAbsolute: string[] = [];
				for (const pattern of patterns) {
					if ((await realpathContained(baseRoot, pattern)) === undefined) {
						throw new GateSetupError(`${label}: file path escapes the project root: ${pattern}`);
					}
					for (const match of globSync(pattern, { cwd: baseRoot })) {
						const absolute = await realpathContained(baseRoot, match);
						if (absolute === undefined) continue;
						matched.push(match);
						matchedAbsolute.push(absolute);
					}
				}
				if (matched.length === 0) {
					fail(`no file matched: ${patterns.join(" | ")}`, [
						{ type: "file", source: patterns.join(" | "), detail: "no match" },
					]);
					break;
				}
				for (let i = 0; i < matched.length && i < 1; i++) {
					const copied = await copyEvidenceFile(ctx.projectRoot, ctx.runDir, check.id, matchedAbsolute[i]!);
					if (copied) {
						artifactPaths.push(copied);
					}
				}
				pass([{ type: "file", source: matched.join(", "), detail: "exists" }]);
				break;
			}

			case "json": {
				const file = check.json_file as string;
				let resolved: { path: string; value: unknown };
				try {
					resolved = await resolveJsonFile(ctx, file, label);
				} catch (error) {
					if (error instanceof GateSetupError) throw error;
					const missing = error instanceof JsonArtifactError && error.missing;
					fail(missing ? `artifact missing: ${file}` : `${file}: ${(error as Error).message}`, [
						{ type: "json", source: file, detail: missing ? "file not found" : (error as Error).message },
					]);
					break;
				}
				const copied = await copyEvidenceFile(ctx.projectRoot, ctx.runDir, check.id, resolved.path);
				if (copied) artifactPaths.push(copied);

				const paths = check.json_any_of_paths ?? (check.json_path ? [check.json_path] : []);
				let foundPath: string | undefined;
				for (const p of paths) {
					if (resolveJsonPath(resolved.value, p).found) {
						foundPath = p;
						break;
					}
				}
				if (!foundPath) {
					fail(`JSON field missing: ${file}#${paths.join(" | ")}`, [
						{ type: "json", source: file, detail: `field(s) not found: ${paths.join(" | ")}` },
					]);
					break;
				}
				if (check.json_equals !== undefined) {
					const resolvedValue = resolveJsonPath(resolved.value, foundPath).value;
					if (!isDeepStrictEqual(resolvedValue, check.json_equals)) {
						const actualFacts = jsonValueFacts(resolvedValue);
						const expectedFacts = jsonValueFacts(check.json_equals);
						fail(`JSON field ${file}#${foundPath} does not equal expected value (${expectedFacts})`, [
							{ type: "json", source: file, detail: `${foundPath} mismatch: actual(${actualFacts}), expected(${expectedFacts})` },
						]);
						break;
					}
				}
				pass([{ type: "json", source: file, detail: `${foundPath} present` }]);
				break;
			}

			case "numeric": {
				const file = check.json_file as string;
				let resolved: { path: string; value: unknown };
				try {
					resolved = await resolveJsonFile(ctx, file, label);
				} catch (error) {
					if (error instanceof GateSetupError) throw error;
					const missing = error instanceof JsonArtifactError && error.missing;
					fail(missing ? `artifact missing: ${file}` : `${file}: ${(error as Error).message}`, [
						{ type: "numeric", source: file, detail: missing ? "file not found" : (error as Error).message },
					]);
					break;
				}
				const copied = await copyEvidenceFile(ctx.projectRoot, ctx.runDir, check.id, resolved.path);
				if (copied) artifactPaths.push(copied);

				const path = check.json_path as string;
				const { found, value } = resolveJsonPath(resolved.value, path);
				const finite = typeof value === "number" && Number.isFinite(value);
				if (!found || !finite) {
					const valueFacts = found ? jsonValueFacts(value) : "value=missing";
					fail(`numeric field ${file}#${path} must be a finite number (${valueFacts})`, [
						{ type: "numeric", source: file, detail: `${path} is not a finite number (${valueFacts})` },
					]);
					break;
				}
				const num = value as number;
				if (check.numeric_min !== undefined && num < check.numeric_min) {
					fail(`numeric field ${file}#${path} = ${num} is below min ${check.numeric_min}`, [
						{ type: "numeric", source: file, detail: `${path} = ${num} < min ${check.numeric_min}` },
					]);
					break;
				}
				if (check.numeric_max !== undefined && num > check.numeric_max) {
					fail(`numeric field ${file}#${path} = ${num} is above max ${check.numeric_max}`, [
						{ type: "numeric", source: file, detail: `${path} = ${num} > max ${check.numeric_max}` },
					]);
					break;
				}
				pass([{ type: "numeric", source: file, detail: `${path} = ${num}${check.numeric_min !== undefined ? ` >= ${check.numeric_min}` : ""}${check.numeric_max !== undefined ? ` <= ${check.numeric_max}` : ""}` }]);
				break;
			}

			case "manual": {
				const note = ctx.manualEvidence[check.id];
				if (note === undefined || note.trim().length === 0 || ctx.manualEvidenceProvenance !== "user-command") {
					entry.status = "NOT_RUN";
					entry.failure_reason = null;
					ctx.log(
						ctx.manualEvidenceProvenance === "model-tool" && note !== undefined
							? `    ${check.id} NOT_RUN — model-tool notes cannot satisfy a human manual check`
							: `    ${check.id} NOT_RUN — manual evidence required (${check.manual_prompt ?? "see gates.yaml"})`,
					);
					break;
				}
				pass([
					{
						type: "manual",
						check_id: check.id,
						provided_by: "user-command",
						detail: note.trim(),
					},
				]);
				break;
			}

			case "worker-first": {
				const name = check.worker_first;
				if (!name || !WORKER_FIRST_CHECK_NAMES.includes(name as WorkerFirstCheckName)) {
					throw new GateSetupError(`${label}: kind=worker-first needs a valid "worker_first" assertion (one of ${WORKER_FIRST_CHECK_NAMES.join(", ")})`);
				}
				const facts = ctx.workerFirstFacts;
				if (!facts) {
					// Required facts were not injected: NOT_RUN — never PASS.
					entry.status = "NOT_RUN";
					entry.failure_reason = null;
					ctx.log(`    ${check.id} NOT_RUN — development-safety facts were not injected (legacy worker-first machine check)`);
					break;
				}
				if (facts.blockedReason) {
					// The runtime marks the evaluation blocked (e.g. a pending/stale
					// review blocks final verification): every worker-first check
					// is BLOCKED, never evaluated against partial facts.
					entry.status = "BLOCKED";
					entry.blocked_reason = facts.blockedReason;
					ctx.log(`    ${check.id} BLOCKED — ${facts.blockedReason}`);
					break;
				}
				const outcome = evaluateWorkerFirstAssertion(name, facts);
				const evidence: EvidenceEntry = { type: "worker_first", detail: outcome.detail };
				if (outcome.status === "PASS") pass([evidence]);
				else if (outcome.status === "FAIL") fail(outcome.detail, [evidence]);
				else {
					entry.status = "NOT_RUN";
					entry.failure_reason = outcome.detail;
					ctx.log(`    ${check.id} NOT_RUN — ${outcome.detail}`);
				}
				break;
			}

			case "schema": {
				const file = check.json_file as string;
				const schemaName = check.schema_name ?? "quant-result";
				const QUANT_CONTRACT_SCHEMAS: readonly string[] = ["data-snapshot", "feature-set", "backtest-result"];
				if (schemaName !== "quant-result" && schemaName !== "quant-research" && !QUANT_CONTRACT_SCHEMAS.includes(schemaName)) {
					throw new GateSetupError(`${label}: unknown built-in schema "${schemaName}" (supported: quant-result, quant-research, ${QUANT_CONTRACT_SCHEMAS.join(", ")})`);
				}
				let resolved: { path: string; value: unknown };
				try {
					resolved = await resolveJsonFile(ctx, file, label);
				} catch (error) {
					if (error instanceof GateSetupError) throw error;
					const missing = error instanceof JsonArtifactError && error.missing;
					fail(missing ? `artifact missing: ${file}` : `${file}: ${(error as Error).message}`, [
						{ type: "schema", source: file, detail: missing ? "file not found" : (error as Error).message },
					]);
					break;
				}
				const copied = await copyEvidenceFile(ctx.projectRoot, ctx.runDir, check.id, resolved.path);
				if (copied) artifactPaths.push(copied);

				// P6-D: the three quant cache contracts validate as built-in
				// schemas. For them the evidence records the validation status
				// (validated/unresolved/invalid), cache eligibility and the
				// manifest warnings verbatim — a cache hit never bypasses these
				// gates, and "validated" is never claimed for manifests that only
				// parse (missing adjustment/corporate-action/delisting semantics
				// or per-profile requirements stay unresolved).
				const isQuantContract = QUANT_CONTRACT_SCHEMAS.includes(schemaName);
				const result = isQuantContract
					? validateQuantContract(resolved.value, { profile: ctx.profile })
					: schemaName === "quant-research"
						? validateQuantResearchEvidence(resolved.value, { profile: ctx.profile })
						: validateQuantResult(resolved.value, { profile: ctx.profile });
				const evidence: EvidenceEntry = isQuantContract
					? (() => {
							const q = result as ReturnType<typeof validateQuantContract>;
							return {
								type: "schema",
								source: file,
								detail: q.validationStatus === "validated"
									? `conforms to ${schemaName}.schema (${q.validationStatus}${q.cacheEligible ? ", cache-eligible" : ""})`
									: `not ${schemaName}.schema validated: ${q.errors.slice(0, 3).join("; ") || q.warnings.filter((w) => w.includes("validated") || w.includes("semantics")).slice(0, 3).join("; ") || q.validationStatus}`,
								errors: q.errors,
								warnings: q.warnings,
							};
						})()
					: (() => {
							const q = result as ReturnType<typeof validateQuantResult>;
							const entry: EvidenceEntry = {
								type: "schema",
								source: file,
								detail: q.valid ? `conforms to ${schemaName}.schema.json` : `schema violations: ${q.errors.slice(0, 5).join("; ")}`,
								errors: q.errors,
								warnings: q.warnings,
							};
							if (q.failed_folds.length > 0) {
								entry.detail += ` | failed folds reported: ${q.failed_folds.join(", ")}`;
							}
							return entry;
						})();
				// Quant contract schemas only PASS when the manifest is fully
				// VALIDATED (structure + semantics, immutable). A manifest that
				// merely parses (missing adjustment/corporate-action/delisting
				// semantics or per-profile requirements) FAILS the gate.
				const quantPassed = isQuantContract
					? (result as ReturnType<typeof validateQuantContract>).validationStatus === "validated"
					: result.valid;
				if (quantPassed) pass([evidence]);
				else fail(`artifact ${file} does not conform to ${schemaName} contract (validation status: ${isQuantContract ? (result as ReturnType<typeof validateQuantContract>).validationStatus : "invalid"})`, [evidence]);
				break;
			}

			default: {
				throw new GateSetupError(`${label}: unsupported check kind "${check.kind}"`);
			}
		}
	} catch (error) {
		if (error instanceof GateSetupError) throw error;
		entry.status = "FAIL";
		entry.failure_reason = `${label}: unexpected error: ${(error as Error).message}`;
	}

	const finishedAt = ctx.now();
	entry.finished_at = finishedAt.toISOString();
	entry.duration_ms = Math.max(0, finishedAt.getTime() - startedAt.getTime());
	return { entry, artifactPaths };
}

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

function worstStatus(a: GateStatus, b: GateStatus): GateStatus {
	const order: Record<GateStatus, number> = { PASS: 0, NOT_RUN: 1, BLOCKED: 2, FAIL: 3 };
	return order[a] >= order[b] ? a : b;
}

function gateStatusFromChecks(checks: readonly CheckRunEntry[]): { status: GateStatus; failure_reason: string | null; blocked_reason: string | null; warnings: string[] } {
	const warnings: string[] = [];
	let status: GateStatus = "PASS";
	let failure_reason: string | null = null;
	let blocked_reason: string | null = null;

	const failed = checks.filter((c) => c.status === "FAIL" && c.blocking);
	if (failed.length > 0) {
		status = "FAIL";
		failure_reason = `check(s) failed: ${failed.map((c) => c.check_id).join(", ")}`;
	} else {
		const blocked = checks.filter((c) => c.status === "BLOCKED" && c.blocking);
		if (blocked.length > 0) {
			status = "BLOCKED";
			blocked_reason = `check(s) blocked: ${blocked.map((c) => `${c.check_id} (${c.blocked_reason})`).join("; ")}`;
		} else {
			const notRun = checks.filter((c) => c.status === "NOT_RUN" && c.required);
			if (notRun.length > 0) {
				status = "NOT_RUN";
				blocked_reason = null;
			}
		}
	}
	for (const c of checks) {
		if (c.status === "FAIL" && !c.blocking) warnings.push(`non-blocking check ${c.check_id} failed: ${c.failure_reason}`);
		if (c.status === "BLOCKED" && !c.blocking) warnings.push(`non-blocking check ${c.check_id} blocked: ${c.blocked_reason}`);
		if (c.status === "NOT_RUN" && !c.required) warnings.push(`optional check ${c.check_id} not run`);
		if (c.warnings.length > 0) warnings.push(...c.warnings.map((w) => `check ${c.check_id}: ${w}`));
	}
	return { status, failure_reason, blocked_reason, warnings };
}

async function evaluateGate(
	gate: Gate,
	ctx: CheckContext,
	inRun: ReadonlyMap<string, GateRunEntry>,
	effective: readonly Gate[],
): Promise<GateRunEntry> {
	const startedAt = ctx.now();
	const prerequisite_status: Record<string, { status: GateStatus; source: string }> = {};
	let blocked_reason: string | null = null;

	for (const prereqId of gate.prerequisites) {
		const prereqGate = effective.find((g) => g.id === prereqId);
		const blocking = prereqGate ? prereqGate.blocking : true;
		const inRunEntry = inRun.get(prereqId);
		// Selection topologically closes every prerequisite. Missing same-run
		// state is therefore an internal/authority failure, never permission to
		// inherit a historical PASS from a different transaction.
		const status: GateStatus = inRunEntry?.status ?? "NOT_RUN";
		const source = inRunEntry ? "this-run" : "missing-this-run";
		prerequisite_status[prereqId] = { status, source };
		if (status !== "PASS" && blocking) {
			blocked_reason = `prerequisite ${prereqId} is ${status} (${source})`;
			break;
		}
	}

	const checks: CheckRunEntry[] = [];
	const evidencePaths: string[] = [];
	const logLabel = `==> gate ${gate.id} ${gate.title}`;

	if (blocked_reason) {
		ctx.log(`${logLabel}: BLOCKED (${blocked_reason})`);
		const finishedAt = ctx.now();
		return {
			id: gate.id,
			title: gate.title,
			description: gate.description,
			status: "BLOCKED",
			required: gate.required,
			blocking: gate.blocking,
			prerequisites: gate.prerequisites,
			prerequisite_status,
			checks: [],
			failure_reason: null,
			blocked_reason,
			warnings: [],
			evidence_paths: [],
			declared_evidence: gate.evidence,
			started_at: startedAt.toISOString(),
			finished_at: finishedAt.toISOString(),
			duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
		};
	}

	ctx.log(logLabel);
	for (const check of gate.checks) {
		const evaluated = await evaluateCheck(gate.id, check, ctx);
		const c = evaluated.entry;
		checks.push(c);
		evidencePaths.push(`evidence.json#/checks/${c.check_id}`, ...evaluated.artifactPaths);
		ctx.log(`    ${c.check_id} ${c.status}${c.failure_reason ? ` — ${c.failure_reason}` : ""}${c.blocked_reason ? ` — ${c.blocked_reason}` : ""}`);
	}

	const { status, failure_reason, blocked_reason: checkBlockedReason, warnings } = gateStatusFromChecks(checks);
	ctx.log(`    gate ${gate.id}: ${status} (${checks.filter((c) => c.status === "PASS").length}/${checks.length} checks passed)`);
	const finishedAt = ctx.now();
	return {
		id: gate.id,
		title: gate.title,
		description: gate.description,
		status,
		required: gate.required,
		blocking: gate.blocking,
		prerequisites: gate.prerequisites,
		prerequisite_status,
		checks,
		failure_reason,
		blocked_reason: checkBlockedReason,
		warnings,
		evidence_paths: evidencePaths,
		declared_evidence: gate.evidence,
		started_at: startedAt.toISOString(),
		finished_at: finishedAt.toISOString(),
		duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
	};
}

// ---------------------------------------------------------------------------
// Run orchestration + persistence
// ---------------------------------------------------------------------------

async function gitState(projectRoot: string, exec: ExecFn): Promise<{ commit: string | null; dirty: boolean }> {
	try {
		const rev = await exec("git", ["rev-parse", "HEAD"], { cwd: projectRoot });
		const commit = rev.code === 0 && rev.stdout.trim().length > 0 ? rev.stdout.trim() : null;
		const status = await exec("git", ["status", "--porcelain"], { cwd: projectRoot });
		const dirty = status.code === 0 && status.stdout.trim().length > 0;
		return { commit, dirty };
	} catch {
		return { commit: null, dirty: false };
	}
}

/**
 * Run a gate selector end to end and persist all run artifacts.
 * Throws GateSetupError for setup violations (path escapes, invalid
 * gates.yaml, unknown selectors); evaluation outcomes are reported in the
 * result, never thrown.
 */
export async function runGates(input: RunGatesInput): Promise<RunGatesResult> {
	const { projectRoot, selector, mode, exec } = input;
	let candidateBinding: GateCandidateBindingV1 | undefined;
	if (input.candidateBinding !== undefined) {
		const parsedCandidateBinding = parseGateCandidateBindingV1(input.candidateBinding);
		if (parsedCandidateBinding === null) throw new GateSetupError("INVALID_CANDIDATE_BINDING");
		candidateBinding = parsedCandidateBinding;
	}
	if (candidateBinding !== undefined && mode !== "VERIFY") throw new GateSetupError("CANDIDATE_GATE_REQUIRES_VERIFY");
	const now = input.now ?? (() => new Date());
	const startedAt = now();

	const { config, gates, trustedConfigFileDigest, requestedIds, ordered } = await selectGates(projectRoot, selector, input.gateConfigReadHooks);
	const planRunAuthority = await resolveGatePlanRunAuthority(projectRoot, selector, gates, ordered, input.workerFirstFacts);

	const runId = makeRunId(startedAt);
	const registered = await registerGateRunAttemptIndex(projectRoot, runId, startedAt);
	if (!registered.ok) throw new GateSetupError("GATE_ATTEMPT_INDEX_FAILED");
	const transaction = await beginRunTransaction(projectRoot, runId);
	const runDir = transaction.finalDir;
	const writeDir = transaction.stagingDir;
	await mkdir(join(writeDir, "artifacts"), { recursive: true });

	const git = await gitState(projectRoot, exec);

	const logLines: string[] = [
		`gate run ${runId}: selector=${selector} profile=${config.profile ?? "(none)"} mode=${mode}`,
		`gates in run (dependency order): ${ordered.join(", ")}`,
		"",
	];
	const log = (line: string): void => {
		logLines.push(line);
	};

	// P4b: the caller's manual evidence map is trimmed ONCE for evaluation
	// (type "manual" entries persist the trimmed note). The map the
	// validation binding hashes is derived AFTER evaluation from the ACTUAL
	// persisted type "manual" entries — the exact map
	// readPersistedGateRunFacts recovers at assessment time, so the
	// persisted gate evidence can reproduce the privacy-safe hash.
	const trimmedManual = trimmedManualEvidence(input.manualEvidence);

	const ctx: CheckContext = {
		projectRoot,
		effectiveProjectRoot: config.effectiveProjectRoot,
		runDir: writeDir,
		configIssues: config.issues,
		recipes: config.recipes,
		projectGates: config.gates,
		profile: config.profile,
		mode,
		exec,
		signal: input.signal,
		now,
		manualEvidence: trimmedManual,
		manualEvidenceProvenance: input.manualEvidenceProvenance ?? "user-command",
		workerFirstFacts: input.workerFirstFacts,
		actorFacts: input.actorFacts,
		artifactExternalRoots: config.artifactExternalRoots,
		jsonFileReadHooks: input.jsonFileReadHooks,
		log,
	};

	const inRun = new Map<string, GateRunEntry>();
	const gateEntries: GateRunEntry[] = [];
	for (const gateId of ordered) {
		const gate = gates.find((g) => g.id === gateId);
		if (!gate) continue;
		const entry = await evaluateGate(gate, ctx, inRun, gates);
		inRun.set(gateId, entry);
		gateEntries.push(entry);
	}

	let overall: GateStatus = "PASS";
	const requestedSet = new Set(requestedIds);
	for (const entry of gateEntries) {
		// Every selector-expanded gate is part of this invocation's explicit
		// outcome, even when the declaration marks it optional in a broader
		// ladder. Dependency-closure gates affect the invocation when required;
		// their blocking semantics already govern their dependents.
		if (requestedSet.has(entry.id) || entry.required) overall = worstStatus(overall, entry.status);
	}
	const planMappedStatuses = planRunAuthority.validation === undefined
		? []
		: planRunAuthority.validation.required_gate_ids.map((gateId) => inRun.get(gateId)?.status ?? "NOT_RUN");
	const planMappedPass = planMappedStatuses.every((status) => status === "PASS");
	if (planRunAuthority.validation?.coverage === "FULL") {
		for (const status of planMappedStatuses) overall = worstStatus(overall, status);
	}
	const finishedAt = now();
	const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
	const ok = overall === "PASS";

	if (planRunAuthority.validation !== undefined) {
		logLines.push(`plan coverage: ${planRunAuthority.validation.coverage} (${planRunAuthority.validation.required_gate_ids.join(", ")})`);
	}
	logLines.push("", `overall: ${overall}${ok ? "" : " (not a pass)"}`);
	const stdoutFull = logLines.join("\n") + "\n";

	// ------------------------------------------------------------ persistence

	const evidenceByCheck: Record<string, CheckRunEntry> = {};
	for (const gateEntry of gateEntries) {
		for (const c of gateEntry.checks) evidenceByCheck[c.check_id] = c;
	}
	// P4b: the binding's manual-evidence map comes from the ACTUAL persisted
	// type "manual" evidence entries (same last-entry-wins recovery as
	// readPersistedGateRunFacts) — never from the raw caller map, whose
	// extra/unknown keys (unselected checks, ghost ids) never persist and
	// would make the persisted evidence unable to reproduce the hash.
	const persistedManual = persistedManualEvidence(evidenceByCheck);
	const evidenceFile = {
		schema_version: GATE_SCHEMA_VERSION,
		run_id: runId,
		requested: requestedIds,
		profile: config.profile,
		mode,
		candidate_binding: candidateBinding,
		checks: evidenceByCheck,
	};

	const gatesFile: GateFileRecord = {
		schema_version: GATE_SCHEMA_VERSION,
		run_id: runId,
		requested: requestedIds,
		profile: config.profile,
		mode,
		candidate_binding: candidateBinding,
		gates: gateEntries,
	};
	// Compile BOTH authority records before opening either destination. The
	// bounded readers reject files above this exact cap, so returning success
	// after writing an unreadable record would manufacture acceptance
	// authority. Complete facts either fit unchanged or the run fails closed.
	const gatesAuthorityJson = compileGateAuthorityRecord(gatesFile);
	const evidenceAuthorityJson = compileGateAuthorityRecord(evidenceFile);

	const stdoutView = truncateTail(stdoutFull, { maxLines: 2000, maxBytes: 51200 });

	// P4a: capture the validation binding AFTER evaluation — both PASS and
	// non-PASS manifests carry it, built from the exact selected/effective/
	// manual/worker-first/prerequisite facts of THIS run. A capture failure
	// preserves the gate result and persists bounded unavailable state
	// (explicitly non-reusable). Prerequisite status facts are reduced to
	// gateId → status: sources (which embed run ids) never enter the hash.
	const prerequisiteStatus: Record<string, string> = {};
	const sourceAuthority: Record<string, string> = {};
	if (candidateBinding !== undefined) sourceAuthority.candidate = gateCandidateSourceAuthorityV1(candidateBinding);
	for (const entry of gateEntries) {
		for (const [gateId, facts] of Object.entries(entry.prerequisite_status)) {
			prerequisiteStatus[gateId] = facts.status;
		}
		for (const check of entry.checks) {
			for (const evidence of check.evidence) {
				if (evidence.type !== "artifact" || !evidence.run_id || !evidence.recipe || !evidence.authority_digest) continue;
				sourceAuthority[`artifact:${check.check_id}:${evidence.recipe}`] = `${evidence.run_id}:${evidence.authority_digest}:${evidence.authority_freshness ?? "current"}`;
			}
		}
	}
	const gateEvidence = await captureGateValidationEvidence({
		projectRoot,
		profile: config.profile,
		mode,
		exec,
		selector,
		requestedGates: requestedIds,
		effectiveGates: gateEntries.map((g) => g.id),
		projectGates: config.gates,
		trustedConfigFileDigest,
		manualEvidence: persistedManual,
		workerFirstFacts: input.workerFirstFacts,
		prerequisiteStatus,
		sourceAuthority,
		actorFacts: input.actorFacts,
		planReference: planRunAuthority.validation,
		successful: ok && (planRunAuthority.validation === undefined ||
			(planRunAuthority.validation.coverage === "FULL" && planMappedPass)),
	});

	const manifest = {
		schema_version: RUN_MANIFEST_SCHEMA_VERSION_V2,
		run_id: runId,
		recipe: "gate",
		profile: config.profile,
		started_at: startedAt.toISOString(),
		finished_at: finishedAt.toISOString(),
		duration_ms: durationMs,
		cwd: projectRoot,
		argv: ["/q-gate", selector],
		exit_code: ok ? 0 : 1,
		timed_out: false,
		cancelled: input.signal?.aborted ?? false,
		git_commit: git.commit,
		git_dirty: git.dirty,
		artifact_paths: ["gates.json", "evidence.json", "summary.json", ...gateEntries.flatMap((g) => g.evidence_paths.filter((p) => p.startsWith("artifacts/")))],
		stdout_truncated: stdoutView.truncated,
		stderr_truncated: false,
		mode,
		expected_exit_codes: [0],
		declared_writes: [],
		environment_names: [],
		validation_components: [],
		cache_request_mode: "no-cache",
		runtime_identity: currentRunRuntimeIdentityV1(),
		candidate_binding: candidateBinding,
		validation_evidence: gateEvidence.ok ? gateEvidence.block : unavailableEvidenceBlock(gateEvidence.reason),
		run_transaction_schema_version: 2,
		run_outcome: ok ? "SUCCESS" : "PROCESS_FAILED",
	};

	const gateSummary: Record<string, GateStatus> = {};
	for (const entry of gateEntries) gateSummary[entry.id] = entry.status;
	const summary = {
		run_id: runId,
		recipe: "gate",
		profile: config.profile,
		started_at: manifest.started_at,
		finished_at: manifest.finished_at,
		duration_ms: durationMs,
		cwd: projectRoot,
		argv: manifest.argv,
		exit_code: manifest.exit_code,
		timed_out: false,
		cancelled: manifest.cancelled,
		git_commit: git.commit,
		git_dirty: git.dirty,
		artifact_paths: manifest.artifact_paths,
		stdout_truncated: stdoutView.truncated,
		stderr_truncated: false,
		stdout: stdoutView.content,
		stderr: "",
		stdout_log: join(runDir, "stdout.log"),
		stderr_log: join(runDir, "stderr.log"),
		kind: "gate",
		requested: requestedIds,
		status: overall,
		gates: gateSummary,
		counts: {
			pass: gateEntries.filter((g) => g.status === "PASS").length,
			fail: gateEntries.filter((g) => g.status === "FAIL").length,
			blocked: gateEntries.filter((g) => g.status === "BLOCKED").length,
			not_run: gateEntries.filter((g) => g.status === "NOT_RUN").length,
		},
	};

	await writeFile(join(writeDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
	await writeFile(join(writeDir, "command.json"), JSON.stringify({ recipe: "gate", argv: manifest.argv, cwd: projectRoot }, null, 2), "utf8");
	await writeFile(join(writeDir, "environment.json"), JSON.stringify({ environment: {} }, null, 2), "utf8");
	await writeFile(join(writeDir, "gates.json"), gatesAuthorityJson, "utf8");
	await writeFile(join(writeDir, "evidence.json"), evidenceAuthorityJson, "utf8");
	await writeFile(join(writeDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
	await writeFile(join(writeDir, "stdout.log"), stdoutFull, "utf8");
	await writeFile(join(writeDir, "stderr.log"), "", "utf8");
	try {
		await commitRunTransaction(transaction, finishedAt);
	} catch {
		throw new GateSetupError("RUN_RECORD_COMMIT_FAILED");
	}
	return {
		ok,
		status: overall,
		runId,
		runDir,
		gates: gateEntries,
		requested: requestedIds,
		profile: config.profile,
		candidateIdentity: candidateBinding?.candidate_identity,
	};
}

/** Project-relative form of a path for display. */
export function displayRelative(projectRoot: string, absolutePath: string): string {
	const rel = relative(projectRoot, absolutePath);
	return rel.length === 0 || rel.startsWith("..") ? absolutePath : rel;
}
