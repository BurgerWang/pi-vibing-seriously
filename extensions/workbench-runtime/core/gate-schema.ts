/**
 * Workbench gate schema — gate and check declarations (gates.yaml), strict
 * parsing, and catalog merging. Pure logic, no Pi imports.
 *
 * A gate is a named validation stage with a list of checks. Every check is
 * one of:
 *
 *   - config   machine: workbench config parses without issues
 *   - recipe   machine: a declared recipe runs and exits as expected
 *   - artifact machine: the most recent run of a recipe produced artifacts
 *   - file     machine: a project file (or one of several) exists; the
 *               path/glob resolves against the effective project root.
 *               The built-in b0.4 workbench-config check is the single
 *               exception: it carries internal catalog-only `file_root`
 *               metadata (never settable from gates.yaml) so it anchors at
 *               the repository root, where .pi/workbench always lives
 *   - json     machine: a JSON artifact field exists / equals a value
 *   - numeric  machine: a JSON artifact number is finite and within bounds
 *   - schema   machine: an artifact conforms to a built-in schema
 *               (quant-result — the workbench validates output, it never
 *               computes strategy metrics itself)
 *   - manual   human: explicit manual evidence is required (never inferred
 *               from model prose; always recorded as type "manual")
 *   - worker-first machine: a bounded injected WorkerFirstGateFacts object
 *               (constructed by the runtime from actor/policy/lease/
 *               delegation/review facts — never from model prose). Missing
 *               facts are NOT_RUN; negative compliance facts are FAIL (or
 *               BLOCKED when the runtime marks the evaluation blocked, e.g.
 *               by a pending/stale review); a required NOT_RUN can never
 *               make the gate PASS.
 *
 * Status model (spec §3): PASS | FAIL | BLOCKED | NOT_RUN only.
 * Rules enforced by the engine:
 *   - a required check that is NOT_RUN can never make a gate PASS
 *   - a FAILED/BLOCKED/NOT_RUN blocking prerequisite BLOCKs dependents
 *   - warnings never upgrade a status; a check with no verified assertion
 *     is NOT_RUN or FAIL, never PASS
 *   - numeric constraints are only ever evaluated against structured
 *     artifacts (JSON files), never against natural-language statements
 */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import type { ActorRole, LeaseReason, LeaseStatus, WritePolicy } from "./write-authority.ts";
import type { DelegationReviewStatus } from "./delegation-state.ts";

export type CheckKind = "config" | "recipe" | "artifact" | "file" | "json" | "numeric" | "manual" | "schema" | "worker-first";

export type GateStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";

export const GATE_STATUSES: readonly GateStatus[] = ["PASS", "FAIL", "BLOCKED", "NOT_RUN"];

/** Quant gate ids follow /^q\d+$/ and only load for quant profiles by default. */
export const QUANT_GATE_ID_RE = /^q\d+$/;

export const QUANT_PROFILES: readonly string[] = [
	"quant-research/stock-selection",
	"quant-research/market-timing",
];

// ---------------------------------------------------------------------------
// P7 worker-first gate facts (bounded injected object, never model prose)
// ---------------------------------------------------------------------------

/**
 * The eight machine-backed worker-first compliance assertions. Each maps to
 * exactly one fact (or a small group of facts) in WorkerFirstGateFacts.
 */
export type WorkerFirstCheckName =
	| "strict-policy-active"
	| "no-unauthorized-commander-writes"
	| "no-pending-review"
	| "no-stale-review"
	| "reviewed-hash-matches-current"
	| "worker-paths-within-contracts"
	| "no-active-unexplained-lease"
	| "commander-initiated-final-verification";

export const WORKER_FIRST_CHECK_NAMES: readonly WorkerFirstCheckName[] = [
	"strict-policy-active",
	"no-unauthorized-commander-writes",
	"no-pending-review",
	"no-stale-review",
	"reviewed-hash-matches-current",
	"worker-paths-within-contracts",
	"no-active-unexplained-lease",
	"commander-initiated-final-verification",
];

