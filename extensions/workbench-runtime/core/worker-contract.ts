/**
 * Pure canonical-lint helpers for new worker delegation contracts.
 *
 * Historical delegation records are parsed by their existing binders. These
 * helpers apply only at the public edge for a new call, before a transaction or
 * worker process exists.
 */

export const WORKER_CONTRACT_SOFT_MAX_BYTES = 12 * 1024;
export const WORKER_CONTRACT_ABSOLUTE_MAX_BYTES = 64 * 1024;
export const WORKER_CONTRACT_EXTENDED_REASON_MAX_CHARS = 500;
export const WORKER_VERIFICATION_RECIPE_PREFIX = "recipe:";
export const WORKER_VERIFICATION_RECIPE_NAME_MAX_CHARS = 200;

export interface WorkerVerificationRecipeReference {
	reference: string;
	recipe: string;
}

/** Trim public contract text without rewriting meaningful internal layout. */
export function normalizeWorkerContractText(value: string): string {
	return value.trim();
}

/** Comparison-only whitespace key; never persisted in place of the original. */
export function workerContractComparisonKey(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

/** Reasons are deliberately one-line metadata and may safely collapse layout. */
export function normalizeWorkerContractReason(value: string): string {
	return workerContractComparisonKey(value);
}

/** Stable first-occurrence de-duplication without rewriting retained values. */
export function stableUniqueStrings(
	values: readonly string[],
	key: (value: string) => string = (value) => value,
): string[] {
	const seen = new Set<string>();
	const output: string[] = [];
	for (const value of values) {
		const identity = key(value);
		if (seen.has(identity)) continue;
		seen.add(identity);
		output.push(value);
	}
	return output;
}

/**
 * Parse the current public verification reference grammar.
 *
 * Recipe names are exact catalog keys. Surrounding whitespace, control
 * characters and nested prose are rejected rather than guessed. The `recipe:`
 * prefix keeps the persisted string shape compatible with historical records
 * while making new verification requests machine-readable.
 */
export function parseWorkerVerificationRecipeReference(value: unknown): WorkerVerificationRecipeReference | undefined {
	if (typeof value !== "string" || value !== value.trim() || !value.startsWith(WORKER_VERIFICATION_RECIPE_PREFIX)) {
		return undefined;
	}
	const recipe = value.slice(WORKER_VERIFICATION_RECIPE_PREFIX.length);
	if (
		recipe.length === 0 ||
		recipe.length > WORKER_VERIFICATION_RECIPE_NAME_MAX_CHARS ||
		recipe !== recipe.trim() ||
		/[\u0000-\u001f\u007f]/u.test(recipe)
	) {
		return undefined;
	}
	return Object.freeze({ reference: `${WORKER_VERIFICATION_RECIPE_PREFIX}${recipe}`, recipe });
}

/** Parse a complete normalized reference list for the startup preflight. */
export function workerVerificationRecipeNames(references: readonly string[]): string[] | undefined {
	const parsed = references.map(parseWorkerVerificationRecipeReference);
	return parsed.some((reference) => reference === undefined)
		? undefined
		: parsed.map((reference) => reference!.recipe);
}

export function canonicalWorkerContractBytes(value: unknown): number | undefined {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		return undefined;
	}
}
