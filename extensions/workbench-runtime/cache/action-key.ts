/**
 * P6-C action key computation — the deterministic identity of one recipe
 * execution.
 *
 * The key NEVER relies on git commit/branch, mtime, file size, dirty/clean
 * state, or the recipe name alone. It is a SHA-256 over the canonical form
 * of:
 *
 *   cacheSchemaVersion, cachePolicyVersion, workbenchPackageVersion,
 *   recipeName, recipeDefinitionHash, cachePolicyHash, normalized argv,
 *   normalized relative cwd, allowedMode, declaredEnvironmentHash,
 *   toolchainVersions, operatingSystem, architecture, lockfileHashes,
 *   declaredInputMerkleHash, relevantWorkbenchConfigHash, profileHash,
 *   gateSchemaHash, upstreamActionKeys
 *
 * Safety rules:
 *   - only declared env var names are observed; values are hashed, never
 *     stored (secret names included — the raw value never persists)
 *   - only allow-listed version queries run (argv, shell=false, timeout,
 *     truncated output); a failed query is an explicit "unknown" component,
 *     never silently ignored
 *   - fingerprint failures (symlink escape, limits) refuse the cache
 */

import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import os from "node:os";

import { GATE_CATALOG } from "../core/gate-catalog.ts";
import { effectiveGates, parseGatesDocument, type Gate } from "../core/gate-schema.ts";
import { loadProjectConfig, type ExecFn } from "../core/config.ts";
import type { Recipe } from "../core/recipe-schema.ts";
import { canonicalHash, sha256Hex, sha256HexBytes } from "./canonical-hash.ts";
import { fingerprintInputs, FingerprintError } from "./action-fingerprint.ts";
import { resolveQuantContract } from "./quant-files.ts";
import {
	ACTION_CACHE_SCHEMA_VERSION,
	CACHE_POLICY_VERSION,
	DEFAULT_CACHE_POLICY,
	KNOWN_LOCKFILES,
	MAX_UPSTREAM_DEPTH,
	VERSION_OUTPUT_MAX_CHARS,
	type ActionKey,
	type ActionKeyComponents,
	type InputEntry,
	type QuantContractRecordInfo,
	type RecipeCachePolicy,
} from "./action-types.ts";

export const WORKBENCH_CONFIG_FILES = ["project.yaml", "recipes.yaml", "gates.yaml", "profiles.yaml"] as const;

/** Normalized definition hash: everything about the recipe that affects its
 * execution semantics, excluding the cache block (hashed separately). */
export function recipeDefinitionHash(recipe: Recipe): string {
	return canonicalHash({
		description: recipe.description,
		command: recipe.command,
		cwd: recipe.cwd,
		timeout_ms: recipe.timeout_ms,
		allowed_modes: recipe.allowed_modes,
		expected_exit_codes: recipe.expected_exit_codes,
		writes: recipe.writes,
		artifacts: recipe.artifact_contracts,
		environment: recipe.environment,
		validation_components: recipe.validation_components,
		output_strategy: recipe.output_strategy,
		max_lines: recipe.max_lines,
		max_bytes: recipe.max_bytes,
		params: recipe.params,
	});
}

/** Hash of the cache policy block (mode, successOnly, inputs, outputs, env,
 * toolchain, maxAgeSeconds, upstream, P6-D domain + quantContract). Changing
 * ANY of it changes the key — the safe direction is a miss. */
export function cachePolicyHash(policy: RecipeCachePolicy): string {
	return canonicalHash({
		version: policy.version,
		domain: policy.domain,
		quantContract: policy.quantContract,
		mode: policy.mode,
		successOnly: policy.successOnly,
		inputs: policy.inputs,
		outputs: policy.outputs,
		environment: policy.environment,
		toolchain: policy.toolchain.map((t) => ({ name: t.name, command: t.command, timeoutMs: t.timeoutMs })),
		maxAgeSeconds: policy.maxAgeSeconds,
		upstream: policy.upstream,
	});
}

/** Normalized project-relative POSIX cwd. */
export function normalizeCwd(projectRoot: string, cwd: string): string {
	const rel = relative(resolve(projectRoot), resolve(projectRoot, cwd));
	const normalized = rel.split(sep).join("/");
	return normalized.length === 0 ? "." : normalized;
}