/**
 * Bounded worker-first compliance facts injected by the runtime into every
 * gate run (slash command AND model tool). The gate engine never reads
 * model prose or prompts for these checks — missing facts are NOT_RUN.
 */
export interface WorkerFirstGateFacts {
	schema_version: 1;
	/**
	 * When set, the runtime could not evaluate compliance (final
	 * verification is blocked — e.g. a pending/stale worker review): every
	 * worker-first check evaluates BLOCKED with this reason.
	 */
	blockedReason?: string;
	/** Resolved actor of the session that initiated this gate run. */
	actor: ActorRole | null;
	/** worker-first-strict for approved Sol; null when not applicable. */
	writePolicy: WritePolicy | null;
	/** True when commander edit/write is hard-denied right now. */
	commanderWritesDenied: boolean | null;
	/** Bounded counter of every blocked strict-Sol edit/write attempt. */
	blockedCommanderWriteAttempts: number | null;
	/** True when at least one delegation exists. */
	hasDelegation: boolean | null;
	latestDelegationId: string | null;
	reviewStatus: DelegationReviewStatus | null;
	currentDiffHash: string | null;
	reviewedDiffHash: string | null;
	/** Verdict of the latest completed review (null = none yet). */
	reviewVerdict: "PASS" | "FAIL" | null;
	/** Violation count of the latest completed review (null = none yet). */
	reviewViolationCount: number | null;
	leaseStatus: LeaseStatus | null;
	/** Audited fixed lease reason (ALLOWED_LEASE_REASONS); null = locked. */
	leaseReason: LeaseReason | null;
	leaseCallsUsed: number | null;
	leaseMaxCalls: number | null;
	/** True when this gate run was initiated by the approved Sol commander. */
	gateRunInitiatedByCommander: boolean | null;
	/**
	 * Optional current delegation plan identity. These fields are omitted for
	 * historical/no-plan chains so their existing worker-facts hash remains
	 * compatible. They are derived only from a strict committed v2 contract.
	 */
	planReferenceHash?: string;
	requiredGateIds?: string[];
	planReferenceCurrent?: boolean;
	/** Fixed machine reason; never plan prose or file content. */
	planReferenceBlockedReason?: string;
}

export interface GateCheck {
	id: string;
	title: string;
	description: string;
	required: boolean;
	blocking: boolean;
	kind: CheckKind;
	/** kind=recipe: single recipe name. */
	recipe?: string;
	/** kind=recipe: alternative recipe names; the first DECLARED one runs. */
	recipes?: string[];
	/** kind=file: single project-relative path/glob. */
	path?: string;
	/** kind=file: any-of project-relative paths/globs. */
	any_of?: string[];
	/**
	 * INTERNAL catalog-only metadata (never settable from gates.yaml):
	 * anchors this kind=file check at the REPOSITORY root instead of the
	 * effective project root. Only the built-in catalog may set it — the
	 * b0.4 "Required workbench files present" check uses it because the
	 * workbench configuration (.pi/workbench) always lives at the
	 * repository root, so a nested `.pi/workbench` can never satisfy it.
	 * parseCheck never reads or returns this field, and CHECK_FIELDS
	 * rejects both `root` and `file_root` from YAML as unknown fields.
	 */
	file_root?: "repository";
	/** kind=artifact: recipe whose most recent run must have artifacts. */
	artifact_recipe?: string;
	/** kind=artifact: optional glob filter over that run's artifact_paths. */
	artifact_glob?: string;
	/** kind=json|numeric|schema: project-relative artifact path. */
	json_file?: string;
	/** kind=json|numeric: dot path into the artifact (arrays support `.length`). */
	json_path?: string;
	/** kind=json: the field must deep-equal this value. */
	json_equals?: unknown;
	/** kind=json: at least one of these dot paths must exist. */
	json_any_of_paths?: string[];
	/** kind=numeric: inclusive bounds. */
	numeric_min?: number;
	numeric_max?: number;
	/** kind=manual: what human evidence is required. */
	manual_prompt?: string;
	/** kind=schema: built-in schema name ("quant-result" or strict "quant-research"). */
	schema_name?: string;
	/** kind=worker-first: which machine-backed compliance assertion to evaluate. */
	worker_first?: WorkerFirstCheckName;
}

