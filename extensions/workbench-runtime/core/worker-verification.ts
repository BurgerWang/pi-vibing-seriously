/** Startup preflight for machine-readable worker verification recipe refs. */

import { isAbsolute } from "node:path";

import { loadProjectConfig } from "./config.ts";

export type WorkerVerificationPreflightErrorCode =
	| "invalid_project_root"
	| "invalid_recipe_name"
	| "config_invalid"
	| "recipe_missing"
	| "recipe_mutates"
	| "recipe_requires_params";

export type WorkerVerificationPreflightResult =
	| { ok: true; recipes: string[] }
	| { ok: false; code: WorkerVerificationPreflightErrorCode; recipe?: string; issue_count?: number };

/**
 * Validate every requested verification recipe immediately before launch.
 *
 * The caller has already established project trust. This helper reuses the
 * normal trusted config loader, rejects every recipes.yaml issue, and
 * authorizes only existing `mutation: none` recipes that need no
 * unrepresented required parameters. Unrelated gate/profile/advisory issues
 * are outside this preflight. It performs no recipe execution and writes no
 * state.
 */
export async function validateWorkerVerificationRecipes(
	projectRoot: string,
	names: readonly string[],
): Promise<WorkerVerificationPreflightResult> {
	if (
		typeof projectRoot !== "string" ||
		projectRoot.length === 0 ||
		projectRoot !== projectRoot.trim() ||
		!isAbsolute(projectRoot) ||
		projectRoot.includes("\0")
	) {
		return { ok: false, code: "invalid_project_root" };
	}

	const invalidName = names.find((name) =>
		typeof name !== "string" || name.length === 0 || name.length > 200 || name !== name.trim() || /[\u0000-\u001f\u007f]/u.test(name));
	if (invalidName !== undefined) {
		return { ok: false, code: "invalid_recipe_name" };
	}
	if (names.length === 0) return { ok: true, recipes: [] };

	const config = await loadProjectConfig(projectRoot, { trusted: true });
	const recipeIssues = config.issues.filter((issue) => issue.file === "recipes.yaml");
	if (recipeIssues.length > 0) {
		return { ok: false, code: "config_invalid", issue_count: recipeIssues.length };
	}
	const recipes = new Map(config.recipes.map((recipe) => [recipe.name, recipe]));
	const validated: string[] = [];
	for (const name of [...new Set(names)]) {
		const recipe = recipes.get(name);
		if (recipe === undefined) return { ok: false, code: "recipe_missing", recipe: name };
		if (recipe.mutation !== "none") return { ok: false, code: "recipe_mutates", recipe: name };
		if (recipe.params.some((param) => param.required)) {
			return { ok: false, code: "recipe_requires_params", recipe: name };
		}
		validated.push(name);
	}
	return { ok: true, recipes: validated };
}
