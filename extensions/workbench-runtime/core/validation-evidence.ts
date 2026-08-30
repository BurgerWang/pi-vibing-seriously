/**
 * P4a validation-evidence binding — the durable, privacy-safe capture of
 * the exact project state a run's validation claims rest on, plus the pure
 * fail-closed comparison that decides whether a run's evidence is
 * reproducible RIGHT NOW.
 *
 * What a binding is:
 *   - schema-versioned `ValidationEvidenceBlock` (additive field on
 *     RunRecord: `validation_evidence`) with EITHER a full `binding` (capture
 *     succeeded) OR a bounded `unavailable_reason` (capture failed — the
 *     record then carries explicit non-reusable state, never a fabricated
 *     binding).
 *   - components: exact git HEAD, the diff hash (a COMPLETE SHA-256 of
 *     every changed regular project file — streamed, bounded memory — plus
 *     path AND porcelain status preserved through core/delegation-ledger.ts
 *     computeDiffHash), every KNOWN_LOCKFILES hash, the relevant
 *     workbench-config hash, the effective gate-state hash, profile, mode,
 *     target identity, source actor (owner) and terminal outcome facts.
 *   - recipe targets bind name + definition hash + normalized invocation
 *     (redacted recorded argv for executed runs; the action-key argv hash
 *     for action-cache materialized records) + normalized cwd; gate targets
 *     bind the selector + sorted requested + sorted effective gate ids.
 *   - gate-state hashes manual evidence (hashed, never raw), bounded
 *     worker-first/actor facts and prerequisite status facts (gateId →
 *     status only — no timestamps, no run ids, no sources).
 *
 * Privacy: a binding persists ONLY bounded hashes, enums and ids. Raw
 * source/config/lockfile content, environment/secret values, manual
 * evidence text, tool arguments (beyond the existing redacted records) and
 * full worker-first facts never appear in the block.
 *
 * Collection is STRICTLY fail-closed: every known lockfile and every
 * relevant workbench config path must be inspectable WHEN PRESENT. Gate-run
 * capture is the deliberate exception for gates.yaml itself: it MUST receive
 * the digest of the bounded stable snapshot that selected/executed the run,
 * and never reopens that mutable pathname during binding capture.
 * Absence is PROVEN with lstat: a genuine ENOENT stays a deterministic
 * "missing" marker ONLY when the path itself is absent — a dangling
 * symlink or any other existing path (symlink, directory, unreadable,
 * ELOOP/EISDIR/I/O) aborts the capture or the current-state collection.
 * An existing-but-unreadable file can never masquerade as a missing one.
 * The diff identity is equally strict: every changed regular project file
 * is hashed IN FULL (streamed, bounded memory); a changed path that is a
 * symlink, directory/submodule, unreadable, escaping, or otherwise not
 * provable in full makes capture/current collection unavailable. Only a
 * deletion WITH a deletion status binds the deterministic "missing"
 * marker.
 *
 * Comparison (`evaluateValidationReuse`) is pure, deterministic and FAIL
 * CLOSED: reusable ONLY for a valid, successful, complete, approved-Sol
 * binding with every component exactly equal. Safe misses are allowed;
 * false reuse is forbidden. Reason order is fixed:
 *   missing → legacy → corrupt → unavailable → unsuccessful → incomplete →
 *   non-Sol → commit → diff → dependencies → config → gate-state → profile
 *   → mode → target → collection-failure
 * with terminal short-circuits for missing/legacy/corrupt/unavailable,
 * source refusals and collection failure.
 *
 * P4b (Commander-facing read-run rendering of the reuse verdict) is a
 * separate later slice; this module only captures and compares.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { canonicalHash, sha256Hex, sha256HexBytes } from "../cache/canonical-hash.ts";
import { gateSchemaHash, normalizeCwd, recipeDefinitionHash, WORKBENCH_CONFIG_FILES } from "../cache/action-key.ts";
import { KNOWN_LOCKFILES } from "../cache/action-types.ts";
import { collectGitFacts, computeDiffHash, normalizeStatusPath, type GitFacts } from "./delegation-ledger.ts";
import { detectActorRole } from "./write-authority.ts";
import type { RecipeMutationFacts } from "./worker-policy.ts";
import type { Recipe } from "./recipe-schema.ts";
import type { ExecFn } from "./config.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import type { WorkerFirstGateFacts } from "./gate-schema.ts";

export const VALIDATION_EVIDENCE_SCHEMA_VERSION = 1;
export const VALIDATION_BINDING_SCHEMA_VERSION = 1;

/**
 * One already-proven workbench-config snapshot supplied by an authority
 * reader. Gate execution uses this for gates.yaml so validation capture binds
 * the exact bytes that selected/executed the gates without reopening the
 * pathname after evaluation. The path and key are both carried explicitly so
 * a misplaced digest cannot silently substitute for another config file.
 */
export interface TrustedWorkbenchConfigFileDigest {
	key: "gates.yaml";
	path: string;
	/** SHA-256 of the exact stable bytes, or the proven-absent marker. */
	digest: string;
}

/** Bounded capture-failure reason persisted as `unavailable_reason`. */
export const MAX_UNAVAILABLE_REASON_CHARS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidationOwner = "sol" | "worker" | "other" | "unknown";
export type ValidationOutcomeSource = "exec" | "cache" | "gate";

export interface ValidationOutcomeFacts {
	/** Terminal success: exit code expected (recipes) / overall PASS (gates). */
	successful: boolean;
	/** The run reached a real terminal state (not killed, not a spawn failure). */
	complete: boolean;
	/** How the run was produced. */
	source: ValidationOutcomeSource;
}

export interface RecipeValidationTarget {
	kind: "recipe";
	name: string;
	/** recipeDefinitionHash — everything that affects execution semantics. */
	definition_hash: string;
	/** redacted recorded argv for exec; action-key argv hash for cache hits. */
	invocation_hash: string;
	/** normalized project-relative cwd. */
	cwd: string;
}

export interface GateValidationTarget {
	kind: "gate";
	selector: string;
	/** sorted requested gate ids (selector-expanded, before dependency order). */
	requested_gates: string[];
	/** sorted effective gate ids actually evaluated in this run. */
	effective_gates: string[];
	/** Optional strict delegation-plan identity and selector coverage. */
	plan_reference?: GatePlanValidationFacts;
}

export interface GatePlanValidationFacts {
	plan_reference_hash: string;
	required_gate_ids: string[];
	/** FULL is reserved for base/all with every mapped Gate selected. */
	coverage: "FULL" | "PARTIAL";
}

export type ValidationTarget = RecipeValidationTarget | GateValidationTarget;