export interface Gate {
	id: string;
	title: string;
	description: string;
	/** Empty = universal; otherwise the gate only loads for these profiles. */
	profiles: string[];
	prerequisites: string[];
	required: boolean;
	/** A non-PASS outcome of this gate BLOCKs gates that list it as prerequisite. */
	blocking: boolean;
	/** Declared evidence locations (project-relative globs), recorded in gates.json. */
	evidence: string[];
	acceptance: string;
	checks: GateCheck[];
	source: "catalog" | "project";
}

export interface GateParseResult {
	gates: Gate[];
	errors: string[];
}

// ---------------------------------------------------------------------------
// gates.yaml parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, label: string, errors: string[]): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		errors.push(`${label} must be a non-empty string`);
		return undefined;
	}
	return value;
}

function asStringArray(value: unknown, label: string, errors: string[]): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		errors.push(`${label} must be an array of strings`);
		return [];
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || item.trim().length === 0) {
			errors.push(`${label} entries must be non-empty strings`);
			continue;
		}
		out.push(item);
	}
	return out;
}

function asBoolean(value: unknown, fallback: boolean, label: string, errors: string[]): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") {
		errors.push(`${label} must be a boolean`);
		return fallback;
	}
	return value;
}

function asFiniteNumber(value: unknown, label: string, errors: string[]): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		errors.push(`${label} must be a finite number`);
		return undefined;
	}
	return value;
}

const CHECK_KINDS: readonly string[] = [
	"config",
	"recipe",
	"artifact",
	"file",
	"json",
	"numeric",
	"manual",
	"schema",
	"worker-first",
];

const CHECK_FIELDS: ReadonlySet<string> = new Set([
	"id",
	"title",
	"description",
	"required",
	"blocking",
	"kind",
	"recipe",
	"recipes",
	"file",
	"path",
	"any_of",
	// `root` and `file_root` are deliberately ABSENT: root selection is
	// internal catalog metadata (GateCheck.file_root) that YAML cannot set.
	"artifact_recipe",
	"glob",
	"equals",
	"any_of_paths",
	"min",
	"max",
	"prompt",
	"schema",
	"worker_first",
]);

