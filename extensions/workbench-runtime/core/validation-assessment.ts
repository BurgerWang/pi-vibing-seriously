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
 *   - skips or schedules recipe/gate execution (the P6-C action cache
 *     still decides execution exactly as before; this module never
 *     consults or alters cache keys/decisions/hits/misses/run counts);
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

import { loadProjectConfig, type ExecFn } from "./config.ts";
import { latestGateStatus, loadGates, readPersistedGateRunFacts } from "./gate-engine.ts";
import { orderGates, resolveSelector } from "./gate-schema.ts";
import type { WorkerFirstGateFacts } from "./gate-schema.ts";
import type { WorkbenchMode } from "./mode-policy.ts";
import type { Recipe } from "./recipe-schema.ts";
import type { RunRecord } from "./runs.ts";
import {
	buildGateValidationTarget,
	buildRecipeValidationTarget,
	collectValidationCurrentState,
	evaluateValidationReuse,
	parseValidationEvidenceBlock,
	VALIDATION_EVIDENCE_SCHEMA_VERSION,
	type GateValidationTarget,
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
async function currentGateTarget(projectRoot: string, bindingTarget: GateValidationTarget): Promise<{
	target: GateValidationTarget;
}> {
	const gates = await loadGates(projectRoot);
	const requested = resolveSelector(bindingTarget.selector, gates);
	const known = new Set(gates.map((g) => g.id));
	const unknownRequested = requested.filter((id) => !known.has(id));
	const unknownEffective = bindingTarget.effective_gates.filter((id) => !known.has(id));
	if (unknownRequested.length > 0 || unknownEffective.length > 0) {
		// A removed gate (or a profile that no longer loads it) makes the
		// source target irreproducible — fail closed, never reuse.
		throw new GateTargetUnavailableError();
	}
	const effective = orderGates(requested, gates);
	return { target: buildGateValidationTarget(bindingTarget.selector, requested, effective) };
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
	const parsed = parseBlockFailClosed(input.manifest.validation_evidence);
	if (!parsed.ok) return rerun(parsed.reasons);
	const binding = parsed.block.binding!;

	// The manifest kind and the binding kind must agree — a contradiction
	// is corrupt evidence, never reusable.
	const isGateRun = input.manifest.recipe === "gate";
	if (isGateRun !== (binding.kind === "gate")) return rerun(["corrupt-binding"]);

	// Current trusted config: profile, declared recipes, raw project gates.
	// Malformed config never throws here — issues are collected — but any
	// read failure propagates to the fail-closed wrapper.
	const config = await loadProjectConfig(input.projectRoot, { trusted: true });

	let target: Parameters<typeof collectValidationCurrentState>[0]["target"];
	let gateState: Parameters<typeof collectValidationCurrentState>[0]["gateState"];

	if (binding.kind === "gate") {
		const sourceTarget = gateTarget(binding);
		const rebuilt = await currentGateTarget(input.projectRoot, sourceTarget);
		target = rebuilt.target;

		// Recover ONLY the source run's manual evidence needed to reproduce
		// its privacy-safe hash from the persisted gate evidence. Missing or
		// malformed source artifacts, foreign schema versions, contradictory
		// gates/evidence/manifest identity facts (run id, requested set,
		// profile/mode, gate/check shapes) or a record that contradicts the
		// binding's own requested/effective gates fail closed.
		const sourceFacts = await readPersistedGateRunFacts(input.projectRoot, input.manifest.run_id, input.manifest);
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
		gateState = {
			manualEvidence: sourceFacts.manualEvidence,
			workerFirstFacts: input.workerFirstFacts,
			actorFacts: input.actorFacts,
			prerequisiteStatus: await currentPrerequisiteStatus(input.projectRoot, prerequisiteIds),
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
		const manifestArgvHash = input.manifest.argv_hash;
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

	const verdict = evaluateValidationReuse(input.manifest.validation_evidence, current);
	return {
		status: verdict.reusable ? "REUSABLE" : "RERUN_REQUIRED",
		reasons: verdict.reasons,
	};
}
