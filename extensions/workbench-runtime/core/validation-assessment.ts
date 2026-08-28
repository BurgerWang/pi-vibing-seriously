/**
 * P4b validation assessment — the Commander-facing, strictly READ-ONLY
 * current-state reuse verdict for `workbench_read_run`.
 *
 * Every readable run yields exactly one explicit status, `REUSABLE` or
 * `RERUN_REQUIRED`, with fixed machine reason codes from the existing P4a
 * comparator (core/validation-evidence.ts). This module does NOT weaken or
 * duplicate P4a validation: it reuses the strict parser
 * (`parseValidationEvidenceBlock`), the current-state collector
 * (`collectValidationCurrentState`) and the pure exact comparator
 * (`evaluateValidationReuse`) unchanged.
 *
 * Observation only. Assessment NEVER:
 *   - skips or schedules recipe/gate execution. The WP4 runner may consume a
 *     REUSABLE verdict only for its closed DEV final-check contract; this
 *     module itself never consults or alters cache keys/decisions/hits/misses
 *     or run counts;
 *   - rewrites run artifacts (no file under runs/ is ever written);
 *   - appends session/delegation entries or mutates in-memory delegation
 *     authority (worker-first facts are supplied by the caller as a
 *     read-only projection — see index.ts `buildReadOnlyWorkerFirstGateFacts`).
 *
 * Target reconstruction:
 *   - recipe runs: the current target is rebuilt from the PERSISTED
 *     privacy-safe recipe identity (name + invocation hash) plus the
 *     CURRENTLY DECLARED recipe definition and normalized cwd. The
 *     persisted manifest's privacy-safe `argv_hash` MUST be a valid
 *     64-hex identity and MUST exactly equal the parsed binding's
 *     invocation hash — missing/malformed/mismatched invocation
 *     identities refuse reuse deterministically (`corrupt-binding`); raw
 *     argv is never read, re-derived, or rendered. A removed recipe
 *     fails closed (never reusable).
 *   - gate runs: the current selector/requested/effective target is
 *     reconstructed from the CURRENT EFFECTIVE CATALOG (a removed gate or
 *     a selector that today resolves to a different set is a
 *     target-mismatch); ONLY the source run's manual evidence needed to
 *     reproduce its privacy-safe hash is recovered from the persisted
 *     gate evidence (raw text is hashed and never rendered) — the
 *     persisted gates.json/evidence.json artifacts are strictly
 *     schema/identity/shape cross-checked (see
 *     readPersistedGateRunFacts in gate-engine.ts); current prerequisite
 *     statuses are re-resolved from the latest persisted gate runs;
 *     current actor/worker-first facts are hashed in.
 *
 * Fail-closed semantics:
 *   - missing/legacy/corrupt/unavailable bindings, failed/incomplete/
 *     non-Sol sources and collection failures refuse reuse with the fixed
 *     P4a reason codes — this module NEVER throws a reusable result;
 *   - malformed/missing gate source artifacts (gates.json / evidence.json)
 *     and config/catalog errors return `RERUN_REQUIRED` with
 *     `collection-failure`;
 *   - legacy records (no `validation_evidence`) stay readable and render
 *     `RERUN_REQUIRED — missing-binding`.
 *
 * Privacy: the assessment only ever surfaces bounded status + fixed reason
 * codes. Raw argv, manual evidence text, unavailable-reason prose, secrets
 * and full worker-first facts never leave this module.
 */