/** Parse one raw check mapping into a validated GateCheck (or errors). */
export function parseCheck(raw: unknown, gateId: string, index: number): { check?: GateCheck; errors: string[] } {
	const errors: string[] = [];
	if (!isRecord(raw)) {
		return { errors: [`gate "${gateId}": check #${index + 1} must be a mapping`] };
	}
	const label = `gate "${gateId}" check #${index + 1}`;
	for (const key of Object.keys(raw)) {
		if (!CHECK_FIELDS.has(key)) {
			errors.push(`${label}: unknown field "${key}"`);
		}
	}
	const id = asString(raw.id, `${label}: "id"`, errors);
	const kindRaw = raw.kind;
	if (typeof kindRaw !== "string" || !CHECK_KINDS.includes(kindRaw)) {
		errors.push(`${label}: "kind" must be one of ${CHECK_KINDS.join(", ")}`);
		return { errors };
	}
	const kind = kindRaw as CheckKind;

	const recipe = asString(raw.recipe, `${label}: "recipe"`, errors);
	const recipes = asStringArray(raw.recipes, `${label}: "recipes"`, errors);
	if (kind === "recipe" && recipe === undefined && recipes.length === 0) {
		errors.push(`${label}: kind=recipe needs "recipe" or "recipes"`);
	}

	const path = asString(raw.path, `${label}: "path"`, errors);
	const anyOf = asStringArray(raw.any_of, `${label}: "any_of"`, errors);
	if (kind === "file" && path === undefined && anyOf.length === 0) {
		errors.push(`${label}: kind=file needs "path" or "any_of"`);
	}
	// Root selection is INTERNAL catalog metadata (GateCheck.file_root) —
	// parseCheck never reads it from YAML. Both `root` and `file_root` fail
	// the CHECK_FIELDS unknown-field check above, so a project gates.yaml
	// can never anchor a check at the repository root.

	const artifactRecipe = asString(raw.artifact_recipe, `${label}: "artifact_recipe"`, errors);
	if (kind === "artifact" && artifactRecipe === undefined) {
		errors.push(`${label}: kind=artifact needs "artifact_recipe"`);
	}
	const artifactGlob = asString(raw.glob, `${label}: "glob"`, errors);

	const file = asString(raw.file, `${label}: "file"`, errors);
	if ((kind === "json" || kind === "numeric" || kind === "schema") && file === undefined) {
		errors.push(`${label}: kind=${kind} needs "file"`);
	}
	// For kind=json/numeric the field path is declared with "path" (the same
	// key as kind=file, unambiguous because the kind selects the meaning).
	// kind=json also accepts "any_of_paths" as an alternative to "path".
	const jsonPath = asString(raw.path, `${label}: "path"`, errors);
	if (kind === "json" || kind === "numeric") {
		const anyOfPaths = asStringArray(raw.any_of_paths, `${label}: "any_of_paths"`, errors);
		if (jsonPath === undefined && anyOfPaths.length === 0) {
			errors.push(`${label}: kind=${kind} needs "path" (or "any_of_paths" for kind=json)`);
		}
		if (kind === "json" && anyOfPaths.length > 0 && jsonPath !== undefined) {
			errors.push(`${label}: use either "path" or "any_of_paths", not both`);
		}
		if (kind === "numeric" && anyOfPaths.length > 0) {
			errors.push(`${label}: "any_of_paths" is only valid for kind=json`);
		}
	}
	const jsonEquals = raw.equals;
	if (kind === "json" && jsonEquals !== undefined && jsonPath === undefined) {
		errors.push(`${label}: "equals" requires "path"`);
	}
	const anyOfPaths: string[] = [];
	if (kind === "json") {
		anyOfPaths.push(...asStringArray(raw.any_of_paths, `${label}: "any_of_paths"`, errors));
	}
	const min = asFiniteNumber(raw.min, `${label}: "min"`, errors);
	const max = asFiniteNumber(raw.max, `${label}: "max"`, errors);
	if (kind !== "numeric" && (raw.min !== undefined || raw.max !== undefined)) {
		errors.push(`${label}: "min"/"max" are only valid for kind=numeric`);
	}
	if (min !== undefined && max !== undefined && min > max) {
		errors.push(`${label}: "min" must be <= "max"`);
	}
	const manualPrompt = asString(raw.prompt, `${label}: "prompt"`, errors);
	const schemaName = asString(raw.schema, `${label}: "schema"`, errors);
	if (kind === "schema" && schemaName === undefined) {
		errors.push(`${label}: kind=schema needs "schema" (built-in: quant-result, quant-research)`);
	}
	const workerFirst = asString(raw.worker_first, `${label}: "worker_first"`, errors);
	if (kind === "worker-first") {
		if (workerFirst === undefined || !WORKER_FIRST_CHECK_NAMES.includes(workerFirst as WorkerFirstCheckName)) {
			errors.push(`${label}: kind=worker-first needs "worker_first" set to one of ${WORKER_FIRST_CHECK_NAMES.join(", ")}`);
		}
	} else if (raw.worker_first !== undefined) {
		errors.push(`${label}: "worker_first" is only valid for kind=worker-first`);
	}

	const checkId = id ?? `${gateId}.${index + 1}`;
	const title = asString(raw.title, `${label}: "title"`, errors) ?? checkId;
	const required = asBoolean(raw.required, true, `${label}: "required"`, errors);
	const blocking = asBoolean(raw.blocking, true, `${label}: "blocking"`, errors);

	if (errors.length > 0) return { errors };

	const check: GateCheck = {
		id: checkId,
		title,
		description: typeof raw.description === "string" ? raw.description : "",
		required,
		blocking,
		kind,
		recipe,
		recipes: recipes.length > 0 ? recipes : undefined,
		path,
		any_of: anyOf.length > 0 ? anyOf : undefined,
		artifact_recipe: artifactRecipe,
		artifact_glob: artifactGlob,
		json_file: file,
		json_path: jsonPath,
		json_equals: jsonEquals,
		json_any_of_paths: anyOfPaths.length > 0 ? anyOfPaths : undefined,
		numeric_min: min,
		numeric_max: max,
		manual_prompt: manualPrompt,
		schema_name: schemaName,
		worker_first: kind === "worker-first" ? (workerFirst as WorkerFirstCheckName) : undefined,
	};
	return { check, errors };
}

