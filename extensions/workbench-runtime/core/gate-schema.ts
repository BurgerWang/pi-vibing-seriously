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
 *   - file     machine: a project file (or one of several) exists
 *   - json     machine: a JSON artifact field exists / equals a value
 *   - numeric  machine: a JSON artifact number is finite and within bounds
 *   - schema   machine: an artifact conforms to a built-in schema
 *               (quant-result — the workbench validates output, it never
 *               computes strategy metrics itself)
 *   - manual   human: explicit manual evidence is required (never inferred
 *               from model prose; always recorded as type "manual")
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

export type CheckKind = "config" | "recipe" | "artifact" | "file" | "json" | "numeric" | "manual" | "schema";

export type GateStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";

export const GATE_STATUSES: readonly GateStatus[] = ["PASS", "FAIL", "BLOCKED", "NOT_RUN"];

/** Quant gate ids follow /^q\d+$/ and only load for quant profiles by default. */
export const QUANT_GATE_ID_RE = /^q\d+$/;

export const QUANT_PROFILES: readonly string[] = [
	"quant-research/stock-selection",
	"quant-research/market-timing",
];

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
	/** kind=schema: built-in schema name ("quant-result"). */
	schema_name?: string;
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

function asBoolean(value: unknown, fallback: boolean): boolean {
	return value === undefined ? fallback : value === true;
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
	"artifact_recipe",
	"glob",
	"equals",
	"any_of_paths",
	"min",
	"max",
	"prompt",
	"schema",
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
		errors.push(`${label}: kind=schema needs "schema" (built-in: quant-result)`);
	}

	const checkId = id ?? `${gateId}.${index + 1}`;
	const title = asString(raw.title, `${label}: "title"`, errors) ?? checkId;

	if (errors.length > 0) return { errors };

	const check: GateCheck = {
		id: checkId,
		title,
		description: typeof raw.description === "string" ? raw.description : "",
		required: asBoolean(raw.required, true),
		blocking: asBoolean(raw.blocking, true),
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
	const required = asBoolean(raw.required, true);
	const blocking = asBoolean(raw.blocking, true);

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
 * A project gate with a built-in id REPLACES the built-in entirely;
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
	for (const gate of projectGates) byId.set(gate.id, gate);

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
 * Topological order by prerequisites (stable: input order wins among
 * independents). Throws on cycles.
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
		if (gate) {
			for (const prereq of gate.prerequisites) visit(prereq, [...chain, id]);
		}
		visited.set(id, 1);
		if (ids.includes(id)) out.push(id);
	};
	for (const id of ids) visit(id, []);
	return out;
}

export { CONFIG_DIR_NAME };