/** Canonical hash of declared env values; raw values are never returned. */
export function declaredEnvironmentHash(names: readonly string[], env: Readonly<Record<string, string | undefined>>): string {
	const values: Record<string, string> = {};
	for (const name of [...new Set(names)].sort()) {
		const value = env[name];
		values[name] = value === undefined ? "unset" : sha256Hex(value);
	}
	return canonicalHash(values);
}

/** Hash of the well-known lockfile set at the project root. */
export async function lockfileHashes(projectRoot: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const name of KNOWN_LOCKFILES) {
		const path = join(projectRoot, name);
		try {
			const info = await stat(path);
			if (!info.isFile()) {
				out[name] = "not-a-file";
				continue;
			}
			if (info.size > 64 * 1024 * 1024) {
				out[name] = "too-large";
				continue;
			}
			out[name] = sha256HexBytes(await readFile(path));
		} catch {
			out[name] = "missing";
		}
	}
	return out;
}

/** Hash of the workbench config files that can affect recipe semantics. */
export async function workbenchConfigHash(projectRoot: string): Promise<string> {
	const parts: Record<string, string> = {};
	for (const file of WORKBENCH_CONFIG_FILES) {
		try {
			parts[file] = sha256HexBytes(await readFile(join(projectRoot, ".pi", "workbench", file)));
		} catch {
			parts[file] = "missing";
		}
	}
	return canonicalHash(parts);
}

/** Hash of the effective gate schema (catalog + project gates, profile-filtered). */
export function gateSchemaHash(profile: string | undefined, projectGatesRaw: readonly unknown[]): string {
	const parsed = parseGatesDocument({ gates: [...projectGatesRaw] });
	const effective = effectiveGates(profile, GATE_CATALOG, parsed.gates);
	return canonicalHash(effective.map(normalizeGateForHash));
}

function normalizeGateForHash(gate: Gate): unknown {
	return {
		id: gate.id,
		title: gate.title,
		description: gate.description,
		profiles: gate.profiles,
		prerequisites: gate.prerequisites,
		required: gate.required,
		blocking: gate.blocking,
		evidence: gate.evidence,
		acceptance: gate.acceptance,
		source: gate.source,
		checks: gate.checks.map((c) => ({
			id: c.id,
			title: c.title,
			description: c.description,
			kind: c.kind,
			required: c.required,
			blocking: c.blocking,
			recipe: c.recipe,
			recipes: c.recipes,
			path: c.path,
			any_of: c.any_of,
			file_root: c.file_root,
			artifact_recipe: c.artifact_recipe,
			artifact_glob: c.artifact_glob,
			json_file: c.json_file,
			json_path: c.json_path,
			json_equals: c.json_equals,
			json_any_of_paths: c.json_any_of_paths,
			numeric_min: c.numeric_min,
			numeric_max: c.numeric_max,
			manual_prompt: c.manual_prompt,
			schema_name: c.schema_name,
			worker_first: c.worker_first,
		})),
	};
}

// ---------------------------------------------------------------------------
// Toolchain probing
// ---------------------------------------------------------------------------

export interface ToolchainProbeResult {
	versions: Record<string, string>;
	/** entries whose version query failed or timed out (explicit "unknown"). */
	unknown: string[];
}

/** Truncate + normalize a version string (ANSI, whitespace, cap). */
function normalizeVersionOutput(raw: string): string {
	return raw
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, VERSION_OUTPUT_MAX_CHARS);
}

/**
 * Run the allow-listed version queries. A failed query is recorded as the
 * explicit string "unknown" — never silently dropped from the key.
 */
export async function probeToolchain(
	projectRoot: string,
	decls: readonly { name: string; command: string[]; timeoutMs: number }[],
	exec: ExecFn,
): Promise<ToolchainProbeResult> {
	const versions: Record<string, string> = {};
	const unknown: string[] = [];
	for (const decl of decls) {
		const exe = decl.command[0] ?? "";
		const args = decl.command.slice(1);
		let text = "unknown";
		try {
			const result = await exec(exe, args, { cwd: projectRoot, timeout: decl.timeoutMs });
			text = result.code === 0 ? normalizeVersionOutput(result.stdout || result.stderr) : "unknown";
			if (text.length === 0) text = "unknown";
		} catch {
			text = "unknown";
		}
		versions[decl.name] = text;
		if (text === "unknown") unknown.push(decl.name);
	}
	return { versions, unknown };
}