const GATE_FIELDS: ReadonlySet<string> = new Set([
	"id",
	"title",
	"description",
	"profiles",
	"prerequisites",
	"required",
	"blocking",
	"evidence",
	"acceptance",
	"checks",
]);

/** Parse one raw gate mapping into a validated Gate (or errors). */
export function parseGate(raw: unknown, index: number): { gate?: Gate; errors: string[] } {
	const errors: string[] = [];
	if (!isRecord(raw)) {
		return { errors: [`gate #${index + 1} must be a mapping`] };
	}
	const label = `gate #${index + 1}`;
	for (const key of Object.keys(raw)) {
		if (!GATE_FIELDS.has(key)) {
			errors.push(`${label}: unknown field "${key}"`);
		}
	}
	const id = asString(raw.id, `${label}: "id"`, errors);
	if (id === undefined) return { errors };
	const title = asString(raw.title, `gate "${id}": "title"`, errors) ?? id;
	const description = typeof raw.description === "string" ? raw.description : "";
	const profiles = asStringArray(raw.profiles, `gate "${id}": "profiles"`, errors);
	const prerequisites = asStringArray(raw.prerequisites, `gate "${id}": "prerequisites"`, errors);
	const evidence = asStringArray(raw.evidence, `gate "${id}": "evidence"`, errors);
	const acceptance = asString(raw.acceptance, `gate "${id}": "acceptance"`, errors) ?? "";
	const required = asBoolean(raw.required, true, `gate "${id}": "required"`, errors);
	const blocking = asBoolean(raw.blocking, true, `gate "${id}": "blocking"`, errors);

	const checks: GateCheck[] = [];
	const checksRaw = raw.checks;
	if (!Array.isArray(checksRaw)) {
		errors.push(`gate "${id}": "checks" must be an array`);
	} else {
		const seen = new Set<string>();
		checksRaw.forEach((rawCheck, i) => {
			const result = parseCheck(rawCheck, id, i);
			errors.push(...result.errors);
			const check = result.check;
			if (!check) return;
			if (seen.has(check.id)) {
				errors.push(`gate "${id}": duplicate check id "${check.id}"`);
				return;
			}
			seen.add(check.id);
			checks.push(check);
		});
	}

	if (errors.length > 0 || checks.length === 0) {
		if (errors.length === 0) errors.push(`gate "${id}": at least one check is required`);
		return { errors };
	}

	return {
		errors,
		gate: {
			id,
			title,
			description,
			profiles,
			prerequisites,
			required,
			blocking,
			evidence,
			acceptance,
			checks,
			source: "project",
		},
	};
}

/**
 * Parse a gates.yaml document: a mapping with a `gates` list (or a bare
 * list). Returns validated gates plus document-level errors.
 */