import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { loadProjectConfig, type ExecFn } from "./config.ts";
import { latestGateStatus, loadGates, readPersistedGateRunFacts } from "./gate-engine.ts";
import { orderGates, resolveSelector } from "./gate-schema.ts";
import type { WorkerFirstGateFacts } from "./gate-schema.ts";
import {
	readCurrentDelegationPlanAuthority,
	type CurrentDelegationPlanAuthority,
} from "./delegation-plan-reference.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import type { Recipe } from "./recipe-schema.ts";
import { latestRunAttemptForRecipe, readCommittedManifest, runDirFor, type RunRecord } from "./runs.ts";
import { ARTIFACT_MANIFEST_FILE, validateCommittedArtifactsV2 } from "./artifact-contract.ts";
import { RUN_COMMIT_FILE } from "./run-transaction.ts";
import { gateCandidateSourceAuthorityV1 } from "./candidate-binding.ts";
import {
	buildGateValidationTarget,
	buildRecipeValidationTarget,
	assessRecipeSourceValidation,
	collectValidationCurrentState,
	evaluateValidationReuse,
	parseValidationEvidenceBlock,
	validationEvidenceIdentity,
	validationEvidenceSourceEligible,
	VALIDATION_EVIDENCE_SCHEMA_VERSION,
	type GateValidationTarget,
	type GatePlanValidationFacts,
	type RecipeValidationTarget,
	type ValidationBinding,
	type ValidationEvidenceBlock,
	type ValidationRefusalReason,
} from "./validation-evidence.ts";
import type { RecipeMutationFacts } from "./worker-policy.ts";

/** Invocation-identity shape: a full lowercase hex SHA-256. */
const SHA256_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidationAssessmentStatus = "REUSABLE" | "RERUN_REQUIRED";

export interface RunValidationAssessment {
	status: ValidationAssessmentStatus;
	/** Empty when REUSABLE; otherwise the fixed-order P4a refusal reasons. */
	reasons: ValidationRefusalReason[];
}

export interface AssessRunValidationInput {
	projectRoot: string;
	/** CURRENT runtime mode — never the persisted manifest mode. */
	mode: WorkbenchMode;
	exec: ExecFn;
	/** The parsed, already-read run manifest (never rewritten). */
	manifest: RunRecord;
	/** Current actor facts (role/provider/model — same sources as gate runs). */
	actorFacts?: RecipeMutationFacts;
	/**
	 * Current worker-first facts (gate runs only). The caller MUST supply a
	 * read-only projection — the assessment itself never refreshes or
	 * persists delegation state.
	 */
	workerFirstFacts?: WorkerFirstGateFacts;
}

// ---------------------------------------------------------------------------
// Fixed fail-closed statuses
// ---------------------------------------------------------------------------

function rerun(reasons: readonly ValidationRefusalReason[]): RunValidationAssessment {
	return { status: "RERUN_REQUIRED", reasons: [...reasons] };
}

/**
 * Block-level dispatch over the raw persisted block — the exact P4a
 * precedence (missing → legacy → corrupt → unavailable), evaluated BEFORE
 * any current-state collection so legacy/malformed records stay readable
 * and cheap. Returns the parsed block only when a full comparison is
 * possible. Never throws.
 */
function parseBlockFailClosed(
	raw: unknown,
): { ok: true; block: ValidationEvidenceBlock } | { ok: false; reasons: ValidationRefusalReason[] } {
	if (raw === null || raw === undefined) return { ok: false, reasons: ["missing-binding"] };
	if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reasons: ["corrupt-binding"] };
	const schemaVersion = (raw as Record<string, unknown>).schema_version;
	if (typeof schemaVersion !== "number" || schemaVersion !== VALIDATION_EVIDENCE_SCHEMA_VERSION) {
		// A structurally foreign value of any other version is legacy —
		// version mismatch dominates, deterministically (same as P4a).
		return { ok: false, reasons: ["legacy-binding"] };
	}
	const parsed = parseValidationEvidenceBlock(raw);
	if (!parsed.ok) return { ok: false, reasons: ["corrupt-binding"] };
	if (!parsed.block.binding) return { ok: false, reasons: ["unavailable-binding"] };
	return parsed;
}

function gateTarget(binding: ValidationBinding): GateValidationTarget {
	if (binding.target.kind !== "gate") throw new Error("binding kind mismatch: expected a gate target");
	return binding.target;
}

function recipeTarget(binding: ValidationBinding): RecipeValidationTarget {
	if (binding.target.kind !== "recipe") throw new Error("binding kind mismatch: expected a recipe target");
	return binding.target;
}

/** Marker error: the current catalog cannot reproduce the source gate target. */
class GateTargetUnavailableError extends Error {
	constructor() {
		super("gate target cannot be reconstructed from the current effective catalog");
		this.name = "GateTargetUnavailableError";
	}
}