export interface ValidationBinding {
	schema_version: number;
	kind: "recipe" | "gate";
	/** Exact HEAD at capture time (null outside a git repo / unborn HEAD). */
	commit: string | null;
	/** Complete diff hash: FULL content of every changed regular file + path + porcelain status. */
	diff_hash: string;
	/** Every KNOWN_LOCKFILES hash ("missing"/"not-a-file"/"too-large" markers included). */
	lockfiles: Record<string, string>;
	/** Relevant workbench config hash (project/recipes/gates/profiles.yaml). */
	config_hash: string;
	/**
	 * Effective gate state: for recipe bindings the effective gate SCHEMA
	 * hash (the ladder the run would be validated against); for gate
	 * bindings the hash over the schema + hashed manual evidence + bounded
	 * worker-first/actor facts + prerequisite status facts.
	 */
	gate_state_hash: string;
	/**
	 * Selected profile. Genuinely OPTIONAL: a profile-less project omits the
	 * own property entirely (in memory AND persisted — JSON serialization
	 * drops undefined keys), so returned and persisted blocks are exactly
	 * deep-equal. When defined, the property is preserved as-is.
	 */
	profile?: string;
	mode: WorkbenchMode;
	/** Source actor: detectActorRole over the caller's actor facts. */
	owner: ValidationOwner;
	target: ValidationTarget;
	outcome: ValidationOutcomeFacts;
}

export interface ValidationEvidenceBlock {
	schema_version: number;
	/** null + unavailable_reason when capture failed (non-reusable by design). */
	binding: ValidationBinding | null;
	unavailable_reason: string | null;
}

// ---------------------------------------------------------------------------
// Reuse verdicts (fixed deterministic reason order)
// ---------------------------------------------------------------------------

/**
 * Canonical fixed refusal reason codes, in the documented deterministic
 * order (module docstring: missing → legacy → corrupt → unavailable →
 * unsuccessful → incomplete → non-Sol → commit → diff → dependencies →
 * config → gate-state → profile → mode → target → collection-failure).
 * This single runtime allowlist backs the type AND every runtime consumer
 * (e.g. the P4b TUI renderer boundary) — no consumer may duplicate the
 * set. A code is a fixed lowercase-hyphen token: exact membership is the
 * only accepted form, so a reason can never carry casing variants, prose,
 * whitespace, newlines or secret-like text.
 */
export const VALIDATION_REFUSAL_REASONS = [
	"missing-binding",
	"legacy-binding",
	"corrupt-binding",
	"unavailable-binding",
	"unsuccessful-source",
	"incomplete-source",
	"non-sol-source",
	"commit-mismatch",
	"diff-mismatch",
	"dependencies-mismatch",
	"config-mismatch",
	"gate-state-mismatch",
	"profile-mismatch",
	"mode-mismatch",
	"target-mismatch",
	"collection-failure",
] as const;

export type ValidationRefusalReason = (typeof VALIDATION_REFUSAL_REASONS)[number];

/**
 * Exact-membership guard for the canonical fixed refusal codes. Only a
 * string that is exactly one of VALIDATION_REFUSAL_REASONS passes — a
 * reason can never carry casing variants, prose, whitespace, newlines,
 * control characters or secret-like text.
 */
export function isValidationRefusalReason(value: unknown): value is ValidationRefusalReason {
	return typeof value === "string" && (VALIDATION_REFUSAL_REASONS as readonly string[]).includes(value);
}

export interface ValidationReuseVerdict {
	reusable: boolean;
	/** Empty when reusable; otherwise the fixed-order refusal reasons. */
	reasons: ValidationRefusalReason[];
}

/**
 * The current project state a binding is compared against. `collectionFailed`
 * is fail-closed: when the current git/config facts cannot be collected the
 * comparison REFUSES reuse (a failed status must never fabricate a
 * clean-tree fact set that could pass as "nothing changed").
 */
export interface ValidationCurrentState {
	collectionFailed: boolean;
	collectionReason: string | null;
	commit: string | null;
	diffHash: string;
	lockfiles: Record<string, string>;
	configHash: string;
	gateStateHash: string;
	/** Optional like ValidationBinding.profile: absent when the project has no profile. */
	profile?: string;
	mode: WorkbenchMode;
	target: ValidationTarget;
}

// ---------------------------------------------------------------------------
// Strict parser (fail-closed, never throws)
// ---------------------------------------------------------------------------

const HASH_RE = /^[0-9a-f]{64}$/;
/** git HEAD: SHA-1 (40 hex) today, SHA-256 repos (64 hex) — both accepted. */
const COMMIT_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

function isCommitHash(value: unknown): value is string {
	return typeof value === "string" && COMMIT_RE.test(value);
}
const OWNERS: readonly ValidationOwner[] = ["sol", "worker", "other", "unknown"];
const MODES: readonly string[] = ["AUDIT", "DEV", "VERIFY"];
const SOURCES: readonly ValidationOutcomeSource[] = ["exec", "cache", "gate"];
const GATE_STATUSES: readonly string[] = ["PASS", "FAIL", "BLOCKED", "NOT_RUN"];
const MAX_ID_CHARS = 200;
const MAX_ARRAY_ITEMS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && HASH_RE.test(value);
}

function isBoundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length <= max;
}

function isStringArray(value: unknown, max: number): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= MAX_ARRAY_ITEMS &&
		value.every((item): item is string => typeof item === "string" && item.length <= max)
	);
}

function isLockfileMap(value: unknown): value is Record<string, string> {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	// Exactly the complete known lockfile set — an incomplete map (a known
	// lockfile dropped) or an unknown key is never accepted as evidence.
	if (keys.length !== KNOWN_LOCKFILES.length) return false;
	for (const name of keys) {
		if (!KNOWN_LOCKFILES.includes(name)) return false;
	}
	for (const hash of Object.values(value)) {
		if (typeof hash !== "string") return false;
		if (hash !== "missing" && hash !== "not-a-file" && hash !== "too-large" && !HASH_RE.test(hash)) return false;
	}
	return true;
}

function isOutcome(value: unknown): value is ValidationOutcomeFacts {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	if (keys.length !== 3 || !keys.includes("successful") || !keys.includes("complete") || !keys.includes("source")) {
		return false;
	}
	return (
		typeof value.successful === "boolean" &&
		typeof value.complete === "boolean" &&
		SOURCES.includes(value.source as ValidationOutcomeSource)
	);
}

function isRecipeTarget(value: unknown): value is RecipeValidationTarget {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	if (keys.length !== 5 || !keys.includes("kind")) return false;
	return (
		value.kind === "recipe" &&
		isBoundedString(value.name, MAX_ID_CHARS) &&
		isSha256(value.definition_hash) &&
		isSha256(value.invocation_hash) &&
		isBoundedString(value.cwd, MAX_ID_CHARS)
	);
}