export function parseGatesDocument(doc: unknown): GateParseResult {
	if (doc === null || doc === undefined) return { gates: [], errors: [] };
	let list: unknown[];
	if (Array.isArray(doc)) {
		list = doc;
	} else if (isRecord(doc) && Array.isArray(doc.gates)) {
		list = doc.gates;
	} else {
		return { gates: [], errors: ['gates.yaml root must be a list or a mapping with a "gates" key'] };
	}
	const gates: Gate[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();
	list.forEach((raw, index) => {
		const result = parseGate(raw, index);
		errors.push(...result.errors);
		const gate = result.gate;
		if (!gate) return;
		if (seen.has(gate.id)) {
			errors.push(`duplicate gate id "${gate.id}"`);
			return;
		}
		seen.add(gate.id);
		gates.push(gate);
	});
	return { gates, errors };
}

// ---------------------------------------------------------------------------
// Effective catalog: built-ins + project overrides, filtered by profile
// ---------------------------------------------------------------------------

/**
 * Merge the project's gates.yaml definitions with the built-in catalog.
 * A project gate with a built-in id REPLACES the built-in entirely, except
 * for the reserved machine-backed B6 safety gate. B6 cannot be overridden:
 * silently weakening universal development-safety checks would manufacture
 * authority, so callers must surface the thrown setup error fail-closed.
 * catalog gates not mentioned in the yaml are kept; new ids are added.
 * Then filter by the project profile:
 *   - gates with an explicit `profiles` list only load for those profiles
 *   - quant gates (id /^q\d+$/) without a `profiles` list only load for
 *     quant profiles — the "quant profile 才加载 Q Gates" rule
 *   - base gates without a `profiles` list are universal
 */
export function effectiveGates(profile: string | undefined, catalog: readonly Gate[], projectGates: readonly Gate[]): Gate[] {
	const byId = new Map<string, Gate>();
	for (const gate of catalog) byId.set(gate.id, gate);
	for (const gate of projectGates) {
		if (gate.id === "b6" && byId.get("b6")?.source === "catalog") {
			throw new Error('gate "b6" is reserved and cannot override the built-in development-safety gate');
		}
		byId.set(gate.id, gate);
	}

	const profileName = profile ?? "";
	const isQuantProfile = QUANT_PROFILES.includes(profileName);
	const out: Gate[] = [];
	for (const gate of byId.values()) {
		if (gate.profiles.length > 0) {
			if (!gate.profiles.includes(profileName)) continue;
		} else if (QUANT_GATE_ID_RE.test(gate.id) && !isQuantProfile) {
			continue;
		}
		out.push(gate);
	}
	// P6-B: deterministic order — gate id sort, never YAML key order. The
	// built-in ladder (b0..b5, q0..q5) keeps its natural order; project gates
	// with custom ids land in a stable position regardless of gates.yaml key
	// order. Execution order is decided separately by orderGates (topological).
	return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Resolve a gate selector ("b0", "base", "quant", "all", "b0,b1") to ids. */
export function resolveSelector(selector: string, gates: readonly Gate[]): string[] {
	const token = selector.trim();
	if (token === "all") return gates.map((g) => g.id);
	if (token === "base") return gates.filter((g) => !QUANT_GATE_ID_RE.test(g.id)).map((g) => g.id);
	if (token === "quant") return gates.filter((g) => QUANT_GATE_ID_RE.test(g.id)).map((g) => g.id);
	const ids = token.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
	return ids;
}

/**
 * Topological prerequisite closure (stable: input order wins among
 * independents). Every reachable prerequisite is included in the returned
 * order, even when the selector named only the dependent. This prevents a
 * fresh dependent run from inheriting point-in-time PASS text from an older
 * prerequisite run without re-evaluating that prerequisite in the same
 * authority transaction. Throws on cycles.
 */
export function orderGates(ids: readonly string[], gates: readonly Gate[]): string[] {
	const byId = new Map(gates.map((g) => [g.id, g]));
	const visited = new Map<string, 0 | 1>(); // 0 = in progress, 1 = done
	const out: string[] = [];
	const visit = (id: string, chain: string[]): void => {
		const state = visited.get(id);
		if (state === 1) return;
		if (state === 0) {
			throw new Error(`gate prerequisite cycle: ${[...chain, id].join(" -> ")}`);
		}
		visited.set(id, 0);
		const gate = byId.get(id);
		if (!gate) {
			const dependent = chain[chain.length - 1];
			throw new Error(dependent
				? `gate "${dependent}" references unknown prerequisite "${id}"`
				: `unknown gate "${id}"`);
		}
		for (const prereq of gate.prerequisites) visit(prereq, [...chain, id]);
		visited.set(id, 1);
		out.push(id);
	};
	for (const id of ids) visit(id, []);
	return out;
}

export { CONFIG_DIR_NAME };