// ---------------------------------------------------------------------------
// Key computation
// ---------------------------------------------------------------------------

export interface ComputeActionKeyInput {
	projectRoot: string;
	recipe: Recipe;
	policy: RecipeCachePolicy;
	argv: string[];
	mode: string;
	profile: string | undefined;
	projectGates: readonly unknown[];
	packageVersion: string;
	exec: ExecFn;
	/** Test seam: override runtime facts (defaults to the real ones). */
	osOverride?: string;
	archOverride?: string;
	envOverride?: Readonly<Record<string, string | undefined>>;
}

export type ComputedActionKey =
	| { ok: true; key: ActionKey; inputEntries: InputEntry[]; quantContractInfo?: QuantContractRecordInfo | null }
	| { ok: false; reason: string };

/**
 * Compute the full action key. Returns {ok:false, reason} instead of
 * throwing whenever the cache must be refused (fingerprint errors, upstream
 * recursion limits, toolchain probes that cannot run). Callers fall back to
 * normal execution.
 */
export async function computeActionKey(input: ComputeActionKeyInput): Promise<ComputedActionKey> {
	const { projectRoot, recipe, policy, argv, mode, profile, projectGates, packageVersion, exec } = input;
	try {
		const inputFp = await fingerprintInputs(projectRoot, policy.inputs);
		const toolchain = await probeToolchain(projectRoot, policy.toolchain, exec);
		const lockfiles = await lockfileHashes(projectRoot);
		const configHash = await workbenchConfigHash(projectRoot);

		const upstreamKeys: string[] = [];
		if (policy.upstream.length > 0) {
			const keys = await computeUpstreamKeys({
				projectRoot,
				recipeNames: policy.upstream,
				profile,
				projectGates,
				packageVersion,
				exec,
				argv,
				mode,
				depth: 0,
				seen: new Set<string>(),
			});
			if (keys === null) {
				return { ok: false, reason: "upstream action keys could not be computed (missing recipe or required params)" };
			}
			upstreamKeys.push(...keys);
		}

		// P6-D: quant contract upstream key. The declared manifest must exist,
		// be schema-valid and (when a logical reference) resolve to an immutable
		// manifest — otherwise the quant cache is REFUSED (normal execution
		// continues; no quant cache is read or written).
		let quantContractKey: string | null = null;
		let quantContractInfo: QuantContractRecordInfo | null = null;
		if (policy.domain === "quant" && policy.quantContract) {
			const resolved = await resolveQuantContract(projectRoot, policy.quantContract, { profile });
			if (!resolved.ok) {
				return { ok: false, reason: resolved.reason };
			}
			quantContractKey = resolved.resolved.immutableKey;
			quantContractInfo = {
				type: policy.quantContract.type,
				manifest: policy.quantContract.manifest,
				immutableKey: resolved.resolved.immutableKey,
				manifestHash: resolved.resolved.manifestHash,
				validationStatus: resolved.resolved.validation.validationStatus,
				logicalReference: resolved.resolved.logicalReference,
				resolvedReference: resolved.resolved.resolvedReference,
				warnings: [...resolved.resolved.validation.warnings],
			};
		}

		const osName = input.osOverride ?? `${process.platform}@${os.release()}`;
		const arch = input.archOverride ?? process.arch;
		const env = input.envOverride ?? process.env;

		const components: ActionKeyComponents = {
			cacheSchemaVersion: ACTION_CACHE_SCHEMA_VERSION,
			cachePolicyVersion: CACHE_POLICY_VERSION,
			packageVersion,
			recipeName: recipe.name,
			recipeDefinitionHash: recipeDefinitionHash(recipe),
			cachePolicyHash: cachePolicyHash(policy),
			argvHash: sha256Hex(canonicalHash(argv)),
			normalizedCwd: normalizeCwd(projectRoot, recipe.cwd),
			allowedMode: mode,
			environmentHash: declaredEnvironmentHash([...recipe.environment, ...policy.environment], env),
			toolchainVersions: toolchain.versions,
			operatingSystem: osName,
			architecture: arch,
			lockfileHashes: lockfiles,
			inputMerkleHash: inputFp.merkleHash,
			inputFacts: inputFp.facts,
			workbenchConfigHash: configHash,
			profileHash: canonicalHash(profile ?? "none"),
			gateSchemaHash: gateSchemaHash(profile, projectGates),
			upstreamActionKeys: upstreamKeys,
			quantContractKey,
		};
		const key = sha256Hex(`${canonicalHash(components)}:${ACTION_CACHE_SCHEMA_VERSION}`);
		return { ok: true, key: { key, components }, inputEntries: inputFp.entries, quantContractInfo };
	} catch (error) {
		if (error instanceof FingerprintError) {
			return { ok: false, reason: error.message };
		}
		return { ok: false, reason: `action key computation failed: ${(error as Error).message}` };
	}
}