function isGateTarget(value: unknown): value is GateValidationTarget {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	if ((keys.length !== 4 && keys.length !== 5) || !keys.includes("kind") ||
		keys.some((key) => !["kind", "selector", "requested_gates", "effective_gates", "plan_reference"].includes(key))) return false;
	const plan = value.plan_reference;
	const planGateIds = isRecord(plan) && Array.isArray(plan.required_gate_ids)
		? plan.required_gate_ids
		: undefined;
	const planValid = plan === undefined || (
		isRecord(plan) &&
		Object.keys(plan).length === 3 &&
		Object.keys(plan).every((key) => ["plan_reference_hash", "required_gate_ids", "coverage"].includes(key)) &&
		isSha256(plan.plan_reference_hash) &&
		planGateIds !== undefined &&
		isStringArray(planGateIds, MAX_ID_CHARS) &&
		planGateIds.length > 0 &&
		planGateIds.every((id, index) => index === 0 || planGateIds[index - 1]! < id) &&
		(plan.coverage === "FULL" || plan.coverage === "PARTIAL")
	);
	return (
		value.kind === "gate" &&
		isBoundedString(value.selector, MAX_ID_CHARS) &&
		isStringArray(value.requested_gates, MAX_ID_CHARS) &&
		isStringArray(value.effective_gates, MAX_ID_CHARS) &&
		planValid
	);
}

export type ParseValidationEvidenceResult =
	| { ok: true; block: ValidationEvidenceBlock }
	| { ok: false; reason: string };

/**
 * Strict, fail-closed parser for a persisted validation-evidence block.
 * Refuses unknown fields, wrong types, malformed hashes, foreign enums and
 * the contradictory binding+unavailable combination — anything we did not
 * produce is never accepted as evidence. Never throws.
 */
export function parseValidationEvidenceBlock(raw: unknown): ParseValidationEvidenceResult {
	if (!isRecord(raw)) return { ok: false, reason: "block must be a JSON object" };
	const keys = Object.keys(raw);
	if (keys.length !== 3 || !keys.includes("schema_version") || !keys.includes("binding") || !keys.includes("unavailable_reason")) {
		return { ok: false, reason: `unexpected block fields: ${keys.join(", ") || "none"}` };
	}
	if (raw.schema_version !== VALIDATION_EVIDENCE_SCHEMA_VERSION) {
		return { ok: false, reason: `unsupported schema_version ${String(raw.schema_version)} (expected ${VALIDATION_EVIDENCE_SCHEMA_VERSION})` };
	}
	if (raw.binding === null) {
		if (!isBoundedString(raw.unavailable_reason, MAX_UNAVAILABLE_REASON_CHARS)) {
			return { ok: false, reason: "unavailable block must carry a bounded unavailable_reason string" };
		}
		return { ok: true, block: { schema_version: VALIDATION_EVIDENCE_SCHEMA_VERSION, binding: null, unavailable_reason: raw.unavailable_reason } };
	}
	if (raw.unavailable_reason !== null) {
		return { ok: false, reason: "a binding and an unavailable_reason cannot both be present" };
	}
	const binding = raw.binding;
	if (!isRecord(binding)) return { ok: false, reason: "binding must be an object" };
	const bindingKeys = Object.keys(binding);
	// profile is the ONLY optional binding field: JSON serialization drops
	// undefined keys, so persisted bindings carry 12 keys with a profile and
	// 11 without. Every other field is required.
	if (bindingKeys.length < 11 || bindingKeys.length > 12 || !bindingKeys.includes("schema_version") || !bindingKeys.includes("kind")) {
		return { ok: false, reason: `unexpected binding fields: ${bindingKeys.join(", ") || "none"}` };
	}
	for (const required of ["schema_version", "kind", "commit", "diff_hash", "lockfiles", "config_hash", "gate_state_hash", "mode", "owner", "target", "outcome"]) {
		if (!bindingKeys.includes(required)) return { ok: false, reason: `missing binding field "${required}"` };
	}
	// profile is the only optional field: every OTHER key must be one of the
	// required fields — an extra binding field can never ride along.
	for (const key of bindingKeys) {
		if (key !== "profile" && !["schema_version", "kind", "commit", "diff_hash", "lockfiles", "config_hash", "gate_state_hash", "mode", "owner", "target", "outcome"].includes(key)) {
			return { ok: false, reason: `unexpected binding field "${key}"` };
		}
	}
	if (binding.schema_version !== VALIDATION_BINDING_SCHEMA_VERSION) {
		return { ok: false, reason: `unsupported binding schema_version ${String(binding.schema_version)}` };
	}
	if (binding.kind !== "recipe" && binding.kind !== "gate") {
		return { ok: false, reason: `unknown binding kind ${String(binding.kind)}` };
	}
	if (binding.commit !== null && !isCommitHash(binding.commit)) {
		return { ok: false, reason: "commit must be a 40/64-hex hash or null" };
	}
	if (!isSha256(binding.diff_hash)) return { ok: false, reason: "diff_hash must be a 64-hex hash" };
	if (!isLockfileMap(binding.lockfiles)) return { ok: false, reason: "lockfiles must be a map of known lockfile hashes" };
	if (!isSha256(binding.config_hash)) return { ok: false, reason: "config_hash must be a 64-hex hash" };
	if (!isSha256(binding.gate_state_hash)) return { ok: false, reason: "gate_state_hash must be a 64-hex hash" };
	if (binding.profile !== undefined && !isBoundedString(binding.profile, MAX_ID_CHARS)) {
		return { ok: false, reason: "profile must be a bounded string or absent" };
	}
	if (!MODES.includes(binding.mode as string)) return { ok: false, reason: `unknown mode ${String(binding.mode)}` };
	if (!OWNERS.includes(binding.owner as ValidationOwner)) return { ok: false, reason: `unknown owner ${String(binding.owner)}` };
	const target = binding.target;
	const targetValid = binding.kind === "recipe" ? isRecipeTarget(target) : isGateTarget(target);
	if (!targetValid) return { ok: false, reason: `malformed ${binding.kind} target` };
	if (!isOutcome(binding.outcome)) return { ok: false, reason: "malformed outcome facts" };
	return {
		ok: true,
		block: {
			schema_version: VALIDATION_EVIDENCE_SCHEMA_VERSION,
			binding: {
				schema_version: VALIDATION_BINDING_SCHEMA_VERSION,
				kind: binding.kind,
				commit: binding.commit,
				diff_hash: binding.diff_hash,
				lockfiles: binding.lockfiles,
				config_hash: binding.config_hash,
				gate_state_hash: binding.gate_state_hash,
				...(binding.profile !== undefined ? { profile: binding.profile as string } : {}),
				mode: binding.mode as WorkbenchMode,
				owner: binding.owner as ValidationOwner,
				target: target as ValidationTarget,
				outcome: binding.outcome,
			},
			unavailable_reason: null,
		},
	};
}

