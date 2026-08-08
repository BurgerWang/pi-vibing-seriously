/**
 * Workbench recipe schema — validation and argv construction. Pure logic.
 *
 * A recipe is a fully declarative command description. The model can only
 * request a recipe by name plus parameters declared in the recipe's `params`
 * schema — it can never inject an arbitrary command or shell string.
 *
 * Security invariants enforced here / by the runner:
 *   - `command` MUST be an argv array; a plain shell string is rejected.
 *   - Parameters are substituted into argv entries via `{{name}}` placeholders;
 *     no shell string is ever assembled.
 *   - `environment` only allows explicitly declared env var names.
 *   - `cwd` / `writes` / `artifacts` containment is enforced by path-guard.
 */

import type { WorkbenchMode } from "./mode-policy.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CACHE_POLICY, parseCachePolicy, type RecipeCachePolicy } from "../cache/action-types.ts";

export const RECIPE_SCHEMA_VERSION = 1;

/**
 * P7 recipe mutation classification — the write-authority surface of a
 * recipe (consumed by the shared mutation-policy decision in
 * worker-policy.ts):
 *   - none      — the recipe never mutates the project (write-free)
 *   - artifacts — the recipe only writes result/artifact files
 *                 (data/results/artifacts/dist), never source code
 *   - source    — the recipe may modify source code
 * Legacy recipes without an explicit declaration infer `none` when
 * `writes` is empty and `source` when `writes` is non-empty.
 */
export type RecipeMutation = "none" | "artifacts" | "source";

export const RECIPE_MUTATIONS: readonly string[] = ["none", "artifacts", "source"];

export type OutputStrategy = "head" | "tail";
export type RecipeParamType = "string" | "number" | "boolean";

/**
 * Phase 2A: closed set of validation components a recipe may declare. The
 * recipe schema accepts EXACTLY these values — anything else (unknown tool
 * names, typos) is a parse error, never silently dropped.
 */
export const VALIDATION_COMPONENTS = ["typecheck", "unit-test", "whitespace"] as const;

/** Literal union of the declared validation components — never `string`. */
export type ValidationComponent = (typeof VALIDATION_COMPONENTS)[number];

/**
 * Narrow type guard: checks an arbitrary parsed string against the closed
 * tuple and narrows it to the literal union. Runtime behavior is identical
 * to `VALIDATION_COMPONENTS.includes(value)`.
 */
export function isValidationComponent(value: string): value is ValidationComponent {
	return (VALIDATION_COMPONENTS as readonly string[]).includes(value);
}

export interface RecipeParam {
	name: string;
	type: RecipeParamType;
	required: boolean;
	description?: string;
}

export interface Recipe {
	name: string;
	description: string;
	/** argv array; first element is the executable. Never a shell string. */
	command: string[];
	/** Working directory, relative to the project root. */
	cwd: string;
	timeout_ms: number;
	allowed_modes: WorkbenchMode[];
	expected_exit_codes: number[];
	/** Declared write paths (relative to project root) — containment-checked. */
	writes: string[];
	/**
	 * P7 mutation classification (none|artifacts|source) — present on every
	 * parsed recipe: explicit values validate strictly; a missing declaration
	 * infers none for writes=[] and source for non-empty writes.
	 */
	mutation: RecipeMutation;
	/** Result-file globs (relative to project root) — containment-checked. */
	artifacts: string[];
	/** Env var names the process may inherit. Nothing else is passed. */
	environment: string[];
	/**
	 * Phase 2A: declared validation components (closed set: typecheck,
	 * unit-test, whitespace). Default [] — a recipe declares the validation
	 * tooling it performs explicitly or declares none.
	 */
	validation_components: ValidationComponent[];
	/**
	 * P6-C action-cache policy (opt-in, default disabled). A cache
	 * declaration that violates the safety rules disables caching for this
	 * recipe and records a warning — the recipe itself still runs.
	 */
	cache: RecipeCachePolicy;
	output_strategy: OutputStrategy;
	max_lines: number;
	max_bytes: number;
	/** Declared parameters the model may pass; substituted into argv. */
	params: RecipeParam[];
}

export interface RecipeParseResult {
	recipes: Recipe[];
	errors: string[];
	/** Non-fatal issues (e.g. a disabled cache block) — never drop a recipe. */
	warnings: string[];
}

export const DEFAULT_TIMEOUT_MS = 120_000;