/**
 * Reconstruct the CURRENT gate target from the current effective catalog:
 * the persisted privacy-safe selector is re-resolved TODAY (profile
 * filtering included). A gate that no longer exists in the current
 * catalog — requested or effective — cannot be reproduced: target-mismatch.
 */
async function currentGateTarget(
	projectRoot: string,
	bindingTarget: GateValidationTarget,
	planAuthority: CurrentDelegationPlanAuthority,
): Promise<{
	target: GateValidationTarget;
}> {
	if (planAuthority.status === "blocked") {
		throw new Error(`current delegation plan authority is blocked: ${planAuthority.reason}`);
	}
	const gates = await loadGates(projectRoot);
	const requested = resolveSelector(bindingTarget.selector, gates);
	const known = new Set(gates.map((g) => g.id));
	const unknownRequested = requested.filter((id) => !known.has(id));
	const unknownEffective = bindingTarget.effective_gates.filter((id) => !known.has(id));
	const unavailablePlanGates = planAuthority.status === "current"
		? planAuthority.requiredGateIds.filter((id) => !known.has(id))
		: [];
	if (unknownRequested.length > 0 || unknownEffective.length > 0 || unavailablePlanGates.length > 0) {
		// A removed gate (or a profile that no longer loads it) makes the
		// source target irreproducible — fail closed, never reuse.
		throw new GateTargetUnavailableError();
	}
	const effective = orderGates(requested, gates);
	let planReference: GatePlanValidationFacts | undefined;
	if (planAuthority.status === "current") {
		const requiredGateIds = [...planAuthority.requiredGateIds].sort();
		const effectiveSet = new Set(effective);
		const fullyCovered = requiredGateIds.every((id) => effectiveSet.has(id));
		const selector = bindingTarget.selector.trim();
		const finalSelector = selector === "base" || selector === "all";
		if (finalSelector && !fullyCovered) throw new GateTargetUnavailableError();
		planReference = {
			plan_reference_hash: planAuthority.planReferenceHash,
			required_gate_ids: requiredGateIds,
			coverage: finalSelector && fullyCovered ? "FULL" : "PARTIAL",
		};
	}
	return { target: buildGateValidationTarget(bindingTarget.selector, requested, effective, planReference) };
}

/**
 * Re-resolve the CURRENT prerequisite statuses for every prerequisite the
 * source gate run resolved (the same latest-persisted resolution a fresh
 * gate run uses — since the source run itself is persisted, unchanged
 * state resolves to the same statuses; a newer run that changed a
 * prerequisite's status refuses reuse).
 */
async function currentPrerequisiteStatus(projectRoot: string, prerequisiteIds: readonly string[]): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const prereqId of prerequisiteIds) {
		const current = await latestGateStatus(projectRoot, prereqId);
		out[prereqId] = current?.status ?? "NOT_RUN";
	}
	return out;
}

/**
 * Re-resolve artifact authority edges exactly as a fresh artifact check
 * would: newest same-recipe attempt owns the answer, its committed identity
 * must parse, and its validation binding must remain currently REUSABLE.
 * Failure becomes a deterministic non-matching marker, never an old PASS.
 */