/**
 * Stable privacy-safe identity of one complete, parseable validation block.
 * Authority edges persist only this digest; malformed/unavailable bindings
 * have no identity and therefore can never satisfy a dependent check.
 */
export function validationEvidenceIdentity(raw: unknown): string | null {
	const parsed = parseValidationEvidenceBlock(raw);
	if (!parsed.ok || parsed.block.binding === null) return null;
	return canonicalHash(parsed.block);
}

/**
 * Source-time eligibility independent of later project drift. When an
 * expected recipe identity is supplied, the binding must also be the exact
 * recipe/invocation represented by the producer manifest; a successful Gate
 * binding or another recipe's binding can never authorize its artifacts.
 */
export function validationEvidenceSourceEligible(
	raw: unknown,
	expected?: { recipe: string; argvHash: unknown },
): boolean {
	const parsed = parseValidationEvidenceBlock(raw);
	const binding = parsed.ok ? parsed.block.binding : null;
	if (!(binding !== null
		&& binding.owner === "sol"
		&& binding.outcome.successful
		&& binding.outcome.complete)) return false;
	if (!expected) return true;
	return typeof expected.argvHash === "string"
		&& isSha256(expected.argvHash)
		&& binding.kind === "recipe"
		&& binding.target.kind === "recipe"
		&& binding.target.name === expected.recipe
		&& binding.target.invocation_hash === expected.argvHash;
}

// ---------------------------------------------------------------------------
// Gate-state hashing (bounded, privacy-safe)
// ---------------------------------------------------------------------------

/**
 * Hash of the effective gate schema for a profile — the ladder the run
 * would be validated against. Recipe bindings use this as their
 * gate_state_hash; gate bindings fold it into the full gate-state hash.
 */
function effectiveGateSchemaHash(profile: string | undefined, projectGates: readonly unknown[]): string {
	return gateSchemaHash(profile, projectGates);
}

/** Hashed manual evidence: check id → sha256 of the note. Raw text never persists. */
export function manualEvidenceHash(manualEvidence: Readonly<Record<string, string>>): string {
	const entries: Array<[string, string]> = [];
	for (const [checkId, note] of Object.entries(manualEvidence)) {
		if (typeof note !== "string") continue;
		entries.push([checkId, sha256Hex(note)]);
	}
	entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return canonicalHash({ manual: entries });
}

/**
 * Bounded worker-first compliance facts hash. `currentDiffHash` is
 * deliberately EXCLUDED: the diff is already an exact binding component, so
 * a diff change must surface as diff-mismatch, never as a double-counted
 * gate-state change. Everything else is bounded enum/id/boolean/number
 * material and is hashed as-is (never persisted raw).
 */
export function workerFirstFactsHash(facts: WorkerFirstGateFacts | undefined): string {
	if (!facts) return canonicalHash({ worker: null });
	const carriesPlanFacts = facts.planReferenceHash !== undefined || facts.requiredGateIds !== undefined ||
		facts.planReferenceCurrent !== undefined || facts.planReferenceBlockedReason !== undefined;
	return canonicalHash({
		worker: {
			schema_version: facts.schema_version,
			blockedReason: facts.blockedReason ?? null,
			actor: facts.actor,
			writePolicy: facts.writePolicy,
			commanderWritesDenied: facts.commanderWritesDenied,
			blockedCommanderWriteAttempts: facts.blockedCommanderWriteAttempts,
			hasDelegation: facts.hasDelegation,
			latestDelegationId: facts.latestDelegationId,
			reviewStatus: facts.reviewStatus,
			reviewedDiffHash: facts.reviewedDiffHash,
			reviewVerdict: facts.reviewVerdict,
			reviewViolationCount: facts.reviewViolationCount,
			leaseStatus: facts.leaseStatus,
			leaseReason: facts.leaseReason,
			leaseCallsUsed: facts.leaseCallsUsed,
			leaseMaxCalls: facts.leaseMaxCalls,
			gateRunInitiatedByCommander: facts.gateRunInitiatedByCommander,
			...(carriesPlanFacts ? {
				plan: {
					planReferenceHash: facts.planReferenceHash ?? null,
					requiredGateIds: [...new Set(facts.requiredGateIds ?? [])].sort(),
					planReferenceCurrent: facts.planReferenceCurrent ?? null,
					planReferenceBlockedReason: facts.planReferenceBlockedReason ?? null,
				},
			} : {}),
		},
	});
}

/** Bounded actor facts hash: role enum + provider/model ids only. */
export function actorFactsHash(facts: RecipeMutationFacts | undefined): string {
	if (!facts) return canonicalHash({ actor: null });
	return canonicalHash({
		actor: {
			role: facts.role ?? null,
			provider: facts.provider ?? null,
			model: facts.model ?? null,
		},
	});
}

/**
 * Prerequisite status facts hash: gateId → status ONLY. Sources (which may
 * embed run ids like "run:20260101-…") and timestamps are dropped — the
 * hash must never self-invalidate through its own run ids.
 */
export function prerequisiteStatusHash(prerequisiteStatus: Readonly<Record<string, string>>): string {
	const entries: Array<[string, string]> = [];
	for (const [gateId, status] of Object.entries(prerequisiteStatus)) {
		if (!GATE_STATUSES.includes(status)) continue;
		entries.push([gateId, status]);
	}
	entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return canonicalHash({ prerequisites: entries });
}

/**
 * External authority-edge identities (for example an artifact-producing
 * recipe run). Values are already fixed-size validation-binding digests plus
 * bounded run identity; hashing keeps them out of the public binding while
 * making replacement/staleness an exact gate-state mismatch.
 */
export function sourceAuthorityHash(sourceAuthority: Readonly<Record<string, string>>): string {
	const entries = Object.entries(sourceAuthority)
		.filter(([key, value]) => key.length > 0 && key.length <= 500 && value.length > 0 && value.length <= 500)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return canonicalHash({ sources: entries });
}

