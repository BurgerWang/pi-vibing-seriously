/**
 * P6-C Action Cache — shared types, schema constants, cache policy parsing
 * and policy-level safety rules. Pure logic, no Pi imports.
 *
 * The Action Cache maps `actionKey -> execution result metadata` for
 * DECLARED workbench recipes only. It never caches model answers, patches,
 * audit conclusions, planning, natural-language output, or arbitrary bash
 * commands. Caching is per-recipe opt-in (`cache:` block in recipes.yaml),
 * disabled by default, and only successful results are cached by default.
 *
 * Policy-level safety rules enforced at parse time (a violation disables
 * caching for that recipe with a recorded issue — it never blocks the
 * recipe itself):
 *   - network / time / random / external-API recipes are forbidden from
 *     caching (token denylist + package-manager verb denylist)
 *   - recipes that modify source code (declared writes under source paths,
 *     or git mutation verbs) are forbidden from caching
 *   - `artifacts` mode requires declared `outputs`; restore is disabled in
 *     this version (ARTIFACT_RESTORE_ENABLED = false)
 *
 * Secret env values are hashed (SHA-256) into keys and records — the raw
 * value is never persisted.
 */

import type { QuantContractDecl, QuantContractRecordInfo } from "./quant-contracts.ts";
import { parseQuantContractDecl } from "./quant-contracts.ts";
// Re-exported for callers that consume the policy shape (action-key.ts).
export type { QuantContractDecl, QuantContractRecordInfo } from "./quant-contracts.ts";

export const ACTION_CACHE_SCHEMA_VERSION = 1;
/** Bump when the semantic meaning of action keys changes. */
export const CACHE_POLICY_VERSION = 1;
export const ACTION_RECORD_SCHEMA_VERSION = 1;
export const CACHE_INDEX_SCHEMA_VERSION = 1;

/**
 * v1: artifacts RESTORE is implemented at the CAS primitive level but stays
 * disabled at the policy level (opt-in). Restoring files from a cache is a
 * security boundary that needs its own full gate; until then, artifacts-mode
 * recipes always execute and only result metadata is stored.
 */
export const ARTIFACT_RESTORE_ENABLED = false;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Unified discovery budget for a declared-input fingerprint. Every regular
 * file, directory, protected marker, symlink encounter, and missing pattern
 * consumes one entry. Keeping this broader than a file-only limit prevents a
 * tree of empty directories or protected names from bypassing the bound.
 */
export const MAX_INPUT_ENTRIES = 5000;
/** Backwards-compatible name; regular files are covered by the unified cap. */
export const MAX_INPUT_FILES = MAX_INPUT_ENTRIES;
export const MAX_INPUT_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_INPUT_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_INPUT_DEPTH = 64;
/** Cap on per-file entries stored inside an action record (explain diffs). */
export const MAX_RECORD_INPUT_ENTRIES = 1000;
export const LOCK_STALE_MS = 60_000;
export const LOCK_WAIT_MS = 120_000;
export const DEFAULT_ACTION_CACHE_MAX_BYTES = 256 * 1024 * 1024;
export const VERSION_QUERY_TIMEOUT_MS = 5000;
export const VERSION_OUTPUT_MAX_CHARS = 256;
export const MAX_UPSTREAM_DEPTH = 4;

// ---------------------------------------------------------------------------
// Cache policy (recipes.yaml `cache:` block)
// ---------------------------------------------------------------------------

export type CacheMode = "result-only" | "artifacts";

/**
 * P6-D: cache domains. "default" is the P6-C action cache; "quant" adds
 * the Quant Research Cache Contract (quantContract) — the domain is still
 * opt-in via `enabled: true` and disabled by default.
 */
export type CacheDomain = "default" | "quant";

/**
 * P6-C: per-run cache REQUEST mode — how a caller asks the action cache to
 * behave for ONE run (distinct from the recipe-declared cache policy).
 * "default" reads and writes per recipe policy; "no-cache" neither reads
 * nor writes; "refresh-cache" never reads but executes and rewrites on
 * success. Canonical definition — re-exported by action-cache.ts for
 * existing importers.
 */