export const DEFAULT_RECIPE: Omit<Recipe, "name" | "command"> = {
	description: "",
	cwd: ".",
	timeout_ms: DEFAULT_TIMEOUT_MS,
	allowed_modes: ["DEV", "VERIFY"],
	expected_exit_codes: [0],
	writes: [],
	mutation: "none",
	artifacts: [],
	environment: [],
	validation_components: [],
	output_strategy: "tail",
	max_lines: DEFAULT_MAX_LINES,
	max_bytes: DEFAULT_MAX_BYTES,
	params: [],
	cache: DEFAULT_CACHE_POLICY,
};

const MODE_VALUES: readonly string[] = ["AUDIT", "DEV", "VERIFY"];
const PARAM_TYPES: readonly string[] = ["string", "number", "boolean"];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER_RE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown, field: string, errors: string[]): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		errors.push(`"${field}" must be an array of strings`);
		return [];
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			errors.push(`"${field}" entries must be strings`);
			continue;
		}
		out.push(item);
	}
	return out;
}

function asPositiveInt(value: unknown, label: string, fallback: number, errors: string[]): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		errors.push(`${label} must be a positive integer`);
		return fallback;
	}
	return value;
}

/** Parse one raw recipe mapping into a validated Recipe (or errors). */
export function parseRecipe(raw: unknown, index: number): RecipeParseResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (!isRecord(raw)) {
		return { recipes: [], errors: [`recipe #${index + 1} must be a mapping`], warnings };
	}
	for (const key of Object.keys(raw)) {
		if (!(key in DEFAULT_RECIPE) && key !== "name" && key !== "command") {
			errors.push(`recipe #${index + 1} (${typeof raw.name === "string" ? `"${raw.name}"` : "unnamed"}): unknown field "${key}"`);
		}
	}
	const name = raw.name;
	let recipeName: string | undefined;
	if (typeof name !== "string" || name.trim().length === 0) {
		errors.push(`recipe #${index + 1}: "name" must be a non-empty string`);
	} else {
		recipeName = name;
	}
	const label = (): string => (recipeName ? `"${recipeName}"` : `#${index + 1}`);
	const command = raw.command;
	let commandArgv: string[] | undefined;
	if (command === undefined) {
		errors.push(`recipe ${label()}: "command" is required`);
	} else if (typeof command === "string") {
		errors.push(
			`recipe ${label()}: "command" must be an argv array (e.g. ["npm","test"]), not a shell string`,
		);
	} else if (!Array.isArray(command) || command.length === 0 || command.some((c) => typeof c !== "string" || c.trim() === "")) {
		errors.push(
			`recipe ${label()}: "command" must be a non-empty argv array of non-empty strings`,
		);
	} else {
		commandArgv = command;
	}
	if (errors.length > 0) return { recipes: [], errors, warnings };
	const recipe = recipeName as string;
	const commandFinal = commandArgv as string[];

	const cwdRaw = raw.cwd === undefined ? "." : raw.cwd;
	if (typeof cwdRaw !== "string" || cwdRaw.length === 0) {
		errors.push(`recipe "${recipe}": "cwd" must be a non-empty string`);
	}
	const cwd = cwdRaw as string;

	const allowedModesRaw = raw.allowed_modes ?? ["DEV", "VERIFY"];
	const allowed_modes: WorkbenchMode[] = [];
	if (!Array.isArray(allowedModesRaw)) {
		errors.push(`recipe "${name}": "allowed_modes" must be an array`);
	} else {
		for (const m of allowedModesRaw) {
			if (typeof m === "string" && MODE_VALUES.includes(m)) {
				allowed_modes.push(m as WorkbenchMode);
			} else {
				errors.push(`recipe "${name}": invalid allowed_modes entry ${JSON.stringify(m)} (expected AUDIT, DEV or VERIFY)`);
			}
		}
	}

	const outputStrategyRaw = raw.output_strategy ?? "tail";
	if (outputStrategyRaw !== "head" && outputStrategyRaw !== "tail") {
		errors.push(`recipe "${name}": "output_strategy" must be "head" or "tail"`);
	}

	const expectedRaw = raw.expected_exit_codes ?? [0];
	const expected_exit_codes: number[] = [];
	if (!Array.isArray(expectedRaw)) {
		errors.push(`recipe "${name}": "expected_exit_codes" must be an array of integers`);
	} else {
		for (const code of expectedRaw) {
			if (typeof code !== "number" || !Number.isInteger(code)) {
				errors.push(`recipe "${name}": "expected_exit_codes" entries must be integers`);
			} else {
				expected_exit_codes.push(code);
			}
		}
	}

	const environment = asStringArray(raw.environment, `recipe "${name}": "environment"`, errors);
	for (const envName of environment) {
		if (!ENV_NAME_RE.test(envName)) {
			errors.push(`recipe "${name}": invalid environment variable name "${envName}"`);
		}
	}

	const params: RecipeParam[] = [];
	const paramsRaw = raw.params;
	if (paramsRaw !== undefined) {
		if (!Array.isArray(paramsRaw)) {
			errors.push(`recipe "${name}": "params" must be an array`);
		} else {
			const seen = new Set<string>();
			for (const p of paramsRaw) {
				if (!isRecord(p) || typeof p.name !== "string" || p.name.length === 0) {
					errors.push(`recipe "${name}": each param needs a "name" string`);
					continue;
				}
				if (seen.has(p.name)) {
					errors.push(`recipe "${name}": duplicate param "${p.name}"`);
					continue;
				}
				seen.add(p.name);
				const type = p.type ?? "string";
				if (typeof type !== "string" || !PARAM_TYPES.includes(type)) {
					errors.push(`recipe "${name}": param "${p.name}" has invalid type ${JSON.stringify(type)}`);
					continue;
				}
				if (p.description !== undefined && typeof p.description !== "string") {
					errors.push(`recipe "${name}": param "${p.name}" description must be a string`);
					continue;
				}
				params.push({
					name: p.name,
					type: type as RecipeParamType,
					required: p.required === true,
					description: typeof p.description === "string" ? p.description : undefined,
				});
			}
		}
	}

	const timeoutMs = asPositiveInt(raw.timeout_ms, `recipe "${recipe}": "timeout_ms"`, DEFAULT_TIMEOUT_MS, errors);
	const maxLines = asPositiveInt(raw.max_lines, `recipe "${recipe}": "max_lines"`, DEFAULT_MAX_LINES, errors);
	const maxBytes = asPositiveInt(raw.max_bytes, `recipe "${recipe}": "max_bytes"`, DEFAULT_MAX_BYTES, errors);
	const writes = asStringArray(raw.writes, `recipe "${recipe}": "writes"`, errors);
	const artifacts = asStringArray(raw.artifacts, `recipe "${recipe}": "artifacts"`, errors);

	// Phase 2A: closed validation-components set (typecheck | unit-test |
	// whitespace). Default []; a non-array, a non-string entry, an unknown
	// value or a duplicate is a parse error — the recipe is rejected, the
	// field is never silently normalized.
	const validationComponentsRaw = raw.validation_components ?? [];
	const validation_components: ValidationComponent[] = [];
	if (!Array.isArray(validationComponentsRaw)) {
		errors.push(`recipe "${recipe}": "validation_components" must be an array of strings`);
	} else {
		const seen = new Set<string>();
		for (const component of validationComponentsRaw) {
			if (typeof component !== "string") {
				errors.push(`recipe "${recipe}": "validation_components" entries must be strings`);
				continue;
			}
			if (!isValidationComponent(component)) {
				errors.push(`recipe "${recipe}": invalid validation_components entry ${JSON.stringify(component)} (expected ${VALIDATION_COMPONENTS.join(", ")})`);
				continue;
			}
			if (seen.has(component)) {
				errors.push(`recipe "${recipe}": duplicate validation_components entry "${component}"`);
				continue;
			}
			seen.add(component);
			validation_components.push(component);
		}
	}

	// P7: strict mutation validation with legacy inference. Explicit values
	// must be exactly none|artifacts|source; a missing declaration infers
	// none for writes=[] and source for non-empty writes. Every parsed
	// recipe therefore exposes a deterministic mutation.
	let mutation: RecipeMutation;
	if (raw.mutation === undefined) {
		mutation = writes.length > 0 ? "source" : "none";
	} else if (typeof raw.mutation === "string" && RECIPE_MUTATIONS.includes(raw.mutation)) {
		mutation = raw.mutation as RecipeMutation;
	} else {
		errors.push(`recipe "${recipe}": "mutation" must be one of ${RECIPE_MUTATIONS.join(", ")}`);
		mutation = writes.length > 0 ? "source" : "none";
	}

	if (errors.length > 0) return { recipes: [], errors, warnings };

	// P6-C: cache policy (opt-in; violations disable caching, never the recipe).
	const cacheRaw = raw.cache;
	if (cacheRaw !== undefined && !isRecord(cacheRaw)) {
		warnings.push(`recipe "${recipe}": "cache" must be a mapping — cache disabled`);
	}
	const cacheResult = parseCachePolicy(cacheRaw, commandFinal, writes);
	warnings.push(...cacheResult.issues.map((message) => `recipe "${recipe}": ${message}`));

	return {
		recipes: [
			{
				name: recipe,
				command: commandFinal,
				description: typeof raw.description === "string" ? raw.description : "",
				cwd,
				timeout_ms: timeoutMs,
				allowed_modes,
				expected_exit_codes,
				writes,
				artifacts,
				environment,
				validation_components,
				output_strategy: outputStrategyRaw as OutputStrategy,
				max_lines: maxLines,
				max_bytes: maxBytes,
				params,
				mutation,
				cache: cacheResult.policy,
			},
		],
		errors,
		warnings,
	};
}