/** Full gate-state hash: schema + evidence/facts + prerequisite and authority-edge identities. */
export function gateStateHash(input: {
	profile: string | undefined;
	projectGates: readonly unknown[];
	manualEvidence: Readonly<Record<string, string>>;
	workerFirstFacts?: WorkerFirstGateFacts;
	actorFacts?: RecipeMutationFacts;
	prerequisiteStatus: Readonly<Record<string, string>>;
	sourceAuthority?: Readonly<Record<string, string>>;
}): string {
	return canonicalHash({
		schema: effectiveGateSchemaHash(input.profile, input.projectGates),
		manual: manualEvidenceHash(input.manualEvidence),
		worker: workerFirstFactsHash(input.workerFirstFacts),
		actor: actorFactsHash(input.actorFacts),
		prerequisites: prerequisiteStatusHash(input.prerequisiteStatus),
		sources: sourceAuthorityHash(input.sourceAuthority ?? {}),
	});
}

// ---------------------------------------------------------------------------
// Owner resolution
// ---------------------------------------------------------------------------

/**
 * Source actor of the run: the same identity sources as the write-policy
 * module (WORKBENCH_AGENT_ROLE worker env contract + provider/model pair,
 * never project config). Fact-less callers are "unknown".
 */
export function ownerFromActorFacts(facts: RecipeMutationFacts | undefined): ValidationOwner {
	if (!facts) return "unknown";
	const role = detectActorRole({ roleEnv: facts.role, provider: facts.provider, model: facts.model });
	switch (role) {
		case "sol-commander":
			return "sol";
		case "delegated-worker":
			return "worker";
		default:
			return "other";
	}
}

// ---------------------------------------------------------------------------
// Target builders
// ---------------------------------------------------------------------------

export function buildRecipeValidationTarget(recipe: Recipe, invocationHash: string, projectRoot: string): RecipeValidationTarget {
	return {
		kind: "recipe",
		name: recipe.name,
		definition_hash: recipeDefinitionHash(recipe),
		invocation_hash: invocationHash,
		cwd: normalizeCwd(projectRoot, recipe.cwd),
	};
}

export function buildGateValidationTarget(
	selector: string,
	requestedGates: readonly string[],
	effectiveGates: readonly string[],
	planReference?: Readonly<GatePlanValidationFacts>,
): GateValidationTarget {
	return {
		kind: "gate",
		selector,
		requested_gates: [...new Set(requestedGates)].sort(),
		effective_gates: [...new Set(effectiveGates)].sort(),
		...(planReference === undefined ? {} : {
			plan_reference: {
				plan_reference_hash: planReference.plan_reference_hash,
				required_gate_ids: [...new Set(planReference.required_gate_ids)].sort(),
				coverage: planReference.coverage,
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// Strict fail-closed collection (P4a) — never a reusable all-"missing" state
// ---------------------------------------------------------------------------

/** Same cap as the P6-C action-key lockfile fingerprint (64 MiB). */
const LOCKFILE_MAX_BYTES = 64 * 1024 * 1024;

function errnoCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	return (error as NodeJS.ErrnoException).code;
}

/**
 * Hash every KNOWN_LOCKFILES at the project root. Absence is PROVEN with
 * lstat: a genuine ENOENT is the ONLY safe "missing" marker. Any EXISTING
 * path that is not a provable regular file — a symlink (dangling or
 * resolving; never followed), directory, socket/FIFO, or any stat/read
 * error (EACCES, ELOOP, EISDIR, I/O) — THROWS so the caller fails closed.
 * Marker semantics stay identical to the P6-C action-key collection
 * (missing/not-a-file/too-large/full-content hash).
 */
async function collectLockfileHashesStrict(projectRoot: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const name of KNOWN_LOCKFILES) {
		const path = join(projectRoot, name);
		let info: Stats;
		try {
			info = await lstat(path);
		} catch (error) {
			if (errnoCode(error) === "ENOENT") {
				out[name] = "missing";
				continue;
			}
			throw new Error(`lockfile "${name}" cannot be inspected: ${String((error as Error).message ?? error)}`);
		}
		if (info.isSymbolicLink()) {
			// A symlink is an EXISTING path (dangling or not) — never a
			// genuine absence. Following it would read through an unproven
			// indirection, so collection fails closed.
			throw new Error(`lockfile "${name}" is a symlink — refusing to follow an existing non-regular path`);
		}
		if (!info.isFile()) {
			out[name] = "not-a-file";
			continue;
		}
		if (info.size > LOCKFILE_MAX_BYTES) {
			out[name] = "too-large";
			continue;
		}
		try {
			out[name] = sha256HexBytes(await readFile(path));
		} catch (error) {
			throw new Error(`lockfile "${name}" cannot be read: ${String((error as Error).message ?? error)}`);
		}
	}
	return out;
}

/**
 * Hash the relevant workbench config files under
 * <root>/<CONFIG_DIR_NAME>/workbench (Pi's official config dir name; same
 * files and marker semantics as the P6-C action-key config hash). An explicit
 * trusted gates.yaml digest substitutes ONLY for that exact key/path; all
 * other files retain the strict filesystem collection below. Absence
 * is PROVEN with lstat: a genuine ENOENT is the only "missing" marker; any
 * EXISTING path that is not a provable regular file (symlink — dangling or
 * resolving — directory, unreadable, I/O error) THROWS (fail closed).
 */
async function collectWorkbenchConfigHashStrict(
	projectRoot: string,
	trustedFile?: TrustedWorkbenchConfigFileDigest,
): Promise<string> {
	if (trustedFile !== undefined) {
		if (!isRecord(trustedFile)) {
			throw new Error("trusted workbench config digest must be an object");
		}
		const keys = Object.keys(trustedFile).sort();
		if (keys.length !== 3 || keys[0] !== "digest" || keys[1] !== "key" || keys[2] !== "path") {
			throw new Error("trusted workbench config digest must contain exactly digest, key and path");
		}
		if (trustedFile.key !== "gates.yaml") {
			throw new Error("trusted workbench config digest key must be gates.yaml");
		}
		const expectedPath = join(projectRoot, CONFIG_DIR_NAME, "workbench", "gates.yaml");
		if (trustedFile.path !== expectedPath) {
			throw new Error("trusted workbench config digest path does not exactly match project gates.yaml");
		}
		if (trustedFile.digest !== "missing" && !HASH_RE.test(trustedFile.digest)) {
			throw new Error("trusted workbench config digest must be missing or a SHA-256 hash");
		}
	}

	const parts: Record<string, string> = {};
	for (const file of WORKBENCH_CONFIG_FILES) {
		if (trustedFile !== undefined && file === trustedFile.key) {
			parts[file] = trustedFile.digest;
			continue;
		}
		const path = join(projectRoot, CONFIG_DIR_NAME, "workbench", file);
		let info: Stats;
		try {
			info = await lstat(path);
		} catch (error) {
			if (errnoCode(error) === "ENOENT") {
				parts[file] = "missing";
				continue;
			}
			throw new Error(`workbench config "${file}" cannot be inspected: ${String((error as Error).message ?? error)}`);
		}
		if (info.isSymbolicLink()) {
			throw new Error(`workbench config "${file}" is a symlink — refusing to follow an existing non-regular path`);
		}
		if (!info.isFile()) {
			throw new Error(`workbench config "${file}" exists but is not a regular file`);
		}
		try {
			parts[file] = sha256HexBytes(await readFile(path));
		} catch (error) {
			throw new Error(`workbench config "${file}" cannot be read: ${String((error as Error).message ?? error)}`);
		}
	}
	return canonicalHash(parts);
}

/**
 * Deterministic, privacy-safe hash of an executed argv (raw values are
 * hashed, never persisted). Identical to the P6-C action-key argv hash
 * derivation, so exec and materialized-cache targets bind the SAME hash
 * for the same argv.
 */
export function executedArgvHash(argv: readonly string[]): string {
	return sha256Hex(canonicalHash(argv));
}

// ---------------------------------------------------------------------------
// Complete-content diff hashing (P4a validation identity)
// ---------------------------------------------------------------------------

/**
 * True when a porcelain XY code is a deletion in either position ("D ",
 * " D", "AD", "MD", "DD"): the file is absent from the worktree by git's
 * own account, so the deterministic "missing" marker is the provable
 * content fact.
 */
function isDeletionStatus(status: string | undefined): boolean {
	return typeof status === "string" && (status[0] === "D" || status[1] === "D");
}

/** Stream the FULL file content into a SHA-256 (chunked, bounded memory). */
async function sha256FileStreaming(absolutePath: string, label: string): Promise<string> {
	const hash = createHash("sha256");
	try {
		for await (const chunk of createReadStream(absolutePath)) {
			hash.update(chunk as Buffer);
		}
	} catch (error) {
		throw new Error(`${label}: cannot be read in full: ${String((error as Error).message ?? error)}`);
	}
	return hash.digest("hex");
}

/**
 * COMPLETE SHA-256 of one changed path's full content (streamed, bounded
 * memory). FAILS CLOSED — throws — for any changed path whose complete
 * content cannot be proven:
 *   - not a safe contained project-relative path (escape/absolute/drive)
 *   - absent from disk without a deletion status (unprovable, not a
 *     deletion)
 *   - a symlink (never followed: its content identity is not provable)
 *   - not a regular file (directory/submodule, FIFO, socket, device)
 *   - unreadable or truncated mid-read (permissions, I/O)
 * A deletion WITH a deletion status is the ONLY deterministic absence and
 * hashes the shared "missing" marker (the same marker the ledger uses for
 * absent digests). This is the P4 validation identity — deliberately
 * stricter than the delegation ledger's bounded prefix digests (which are
 * untouched).
 */
export async function completeContentDigestStrict(projectRoot: string, path: string, status: string | undefined): Promise<string> {
	const root = resolve(projectRoot);
	const normalized = normalizeStatusPath(path);
	if (!normalized) throw new Error(`changed path is not a safe project-relative path: ${path}`);
	const absolute = resolve(root, normalized);
	const rel = relative(root, absolute);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`changed path escapes the project root: ${path}`);
	}
	let info: Stats;
	try {
		info = await lstat(absolute);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") {
			if (isDeletionStatus(status)) return "missing";
			throw new Error(`changed path is absent from disk but its porcelain status is not a deletion: ${path}`);
		}
		throw new Error(`changed path cannot be inspected: ${path}: ${String((error as Error).message ?? error)}`);
	}
	if (info.isSymbolicLink()) {
		throw new Error(`changed path is a symlink — full content cannot be proven without following: ${path}`);
	}
	if (!info.isFile()) {
		throw new Error(`changed path is not a regular file (directory/submodule or special file): ${path}`);
	}
	return sha256FileStreaming(absolute, `changed path "${path}"`);
}