export type CacheRequestMode = "default" | "no-cache" | "refresh-cache";

export interface ToolchainDecl {
	name: string;
	/** Safe version-query argv (shell=false, no pipes/redirection). */
	command: string[];
	timeoutMs: number;
}

export interface RecipeCachePolicy {
	enabled: boolean;
	version: number;
	/** P6-D: "quant" requires a valid quantContract declaration. */
	domain: CacheDomain;
	/** P6-D: quant contract declaration (type + manifest path), null for the default domain. */
	quantContract: QuantContractDecl | null;
	mode: CacheMode;
	/** Only successful results are cached. Default true. */
	successOnly: boolean;
	/** Project-relative globs whose CONTENT fingerprints the action key. */
	inputs: string[];
	/** Declared output artifacts (artifacts mode only). */
	outputs: string[];
	/** Extra env var names whose VALUES hash into the key (never stored). */
	environment: string[];
	toolchain: ToolchainDecl[];
	/** TTL in seconds; null = never expire. */
	maxAgeSeconds: number | null;
	/** Recipe names whose action keys chain into this key. */
	upstream: string[];
}

export const DEFAULT_CACHE_POLICY: RecipeCachePolicy = {
	enabled: false,
	version: 1,
	domain: "default",
	quantContract: null,
	mode: "result-only",
	successOnly: true,
	inputs: [],
	outputs: [],
	environment: [],
	toolchain: [],
	maxAgeSeconds: null,
	upstream: [],
};

export interface CachePolicyParseResult {
	policy: RecipeCachePolicy;
	/** Non-fatal issues (cache disabled on any issue; recipe still runs). */
	issues: string[];
}

// ---------------------------------------------------------------------------
// Built-in toolchain version queries
// ---------------------------------------------------------------------------

export const BUILTIN_TOOLCHAIN_QUERIES: Readonly<Record<string, readonly string[]>> = {
	node: ["node", "--version"],
	npm: ["npm", "--version"],
	python: ["python", "--version"],
	uv: ["uv", "--version"],
	rustc: ["rustc", "--version"],
	cargo: ["cargo", "--version"],
};

// ---------------------------------------------------------------------------
// Forbidden cache domains (heuristic, documented in docs/cache/)
// ---------------------------------------------------------------------------

/** Executables whose presence forbids caching (network / external API). */
const NETWORK_TOKENS: readonly string[] = [
	"curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "socat", "telnet", "ftp", "lftp",
	"docker", "podman", "kubectl", "helm", "terraform", "gcloud", "aws", "az", "azcli",
	"ping", "traceroute", "tracepath", "dig", "nslookup", "host", "whois",
	"apt", "apt-get", "dpkg", "dnf", "yum", "pacman", "brew", "apk",
];

/** Executables whose presence forbids caching (time / randomness). */
const NONDETERMINISM_TOKENS: readonly string[] = ["date", "sleep", "uuidgen", "shuf", "jot", "random", "mkpasswd"];

/** Package managers whose install/update verbs hit the network. */
const PACKAGE_MANAGERS: readonly string[] = ["npm", "yarn", "pnpm", "bun", "pip", "pip3", "pipx", "uv", "cargo", "poetry", "gem", "composer"];
const NETWORK_VERBS: readonly string[] = [
	"install", "ci", "add", "update", "upgrade", "sync", "fetch", "pull", "clone", "publish", "login", "logout", "link", "unlink",
];

/** git verbs that mutate source code. */
const GIT_MUTATION_VERBS: readonly string[] = [
	"apply", "checkout", "reset", "clean", "restore", "stash", "revert", "cherry-pick", "merge", "rebase", "am", "format-patch",
];

/** Declared write paths that indicate source-code mutation. */
const SOURCE_WRITE_PATTERNS: readonly RegExp[] = [
	/^src\//,
	/^lib\//,
	/^extensions\//,
	/^tests?\//,
	/^tools\//,
	/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|c|cpp|cc|h|hpp|java|rb|php|sh|zsh)$/,
];