async function currentArtifactSourceAuthority(
	projectRoot: string,
	profile: string | undefined,
	mode: WorkbenchMode,
	exec: ExecFn,
	projectGates: readonly unknown[],
	recipes: readonly Recipe[],
	artifactExternalRoots: Readonly<Record<string, string>>,
	sources: readonly {
		checkId: string;
		recipe: string;
		runId: string;
		authorityDigest: string;
		freshness: "current" | "immutable-snapshot";
	}[],
): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const source of sources) {
		const key = `artifact:${source.checkId}:${source.recipe}`;
		if (source.freshness === "immutable-snapshot") {
			const manifest = await readCommittedManifest(projectRoot, source.runId);
			const digest = manifest ? validationEvidenceIdentity(manifest.validation_evidence) : null;
			if (
				!manifest
				|| manifest.recipe !== source.recipe
				|| digest !== source.authorityDigest
				|| !validationEvidenceSourceEligible(manifest.validation_evidence, { recipe: source.recipe, argvHash: manifest.argv_hash })
			) {
				out[key] = "unavailable:immutable-source-identity";
				continue;
			}
			const artifacts = await validateCommittedArtifactsV2(
				projectRoot,
				runDirFor(projectRoot, source.runId),
				source.runId,
				{ authorizedExternalRoots: artifactExternalRoots, exec },
			);
			out[key] = artifacts.ok
				? `${source.runId}:${digest}:immutable-snapshot`
				: `unavailable:immutable-${artifacts.code}`;
			continue;
		}
		const attempt = await latestRunAttemptForRecipe(projectRoot, source.recipe);
		if (attempt.state === "NOT_FOUND") {
			out[key] = "unavailable:no-run";
			continue;
		}
		if (attempt.state === "CORRUPT") {
			out[key] = "unavailable:corrupt-latest";
			continue;
		}
		const manifest = await readCommittedManifest(projectRoot, attempt.run_id);
		if (!manifest) {
			out[key] = "unavailable:corrupt-latest";
			continue;
		}
		const digest = validationEvidenceIdentity(manifest.validation_evidence);
		if (
			manifest.recipe !== source.recipe
			|| !digest
			|| !validationEvidenceSourceEligible(manifest.validation_evidence, { recipe: source.recipe, argvHash: manifest.argv_hash })
		) {
			out[key] = "unavailable:missing-binding";
			continue;
		}
		const recipe = recipes.find((candidate) => candidate.name === source.recipe);
		if (!recipe || manifest.recipe === "gate") {
			out[key] = "unavailable:source-recipe-missing";
			continue;
		}
		const assessment = await assessRecipeSourceValidation({
			projectRoot,
			profile,
			mode,
			exec,
			projectGates,
			recipe,
			argvHash: manifest.argv_hash,
			validationEvidence: manifest.validation_evidence,
		});
		out[key] = assessment.reusable
			? `${manifest.run_id}:${digest}:current`
			: `unavailable:${assessment.reasons.join(",") || "not-reusable"}`;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Assessment (fail-closed, never throws)
// ---------------------------------------------------------------------------

/**
 * Assess the persisted validation evidence of one run against the current
 * trusted project/runtime state. NEVER throws: every error path (config/
 * catalog errors, missing/malformed source artifacts, collection errors)
 * returns `RERUN_REQUIRED` with the closest fixed refusal code.
 */
export async function assessRunValidation(input: AssessRunValidationInput): Promise<RunValidationAssessment> {
	try {
		return await assessRunValidationInner(input);
	} catch (error) {
		if (error instanceof GateTargetUnavailableError) return rerun(["target-mismatch"]);
		return rerun(["collection-failure"]);
	}
}

async function assessRunValidationInner(input: AssessRunValidationInput): Promise<RunValidationAssessment> {
	let manifest = input.manifest;
	const runDir = runDirFor(input.projectRoot, input.manifest.run_id);
	let hasV2DiskMarker = input.manifest.run_transaction_schema_version === 2;
	if (!hasV2DiskMarker) {
		for (const marker of [RUN_COMMIT_FILE, ARTIFACT_MANIFEST_FILE]) {
			try {
				await lstat(join(runDir, marker));
				hasV2DiskMarker = true;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return rerun(["collection-failure"]);
			}
		}
	}
	if (hasV2DiskMarker) {
		const committed = await readCommittedManifest(input.projectRoot, input.manifest.run_id);
		if (!committed) return rerun(["collection-failure"]);
		manifest = committed;
	}

	const parsed = parseBlockFailClosed(manifest.validation_evidence);
	if (!parsed.ok) return rerun(parsed.reasons);
	const binding = parsed.block.binding!;

	// The manifest kind and the binding kind must agree — a contradiction
	// is corrupt evidence, never reusable.
	const isGateRun = manifest.recipe === "gate";
	if (isGateRun !== (binding.kind === "gate")) return rerun(["corrupt-binding"]);

	// Current trusted config: profile, declared recipes, raw project gates.
	// Malformed config never throws here — issues are collected — but any
	// read failure propagates to the fail-closed wrapper.
	const config = await loadProjectConfig(input.projectRoot, { trusted: true });

	let target: Parameters<typeof collectValidationCurrentState>[0]["target"];
	let gateState: Parameters<typeof collectValidationCurrentState>[0]["gateState"];

	if (binding.kind === "gate") {
		const sourceTarget = gateTarget(binding);
		const planAuthority = await readCurrentDelegationPlanAuthority(
			input.projectRoot,
			input.workerFirstFacts?.latestDelegationId,
		);
		const rebuilt = await currentGateTarget(input.projectRoot, sourceTarget, planAuthority);
		target = rebuilt.target;

		// Recover ONLY the source run's manual evidence needed to reproduce
		// its privacy-safe hash from the persisted gate evidence. Missing or
		// malformed source artifacts, foreign schema versions, contradictory
		// gates/evidence/manifest identity facts (run id, requested set,
		// profile/mode, gate/check shapes) or a record that contradicts the
		// binding's own requested/effective gates fail closed.
		const sourceFacts = await readPersistedGateRunFacts(input.projectRoot, manifest.run_id, manifest);
		if (!sourceFacts) return rerun(["collection-failure"]);
		if (
			[...new Set(sourceFacts.requested)].sort().join("\u0000") !== [...sourceTarget.requested_gates].sort().join("\u0000") ||
			sourceFacts.gates.map((g) => g.id).sort().join("\u0000") !== [...sourceTarget.effective_gates].sort().join("\u0000")
		) {
			// The persisted gate artifacts contradict the persisted binding —
			// the source run cannot be faithfully reconstructed.
			return rerun(["collection-failure"]);
		}

		const prerequisiteIds = [...new Set(sourceFacts.gates.flatMap((g) => Object.keys(g.prerequisiteStatus)))];
		const sourceAuthority = await currentArtifactSourceAuthority(
			input.projectRoot,
			config.profile,
			input.mode,
			input.exec,
			config.gates,
			config.recipes,
			config.artifactExternalRoots,
			sourceFacts.artifactSources,
		);
		if (sourceFacts.candidateBinding !== undefined) {
			sourceAuthority.candidate = gateCandidateSourceAuthorityV1(sourceFacts.candidateBinding);
		}
		gateState = {
			manualEvidence: sourceFacts.manualEvidence,
			workerFirstFacts: input.workerFirstFacts,
			actorFacts: input.actorFacts,
			prerequisiteStatus: await currentPrerequisiteStatus(input.projectRoot, prerequisiteIds),
			sourceAuthority,
		};
	} else {
		const sourceTarget = recipeTarget(binding);
		// Invocation identity (P4b): the PERSISTED manifest's privacy-safe
		// argv_hash must be a valid 64-hex identity and must EXACTLY equal
		// the parsed binding's invocation hash — the same identity persisted
		// in two places must agree, otherwise the source run cannot be
		// faithfully reconstructed. Missing/malformed/mismatched identities
		// are corrupt evidence and refuse reuse deterministically. Raw argv
		// is never read, re-derived, or rendered.
		const manifestArgvHash = manifest.argv_hash;
		if (typeof manifestArgvHash !== "string" || !SHA256_RE.test(manifestArgvHash)) {
			return rerun(["corrupt-binding"]);
		}
		if (manifestArgvHash !== sourceTarget.invocation_hash) {
			return rerun(["corrupt-binding"]);
		}
		// The CURRENT target is the persisted recipe identity (name +
		// invocation hash) plus the CURRENTLY DECLARED definition and
		// normalized cwd. A removed recipe cannot be reconstructed.
		const currentRecipe: Recipe | undefined = config.recipes.find((r) => r.name === sourceTarget.name);
		if (!currentRecipe) return rerun(["target-mismatch"]);
		target = buildRecipeValidationTarget(currentRecipe, sourceTarget.invocation_hash, input.projectRoot);
		gateState = undefined;
	}

	const current = await collectValidationCurrentState({
		projectRoot: input.projectRoot,
		profile: config.profile,
		mode: input.mode,
		exec: input.exec,
		projectGates: config.gates,
		target,
		gateState,
	});

	const verdict = evaluateValidationReuse(manifest.validation_evidence, current);
	return {
		status: verdict.reusable ? "REUSABLE" : "RERUN_REQUIRED",
		reasons: verdict.reasons,
	};
}