/**
 * Complete diff hash over the current changed paths: EVERY changed regular
 * file is hashed in full (streamed); deletions with a deletion status bind
 * the "missing" marker; path and porcelain status are preserved through
 * computeDiffHash — the SAME derivation at capture and comparison time, so
 * status-only transitions ("??" → "A ") still change the hash even when
 * bytes are identical. Any unprovable changed path throws so capture and
 * current-state collection fail closed.
 */
async function collectCompleteDiffHash(projectRoot: string, facts: GitFacts): Promise<string> {
	const digests: Record<string, string> = {};
	for (const path of facts.changedPaths) {
		digests[path] = await completeContentDigestStrict(projectRoot, path, facts.pathStatuses[path]);
	}
	return computeDiffHash(facts.changedPaths, digests, facts.pathStatuses);
}

// ---------------------------------------------------------------------------
// Capture (privacy-safe, fail-closed)
// ---------------------------------------------------------------------------

export type CaptureValidationResult =
	| { ok: true; block: ValidationEvidenceBlock }
	| { ok: false; reason: string };

/** A bounded non-reusable block for a failed capture. */
export function unavailableEvidenceBlock(reason: string): ValidationEvidenceBlock {
	return {
		schema_version: VALIDATION_EVIDENCE_SCHEMA_VERSION,
		binding: null,
		unavailable_reason: reason.slice(0, MAX_UNAVAILABLE_REASON_CHARS),
	};
}

export interface CaptureRecipeValidationInput {
	projectRoot: string;
	profile: string | undefined;
	mode: WorkbenchMode;
	exec: ExecFn;
	recipe: Recipe;
	/**
	 * Raw executed argv — used ONLY to derive the invocation hash when
	 * `argvHash` is absent; it is hashed immediately and never persisted.
	 * Callers that already hold the executed-argv hash (exec runs and
	 * action-cache materialized records) pass it as `argvHash` instead.
	 */
	argv?: string[];
	/**
	 * Executed-argv hash for cache hits (the action-key argv hash from the
	 * materialized record); exec runs derive it from argv. When absent the
	 * invocation hash falls back to hashing `argv`.
	 */
	argvHash?: string;
	projectGates: readonly unknown[];
	actorFacts?: RecipeMutationFacts;
	successful: boolean;
	complete: boolean;
	source: "exec" | "cache";
}

/**
 * Capture a recipe-run validation binding. FAILS CLOSED: any collection
 * error (git status unavailable, lockfile/config read errors) returns
 * {ok:false} — the caller persists bounded unavailable state instead of a
 * partial binding. Never throws.
 */