/** True when a recipe command looks non-deterministic / network-bound. */
export function cacheForbiddenReason(command: readonly string[], writes: readonly string[]): string | undefined {
	const tokens = new Set(command.map((c) => c.trim()));
	for (const token of NETWORK_TOKENS) {
		if (tokens.has(token)) {
			return `command contains "${token}" (network / external API access is not cacheable)`;
		}
	}
	for (const token of NONDETERMINISM_TOKENS) {
		if (tokens.has(token)) {
			return `command contains "${token}" (time/randomness is not deterministic)`;
		}
	}
	for (const manager of PACKAGE_MANAGERS) {
		if (tokens.has(manager)) {
			for (const verb of NETWORK_VERBS) {
				if (tokens.has(verb)) {
					return `command "${manager} ${verb}" may hit the network (not cacheable)`;
				}
			}
		}
	}
	if (tokens.has("git")) {
		for (const verb of GIT_MUTATION_VERBS) {
			if (tokens.has(verb)) {
				return `command "git ${verb}" mutates source code (not cacheable)`;
			}
		}
	}
	for (const write of writes) {
		for (const pattern of SOURCE_WRITE_PATTERNS) {
			if (pattern.test(write)) {
				return `declared write "${write}" modifies source code (not cacheable)`;
			}
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Cache policy parsing (recipes.yaml `cache:` block)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const QUANT_DOMAINS: readonly string[] = ["default", "quant"];

function asStringArray(value: unknown, label: string, issues: string[]): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		issues.push(`${label} must be an array of strings`);
		return [];
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			issues.push(`${label} entries must be strings`);
			continue;
		}
		out.push(item);
	}
	return out;
}

/**
 * Parse a recipe `cache:` block. NEVER fatal: every problem disables caching
 * (with a recorded issue) and keeps the recipe executable. A malformed or
 * semantically forbidden cache declaration must fail safe — a miss is always
 * safer than a false hit.
 */