/**
 * Parse the `recipes.yaml` document. Accepts either a top-level list or a
 * mapping with a `recipes` key. Returns validated recipes plus file-level
 * errors. Duplicate names are rejected.
 */
export function parseRecipesDocument(doc: unknown): RecipeParseResult {
	if (doc === null || doc === undefined) return { recipes: [], errors: [], warnings: [] };
	let list: unknown[];
	if (Array.isArray(doc)) {
		list = doc;
	} else if (isRecord(doc) && Array.isArray(doc.recipes)) {
		list = doc.recipes;
	} else {
		return { recipes: [], errors: ["recipes.yaml root must be a list or a mapping with a \"recipes\" key"], warnings: [] };
	}

	const recipes: Recipe[] = [];
	const errors: string[] = [];
	const warnings: string[] = [];
	const seen = new Set<string>();
	list.forEach((raw, index) => {
		const result = parseRecipe(raw, index);
		errors.push(...result.errors);
		warnings.push(...result.warnings);
		for (const recipe of result.recipes) {
			if (seen.has(recipe.name)) {
				errors.push(`duplicate recipe name "${recipe.name}"`);
				continue;
			}
			seen.add(recipe.name);
			recipes.push(recipe);
		}
	});
	// P6-B: deterministic recipe order — sorted by name, never YAML list/key
	// order. Recipes are resolved by name at run time, so this only makes the
	// discovery surface (inspect/status) stable across installs.
	return { recipes: recipes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), errors, warnings };
}