export async function captureRecipeValidationEvidence(input: CaptureRecipeValidationInput): Promise<CaptureValidationResult> {
	try {
		const facts = await collectGitFacts(input.projectRoot, input.exec);
		const diffHash = await collectCompleteDiffHash(input.projectRoot, facts);
		const lockfiles = await collectLockfileHashesStrict(input.projectRoot);
		const configHash = await collectWorkbenchConfigHashStrict(input.projectRoot);
		const invocationHash = input.argvHash ?? executedArgvHash(input.argv ?? []);
		const binding: ValidationBinding = {
			schema_version: VALIDATION_BINDING_SCHEMA_VERSION,
			kind: "recipe",
			commit: facts.gitHead,
			diff_hash: diffHash,
			lockfiles,
			config_hash: configHash,
			gate_state_hash: effectiveGateSchemaHash(input.profile, input.projectGates),
			...(input.profile !== undefined ? { profile: input.profile } : {}),
			mode: input.mode,
			owner: ownerFromActorFacts(input.actorFacts),
			target: buildRecipeValidationTarget(input.recipe, invocationHash, input.projectRoot),
			outcome: { successful: input.successful, complete: input.complete, source: input.source },
		};
		return { ok: true, block: { schema_version: VALIDATION_EVIDENCE_SCHEMA_VERSION, binding, unavailable_reason: null } };
	} catch (error) {
		return { ok: false, reason: `validation evidence capture failed: ${String((error as Error).message ?? error).slice(0, MAX_UNAVAILABLE_REASON_CHARS)}` };
	}
}

export interface CaptureGateValidationInput {
	projectRoot: string;
	profile: string | undefined;
	mode: WorkbenchMode;
	exec: ExecFn;
	selector: string;
	/** requested gate ids (selector-expanded, before dependency ordering). */
	requestedGates: readonly string[];
	/** effective gate ids actually evaluated (dependency order). */
	effectiveGates: readonly string[];
	projectGates: readonly unknown[];
	/**
	 * Exact digest from the bounded stable gates.yaml snapshot used for this
	 * run. Required (including the explicit `missing` marker): gate capture
	 * never falls back to reopening gates.yaml after execution.
	 */
	trustedConfigFileDigest: TrustedWorkbenchConfigFileDigest;
	manualEvidence: Readonly<Record<string, string>>;
	workerFirstFacts?: WorkerFirstGateFacts;
	/** gateId → status only (sources/run ids are dropped by the hash). */
	prerequisiteStatus: Readonly<Record<string, string>>;
	/** External source authority identities used by evaluated checks. */
	sourceAuthority?: Readonly<Record<string, string>>;
	actorFacts?: RecipeMutationFacts;
	/** Strict current plan identity and selector coverage; omitted for historical/no-plan chains. */
	planReference?: Readonly<GatePlanValidationFacts>;
	/** overall gate PASS. */
	successful: boolean;
}

/**
 * Capture a gate-run validation binding after evaluation. FAILS CLOSED like
 * the recipe capture — a failed capture yields unavailable state, never a
 * partial binding. Never throws.
 */
export async function captureGateValidationEvidence(input: CaptureGateValidationInput): Promise<CaptureValidationResult> {
	try {
		if (input.trustedConfigFileDigest === undefined) {
			throw new Error("gate validation capture requires the trusted gates.yaml snapshot digest");
		}
		const facts = await collectGitFacts(input.projectRoot, input.exec);
		const diffHash = await collectCompleteDiffHash(input.projectRoot, facts);
		const lockfiles = await collectLockfileHashesStrict(input.projectRoot);
		const configHash = await collectWorkbenchConfigHashStrict(input.projectRoot, input.trustedConfigFileDigest);
		const binding: ValidationBinding = {
			schema_version: VALIDATION_BINDING_SCHEMA_VERSION,
			kind: "gate",
			commit: facts.gitHead,
			diff_hash: diffHash,
			lockfiles,
			config_hash: configHash,
			gate_state_hash: gateStateHash({
				profile: input.profile,
				projectGates: input.projectGates,
				manualEvidence: input.manualEvidence,
				workerFirstFacts: input.workerFirstFacts,
				actorFacts: input.actorFacts,
				prerequisiteStatus: input.prerequisiteStatus,
				sourceAuthority: input.sourceAuthority,
			}),
			...(input.profile !== undefined ? { profile: input.profile } : {}),
			mode: input.mode,
			owner: ownerFromActorFacts(input.actorFacts),
			target: buildGateValidationTarget(input.selector, input.requestedGates, input.effectiveGates, input.planReference),
			outcome: { successful: input.successful, complete: true, source: "gate" },
		};
		return { ok: true, block: { schema_version: VALIDATION_EVIDENCE_SCHEMA_VERSION, binding, unavailable_reason: null } };
	} catch (error) {
		return { ok: false, reason: `validation evidence capture failed: ${String((error as Error).message ?? error).slice(0, MAX_UNAVAILABLE_REASON_CHARS)}` };
	}
}

// ---------------------------------------------------------------------------
// Current-state collection (for the exact comparison)
// ---------------------------------------------------------------------------

export interface CollectValidationCurrentStateInput {
	projectRoot: string;
	profile: string | undefined;
	mode: WorkbenchMode;
	exec: ExecFn;
	projectGates: readonly unknown[];
	target: ValidationTarget;
	/** gate-state inputs; required for gate targets, ignored for recipe targets. */
	gateState?: {
		manualEvidence: Readonly<Record<string, string>>;
		workerFirstFacts?: WorkerFirstGateFacts;
		actorFacts?: RecipeMutationFacts;
		prerequisiteStatus: Readonly<Record<string, string>>;
		sourceAuthority?: Readonly<Record<string, string>>;
	};
}

/**
 * Collect the CURRENT validation state for the exact comparison. Fail
 * closed: any collection error yields `collectionFailed: true` with a
 * bounded reason — the comparison then refuses reuse.
 */
export async function collectValidationCurrentState(input: CollectValidationCurrentStateInput): Promise<ValidationCurrentState> {
	const failed = (reason: string): ValidationCurrentState => ({
		collectionFailed: true,
		collectionReason: reason.slice(0, MAX_UNAVAILABLE_REASON_CHARS),
		commit: null,
		diffHash: "",
		lockfiles: {},
		configHash: "",
		gateStateHash: "",
		...(input.profile !== undefined ? { profile: input.profile } : {}),
		mode: input.mode,
		target: input.target,
	});
	try {
		const facts = await collectGitFacts(input.projectRoot, input.exec);
		const diffHash = await collectCompleteDiffHash(input.projectRoot, facts);
		const lockfiles = await collectLockfileHashesStrict(input.projectRoot);
		const configHash = await collectWorkbenchConfigHashStrict(input.projectRoot);
		const gateStateHashValue =
			input.target.kind === "gate" && input.gateState
				? gateStateHash({
						profile: input.profile,
						projectGates: input.projectGates,
						manualEvidence: input.gateState.manualEvidence,
						workerFirstFacts: input.gateState.workerFirstFacts,
						actorFacts: input.gateState.actorFacts,
						prerequisiteStatus: input.gateState.prerequisiteStatus,
						sourceAuthority: input.gateState.sourceAuthority,
					})
				: effectiveGateSchemaHash(input.profile, input.projectGates);
		return {
			collectionFailed: false,
			collectionReason: null,
			commit: facts.gitHead,
			diffHash,
			lockfiles,
			configHash,
			gateStateHash: gateStateHashValue,
			...(input.profile !== undefined ? { profile: input.profile } : {}),
			mode: input.mode,
			target: input.target,
		};
	} catch (error) {
		return failed(`validation state collection failed: ${String((error as Error).message ?? error)}`);
	}
}