export function parseCachePolicy(raw: unknown, command: string[], writes: string[]): CachePolicyParseResult {
	const issues: string[] = [];
	if (raw === undefined || raw === null) return { policy: DEFAULT_CACHE_POLICY, issues };
	if (!isRecord(raw)) {
		return { policy: { ...DEFAULT_CACHE_POLICY }, issues: ['"cache" must be a mapping (e.g. cache: { enabled: true, inputs: [...] })'] };
	}

	const enabled = raw.enabled === true;
	const version = typeof raw.version === "number" && Number.isInteger(raw.version) && raw.version > 0 ? raw.version : 1;
	if (raw.version !== undefined && (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version <= 0)) {
		issues.push('"cache.version" must be a positive integer');
	}

	// P6-D: cache domain (default vs quant). The quant domain is still opt-in
	// via `enabled: true` — declaring `domain: quant` alone never enables it.
	let domain: CacheDomain = "default";
	if (raw.domain !== undefined) {
		if (typeof raw.domain === "string" && QUANT_DOMAINS.includes(raw.domain)) {
			domain = raw.domain as CacheDomain;
		} else {
			issues.push('"cache.domain" must be "default" or "quant"');
		}
	}

	// P6-D: quant contract declaration (type + manifest path).
	const { decl: quantContractDecl, issues: quantIssues } = parseQuantContractDecl(raw.quantContract);
	issues.push(...quantIssues.map((message) => `quantContract: ${message}`));
	if (domain === "quant" && quantContractDecl === null && quantIssues.length === 0) {
		issues.push('"cache.domain: quant" requires a "cache.quantContract" declaration ({ type, manifest })');
	}
	if (quantContractDecl !== null && domain !== "quant") {
		issues.push('"cache.quantContract" requires "cache.domain: quant" (quant contract caching is a separate domain)');
	}

	let mode: CacheMode = "result-only";
	if (raw.mode !== undefined) {
		if (raw.mode === "result-only" || raw.mode === "artifacts") {
			mode = raw.mode;
		} else {
			issues.push('"cache.mode" must be "result-only" or "artifacts"');
		}
	}

	let successOnly = true;
	if (raw.successOnly !== undefined) {
		if (typeof raw.successOnly !== "boolean") {
			issues.push('"cache.successOnly" must be a boolean');
		} else {
			successOnly = raw.successOnly;
		}
	}

	const inputs = asStringArray(raw.inputs, '"cache.inputs"', issues);
	const outputs = asStringArray(raw.outputs, '"cache.outputs"', issues);
	const envNames = asStringArray(raw.environment, '"cache.environment"', issues);
	for (const name of envNames) {
		if (!ENV_NAME_RE.test(name)) {
			issues.push(`"cache.environment" contains invalid env var name "${name}"`);
		}
	}
	const upstream = asStringArray(raw.upstream, '"cache.upstream"', issues);

	let maxAgeSeconds: number | null = null;
	if (raw.maxAgeSeconds !== undefined && raw.maxAgeSeconds !== null) {
		if (typeof raw.maxAgeSeconds !== "number" || !Number.isFinite(raw.maxAgeSeconds) || raw.maxAgeSeconds <= 0) {
			issues.push('"cache.maxAgeSeconds" must be a positive number or null');
		} else {
			maxAgeSeconds = raw.maxAgeSeconds;
		}
	}

	const toolchain: ToolchainDecl[] = [];
	if (raw.toolchain !== undefined) {
		if (!Array.isArray(raw.toolchain)) {
			issues.push('"cache.toolchain" must be an array');
		} else {
			const seen = new Set<string>();
			for (const entry of raw.toolchain) {
				if (typeof entry === "string") {
					if (!(entry in BUILTIN_TOOLCHAIN_QUERIES)) {
						issues.push(`"cache.toolchain" contains unknown tool "${entry}" (built-ins: ${Object.keys(BUILTIN_TOOLCHAIN_QUERIES).join(", ")}; custom tools use { name, command: [argv], timeoutMs? })`);
						continue;
					}
					if (seen.has(entry)) continue;
					seen.add(entry);
					toolchain.push({ name: entry, command: [...(BUILTIN_TOOLCHAIN_QUERIES[entry] ?? [])], timeoutMs: VERSION_QUERY_TIMEOUT_MS });
				} else if (isRecord(entry)) {
					const name = entry.name;
					if (typeof name !== "string" || name.trim().length === 0 || !ENV_NAME_RE.test(name)) {
						issues.push('"cache.toolchain" custom entries need a valid "name" (letters, digits, underscore)');
						continue;
					}
					if (seen.has(name)) continue;
					const commandRaw = entry.command;
					if (!Array.isArray(commandRaw) || commandRaw.length === 0 || commandRaw.some((c) => typeof c !== "string" || c.trim().length === 0)) {
						issues.push(`"cache.toolchain" entry "${name}" needs a non-empty argv "command" (no shell strings)`);
						continue;
					}
					const timeoutMs = typeof entry.timeoutMs === "number" && entry.timeoutMs > 0 && entry.timeoutMs <= 15_000 ? entry.timeoutMs : VERSION_QUERY_TIMEOUT_MS;
					if (entry.timeoutMs !== undefined && (typeof entry.timeoutMs !== "number" || entry.timeoutMs <= 0 || entry.timeoutMs > 15_000)) {
						issues.push(`"cache.toolchain" entry "${name}" timeoutMs must be 1..15000`);
					}
					seen.add(name);
					toolchain.push({ name, command: commandRaw as string[], timeoutMs });
				} else {
					issues.push('"cache.toolchain" entries must be tool names or { name, command, timeoutMs? } mappings');
				}
			}
		}
	}

	const policy: RecipeCachePolicy = {
		enabled,
		version,
		domain,
		quantContract: domain === "quant" ? quantContractDecl : null,
		mode,
		successOnly,
		inputs,
		outputs,
		environment: envNames,
		toolchain,
		maxAgeSeconds,
		upstream,
	};

	// ---- semantic safety rules (only when caching would be active) ----
	if (!enabled) return { policy, issues };
	if (issues.length > 0) {
		// Structural problems already exist — never cache on a broken policy.
		policy.enabled = false;
		issues.push("cache disabled because the cache declaration has errors");
		return { policy, issues };
	}
	if (mode === "artifacts" && outputs.length === 0) {
		policy.enabled = false;
		issues.push('"cache.mode: artifacts" requires a non-empty "cache.outputs" list (empty outputs forbid restoring any file)');
		return { policy, issues };
	}
	if (mode === "result-only" && outputs.length > 0) {
		issues.push('"cache.outputs" is ignored in result-only mode (outputs only apply to artifacts mode)');
	}
	const forbidden = cacheForbiddenReason(command, writes);
	if (forbidden) {
		policy.enabled = false;
		issues.push(`recipe is not cacheable: ${forbidden} — cache disabled for this recipe`);
		return { policy, issues };
	}
	if (mode === "artifacts") {
		issues.push("artifacts restore is disabled in this version — the recipe will always execute; only result metadata is stored");
	}
	return { policy, issues };
}