/** key = SHA-256 over the canonical component digest, salted by the schema
 * version so a schema bump can never reuse old keys. */

/**
 * Compute upstream action keys (recipe names declared in cache.upstream).
 * Upstream keys use empty params; an upstream recipe with required params
 * cannot be modeled → null (parent cache refused).
 */
async function computeUpstreamKeys(input: {
	projectRoot: string;
	recipeNames: readonly string[];
	profile: string | undefined;
	projectGates: readonly unknown[];
	packageVersion: string;
	exec: ExecFn;
	argv: string[];
	mode: string;
	depth: number;
	seen: Set<string>;
}): Promise<string[] | null> {
	const { projectRoot, recipeNames, profile, projectGates, packageVersion, exec, argv, mode, depth, seen } = input;
	if (depth >= MAX_UPSTREAM_DEPTH) return null;
	const out: string[] = [];
	const config = await loadProjectConfig(projectRoot, { trusted: true });
	for (const name of recipeNames) {
		if (seen.has(name)) return null; // cycle
		const recipe = config.recipes.find((r) => r.name === name);
		if (!recipe) return null;
		if (recipe.params.some((p) => p.required)) return null;
		const nested: RecipeCachePolicy = recipeCacheOf(recipe);
		const sub = await computeActionKey({
			projectRoot,
			recipe,
			policy: nested,
			argv: argvFor(recipe),
			mode,
			profile,
			projectGates,
			packageVersion,
			exec,
		});
		if (!sub.ok) return null;
		out.push(sub.key.key);
		const nextSeen = new Set(seen);
		nextSeen.add(name);
		const deeper = await computeUpstreamKeys({
			projectRoot,
			recipeNames: nested.upstream,
			profile,
			projectGates,
			packageVersion,
			exec,
			argv,
			mode,
			depth: depth + 1,
			seen: nextSeen,
		});
		if (deeper === null) return null;
		out.push(...deeper);
	}
	return out;
}

/** Read the cache policy attached to a parsed recipe (absent = disabled). */
function recipeCacheOf(recipe: Recipe): RecipeCachePolicy {
	return recipe.cache ?? DEFAULT_CACHE_POLICY;
}

function argvFor(recipe: Recipe): string[] {
	// Empty params: placeholders expand to "" exactly like buildArgv with no
	// params (required params are rejected above).
	const argv: string[] = [];
	for (const part of recipe.command) {
		argv.push(part.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, ""));
	}
	return argv;
}

// ---------------------------------------------------------------------------
// Input-entry diffing (explain)
// ---------------------------------------------------------------------------

export function compareInputEntrySets(current: readonly InputEntry[], stored: readonly InputEntry[] | null): {
	changed: number;
	added: number;
	removed: number;
	same: boolean;
	names: string[];
} {
	if (!stored) return { changed: 0, added: 0, removed: 0, same: false, names: [] };
	const cur = new Map(current.map((e) => [e.p, e]));
	const old = new Map(stored.map((e) => [e.p, e]));
	const changed: string[] = [];
	const added: string[] = [];
	const removed: string[] = [];
	for (const [p, e] of cur) {
		const prior = old.get(p);
		if (!prior) added.push(p);
		else if (prior.t !== e.t || prior.h !== e.h || prior.x !== e.x) changed.push(p);
	}
	for (const [p] of old) {
		if (!cur.has(p)) removed.push(p);
	}
	const names = [...changed, ...added, ...removed].slice(0, 10);
	return { changed: changed.length, added: added.length, removed: removed.length, same: changed.length + added.length + removed.length === 0, names };
}