/**
 * Strict current-state assessment for a recipe source consumed by another
 * authority edge (for example a Gate artifact check). This deliberately
 * lives below validation-assessment.ts so gate-engine can call it without an
 * ESM import cycle. It applies the same parser, exact current-state collector
 * and reuse comparator as the Commander-facing assessment.
 */
export async function assessRecipeSourceValidation(input: {
	projectRoot: string;
	profile: string | undefined;
	mode: WorkbenchMode;
	exec: ExecFn;
	projectGates: readonly unknown[];
	recipe: Recipe;
	argvHash: unknown;
	validationEvidence: unknown;
}): Promise<ValidationReuseVerdict> {
	if (typeof input.argvHash !== "string" || !isSha256(input.argvHash)) {
		return { reusable: false, reasons: ["corrupt-binding"] };
	}
	const current = await collectValidationCurrentState({
		projectRoot: input.projectRoot,
		profile: input.profile,
		mode: input.mode,
		exec: input.exec,
		projectGates: input.projectGates,
		target: buildRecipeValidationTarget(input.recipe, input.argvHash, input.projectRoot),
	});
	return evaluateValidationReuse(input.validationEvidence, current);
}

// ---------------------------------------------------------------------------
// Pure fail-closed comparison
// ---------------------------------------------------------------------------

function sameLockfiles(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
	const aKeys = Object.keys(a).sort();
	const bKeys = Object.keys(b).sort();
	if (aKeys.length !== bKeys.length) return false;
	for (let i = 0; i < aKeys.length; i += 1) {
		const key = aKeys[i]!;
		if (key !== bKeys[i] || a[key] !== b[key]) return false;
	}
	return true;
}

function sameTarget(a: ValidationTarget, b: ValidationTarget): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "recipe") {
		if (b.kind !== "recipe") return false;
		return (
			a.name === b.name &&
			a.definition_hash === b.definition_hash &&
			a.invocation_hash === b.invocation_hash &&
			a.cwd === b.cwd
		);
	}
	if (b.kind !== "gate") return false;
	const aPlan = a.plan_reference;
	const bPlan = b.plan_reference;
	const samePlan = aPlan === undefined || bPlan === undefined
		? aPlan === bPlan
		: aPlan.plan_reference_hash === bPlan.plan_reference_hash &&
			aPlan.coverage === bPlan.coverage &&
			aPlan.required_gate_ids.length === bPlan.required_gate_ids.length &&
			aPlan.required_gate_ids.every((id, index) => id === bPlan.required_gate_ids[index]);
	return (
		samePlan &&
		a.selector === b.selector &&
		a.requested_gates.length === b.requested_gates.length &&
		a.effective_gates.length === b.effective_gates.length &&
		a.requested_gates.every((id, i) => id === b.requested_gates[i]) &&
		a.effective_gates.every((id, i) => id === b.effective_gates[i])
	);
}

/**
 * Pure exact comparison of a parsed, valid block against the current state.
 * Reusable ONLY when: valid block, successful, complete, owner sol and every
 * component exactly equal. Reasons accumulate in the fixed documented order;
 * source refusals short-circuit before component comparison.
 */
export function evaluateParsedValidationReuse(
	block: ValidationEvidenceBlock | null | undefined,
	current: ValidationCurrentState,
): ValidationReuseVerdict {
	if (!block) return { reusable: false, reasons: ["missing-binding"] };
	if (block.schema_version !== VALIDATION_EVIDENCE_SCHEMA_VERSION) return { reusable: false, reasons: ["legacy-binding"] };
	if (!block.binding) return { reusable: false, reasons: ["unavailable-binding"] };
	if (current.collectionFailed) return { reusable: false, reasons: ["collection-failure"] };
	const binding = block.binding;

	const reasons: ValidationRefusalReason[] = [];
	if (!binding.outcome.successful) reasons.push("unsuccessful-source");
	if (!binding.outcome.complete) reasons.push("incomplete-source");
	if (binding.owner !== "sol") reasons.push("non-sol-source");
	if (reasons.length > 0) return { reusable: false, reasons };

	if (binding.commit !== current.commit) reasons.push("commit-mismatch");
	if (binding.diff_hash !== current.diffHash) reasons.push("diff-mismatch");
	if (!sameLockfiles(binding.lockfiles, current.lockfiles)) reasons.push("dependencies-mismatch");
	if (binding.config_hash !== current.configHash) reasons.push("config-mismatch");
	if (binding.gate_state_hash !== current.gateStateHash) reasons.push("gate-state-mismatch");
	if ((binding.profile ?? undefined) !== (current.profile ?? undefined)) reasons.push("profile-mismatch");
	if (binding.mode !== current.mode) reasons.push("mode-mismatch");
	if (!sameTarget(binding.target, current.target)) reasons.push("target-mismatch");
	return { reusable: reasons.length === 0, reasons };
}

/**
 * Fail-closed entry point over the raw persisted value: missing → legacy →
 * corrupt → pure comparison. Never throws; never reuses on malformed input.
 */
export function evaluateValidationReuse(raw: unknown, current: ValidationCurrentState): ValidationReuseVerdict {
	if (raw === null || raw === undefined) return { reusable: false, reasons: ["missing-binding"] };
	if (typeof raw !== "object" || Array.isArray(raw)) return { reusable: false, reasons: ["corrupt-binding"] };
	const schemaVersion = (raw as Record<string, unknown>).schema_version;
	if (typeof schemaVersion !== "number" || schemaVersion !== VALIDATION_EVIDENCE_SCHEMA_VERSION) {
		// A structurally foreign value of any other version is legacy —
		// version mismatch dominates, deterministically.
		return { reusable: false, reasons: ["legacy-binding"] };
	}
	const parsed = parseValidationEvidenceBlock(raw);
	if (!parsed.ok) return { reusable: false, reasons: ["corrupt-binding"] };
	return evaluateParsedValidationReuse(parsed.block, current);
}