// ---------------------------------------------------------------------------
// Action key / record shapes (implementations live in action-key.ts /
// action-store.ts)
// ---------------------------------------------------------------------------

export interface InputFacts {
	files: number;
	dirs: number;
	symlinks: number;
	missingPatterns: number;
	protectedRefused: number;
	totalBytes: number;
	truncated: boolean;
}

/** One flat fingerprint entry (bounded list stored in records for diffs). */
export interface InputEntry {
	p: string;
	t: "file" | "dir" | "symlink" | "missing" | "protected";
	h: string;
	x?: 0 | 1;
}

export interface ActionKeyComponents {
	cacheSchemaVersion: number;
	cachePolicyVersion: number;
	packageVersion: string;
	recipeName: string;
	recipeDefinitionHash: string;
	cachePolicyHash: string;
	argvHash: string;
	normalizedCwd: string;
	allowedMode: string;
	environmentHash: string;
	toolchainVersions: Record<string, string>;
	operatingSystem: string;
	architecture: string;
	lockfileHashes: Record<string, string>;
	inputMerkleHash: string;
	inputFacts: InputFacts;
	workbenchConfigHash: string;
	profileHash: string;
	gateSchemaHash: string;
	upstreamActionKeys: string[];
	/** P6-D: immutable quant-contract upstream key (null = default domain). */
	quantContractKey: string | null;
}

export interface ActionKey {
	key: string;
	components: ActionKeyComponents;
	/** P6-D: quant-contract facts resolved during key computation. */
	quantContractInfo?: QuantContractRecordInfo | null;
}

export interface CachedSummary {
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	artifactPaths: string[];
	timedOut: boolean;
	cancelled: boolean;
}

export interface ArtifactRecordInfo {
	mode: "result-only" | "artifacts";
	/** v1: always false — artifacts restore is disabled. */
	restored: boolean;
	restoreDisabled: boolean;
	outputs: string[];
}

export interface ActionRecord {
	schemaVersion: number;
	cachePolicyVersion: number;
	actionKey: string;
	recipe: string;
	mode: CacheMode;
	success: boolean;
	exitCode: number | null;
	expectedExitCodes: number[];
	createdAt: string;
	sourceRunId: string;
	durationMs: number;
	cwd: string;
	argvHash: string;
	definitionHash: string;
	cachePolicyHash: string;
	environmentNames: string[];
	/** name -> sha256(value) | "unset" — raw values are never stored. */
	envValueHashes: Record<string, string>;
	toolchainVersions: Record<string, string>;
	os: string;
	arch: string;
	lockfileHashes: Record<string, string>;
	inputMerkleHash: string;
	inputFacts: InputFacts;
	inputEntries: InputEntry[] | null;
	workbenchConfigHash: string;
	profileHash: string;
	gateSchemaHash: string;
	upstreamActionKeys: string[];
	/** P6-D: immutable quant-contract upstream key (null = default domain). */
	quantContractKey: string | null;
	/** P6-D: quant-contract facts for lineage/explain (null = default domain). */
	quantContractInfo: QuantContractRecordInfo | null;
	allowedMode: string;
	packageVersion: string;
	summary: CachedSummary;
	artifacts: ArtifactRecordInfo;
}

export const KNOWN_LOCKFILES: readonly string[] = [
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lockb",
	"uv.lock",
	"poetry.lock",
	"Pipfile.lock",
	"Cargo.lock",
	"go.sum",
	"Gemfile.lock",
	"composer.lock",
	"requirements.lock",
];