// ---------------------------------------------------------------------------
// Parameter substitution (argv construction)
// ---------------------------------------------------------------------------

export class RecipeParamError extends Error {}

/**
 * Build the final argv for a recipe from declared params.
 * - Any param not declared in the recipe schema is rejected.
 * - Required params must be provided.
 * - Provided values must match the declared type.
 * - `{{name}}` placeholders in command entries are replaced with the string
 *   form of the value. Undeclared placeholders are rejected.
 */
export function buildArgv(recipe: Recipe, params: Readonly<Record<string, unknown>>): string[] {
	const declared = new Map(recipe.params.map((p) => [p.name, p]));

	for (const key of Object.keys(params)) {
		if (!declared.has(key)) {
			throw new RecipeParamError(
				`unknown parameter "${key}" for recipe "${recipe.name}" (declared: ${recipe.params.map((p) => p.name).join(", ") || "none"})`,
			);
		}
	}
	for (const param of recipe.params) {
		if (param.required && !(param.name in params)) {
			throw new RecipeParamError(`missing required parameter "${param.name}" for recipe "${recipe.name}"`);
		}
		if (param.name in params) {
			const value = params[param.name];
			const ok =
				(param.type === "string" && typeof value === "string") ||
				(param.type === "number" && typeof value === "number") ||
				(param.type === "boolean" && typeof value === "boolean");
			if (!ok) {
				throw new RecipeParamError(
					`parameter "${param.name}" for recipe "${recipe.name}" must be a ${param.type}, got ${JSON.stringify(value)}`,
				);
			}
		}
	}

	const argv: string[] = [];
	for (const part of recipe.command) {
		const expanded = part.replace(PLACEHOLDER_RE, (match, rawName: string) => {
			const param = declared.get(rawName);
			if (!param) {
				throw new RecipeParamError(
					`command placeholder "{{${rawName}}}" in recipe "${recipe.name}" is not a declared parameter`,
				);
			}
			const value = params[rawName];
			if (value === undefined) return "";
			return String(value);
		});
		argv.push(expanded);
	}
	return argv;
}
