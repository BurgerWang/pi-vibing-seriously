/**
 * P7 write authority — pure decision logic, no Pi imports.
 *
 * Development-first Sol/worker authority (wired into the Pi runtime — the
 * `tool_call` guard, the session-scoped lease state, the user-only slash
 * commands in core/lease-command.ts and the compact footer; this module
 * stays import-free and unit-testable):
 *
 *   - actor identity: `sol-commander | delegated-worker | other-controller`.
 *     A delegated worker is identified ONLY by the existing
 *     WORKBENCH_AGENT_ROLE=worker environment contract; no project config
 *     can self-label any controller as Sol or as a worker.
 *   - the serialized compatibility policy id remains exactly
 *     `worker-first-strict` and applies ONLY to the approved Sol commander;
 *     current DEV behavior is development-first: ordinary canonical
 *     project-relative edit/write are direct, while high-risk paths retain
 *     the explicit user-issued lease boundary. No persisted/prompt/config
 *     value can weaken or opt out of those boundaries.
 *     Delegated workers and other controllers are OUTSIDE this policy
 *     (policy non-applicability): the existing worker guards remain
 *     authoritative for workers, and other controllers are not newly
 *     denied by this module.
 *   - the current Sol DEV surface is the fixed historical read/control
 *     allowlist plus edit/write; bash and foreign tools remain absent.
 *   - the second-layer commander decision (Sol only): bash is always
 *     blocked; ordinary edit/write are direct; high-risk edit/write require
 *     a valid user-issued temporary lease; every other tool outside the
 *     allowlist is blocked.
 *   - temporary commander write leases: default locked, allowed reasons,
 *     project-relative exact/subtree paths (absolute POSIX, Windows drive
 *     and backslash-root paths are categorically rejected BEFORE any
 *     normalization; `..` escapes are refused), edit/write only (never
 *     bash), max 10 calls, max 30 minutes, one call consumed per
 *     successful authorized write, timeout/exhaustion, revocation on
 *     leaving DEV / model change / session end, and a serializable
 *     compact-safe summary and restore. Two-step non-TUI confirmation is
 *     an explicit two-part token (both bounded distinct parts issued,
 *     both exact parts required, both consumed on success, neither ever
 *     summarized); issuance/confirmation is wired through the user-only
 *     slash commands in core/lease-command.ts (never model tools).
 *
 * There is no project.yaml opt-out: the allowlist, the lease reasons and
 * the lease limits are fixed constants, and policy restore never consults
 * the prompt.
 */

import {
	COMMANDER_MODEL_ID,
	COMMANDER_PROVIDERS,
	WORKER_ROLE,
} from "./worker-policy.ts";

// ---------------------------------------------------------------------------
// Actor identity
// ---------------------------------------------------------------------------

export type ActorRole = "sol-commander" | "delegated-worker" | "other-controller";

export const ACTOR_ROLES: readonly ActorRole[] = ["sol-commander", "delegated-worker", "other-controller"];

/** The write policy is exactly worker-first-strict — there is no other value. */
export type WritePolicy = "worker-first-strict";

export const WRITE_POLICIES: readonly WritePolicy[] = ["worker-first-strict"];

export interface ActorFacts {
	/** Value of the existing WORKBENCH_AGENT_ROLE env contract (worker child only). */
	roleEnv?: string | undefined;
	provider?: string | undefined;
	model?: string | undefined;
	/**
	 * Project-config role claim (e.g. project.yaml). NEVER consulted for
	 * identity: other controllers cannot self-label as Sol or as a worker
	 * through project config. Accepted only so callers can pass the raw
	 * config value without special-casing it.
	 */
	configRole?: unknown;
}

/** GPT-5.6 Sol on an approved first-party provider (same facts as worker-policy). */
export function isApprovedSolIdentity(provider: string | undefined, model: string | undefined): boolean {
	return model === COMMANDER_MODEL_ID && provider !== undefined && COMMANDER_PROVIDERS.includes(provider);
}

/**
 * Resolve the actor role. The env worker contract wins over everything (a
 * worker child is the only process where the workbench sets it); otherwise
 * identity is the provider/model pair. Project config is never consulted.
 */
export function detectActorRole(facts: ActorFacts): ActorRole {
	if (facts.roleEnv === WORKER_ROLE) return "delegated-worker";
	if (isApprovedSolIdentity(facts.provider, facts.model)) return "sol-commander";
	return "other-controller";
}

/**
 * Default write policy: worker-first-strict for GPT-5.6 Sol on approved
 * openai/openai-codex providers; `undefined` (policy NOT applicable) for
 * every other controller — this module neither grants nor denies non-Sol
 * actors anything; existing guards govern them.
 */
export function defaultWritePolicy(
	provider: string | undefined,
	model: string | undefined,
): WritePolicy | undefined {
	return isApprovedSolIdentity(provider, model) ? "worker-first-strict" : undefined;
}

/**
 * Session policy restore. The policy is FIXED: approved Sol always
 * resolves to worker-first-strict — a persisted/prompt/config claim can
 * neither weaken nor opt out of it (a persisted "deny" cannot apply to
 * Sol). Non-Sol identities resolve to `undefined` (policy not applicable).
 * The persisted value and the prompt are accepted so callers can pass
 * the raw values without special-casing them but are NEVER consulted —
 * policy restore is prompt-independent and persistence-independent.
 */
export function resolveSessionWritePolicy(facts: {
	provider?: string | undefined;
	model?: string | undefined;
	persistedPolicy?: unknown;
	prompt?: string | undefined;
}): WritePolicy | undefined {
	return defaultWritePolicy(facts.provider, facts.model);
}

// ---------------------------------------------------------------------------
// Strict Sol DEV allowlist
// ---------------------------------------------------------------------------

/**
 * The exact fixed-order strict Sol DEV tool matrix. Order is part of the
 * contract (P6-B stable-prefix discipline): never reorder, never add tools
 * implicitly. bash/edit/write and foreign tools are excluded by
 * construction.
 */
export const STRICT_SOL_DEV_ALLOWLIST: readonly string[] = [
	"read",
	"grep",
	"find",
	"ls",
	"workbench_project_inspect",
	"workbench_run_recipe",
	"workbench_read_run",
	"workbench_run_gate",
	"workbench_read_gate",
	"workbench_list_gates",
	"workbench_compare_runs",
	"workbench_delegate_worker",
	"workbench_review_worker_diff",
	"workbench_delegation_status",
	// P8b: the public read-only recovery tool is appended LAST (14 → 15), in
	// the same order as WORKBENCH_TOOL_NAMES / MODE_TOOLS (stable-prefix
	// discipline: never reorder, never add tools implicitly).
	"workbench_recover_tool_result",
];

/**
 * Current development-first DEV surface. The historical strict allowlist is
 * retained for compatibility, while ordinary edit/write are advertised to
 * the commander and the second-layer risk gate below remains authoritative.
 */
export const DEVELOPMENT_FIRST_SOL_DEV_ALLOWLIST: readonly string[] = [
	...STRICT_SOL_DEV_ALLOWLIST,
	"edit",
	"write",
];

export const STRICT_ALLOWLIST_SET: ReadonlySet<string> = new Set(STRICT_SOL_DEV_ALLOWLIST);

export function isInStrictAllowlist(toolName: string): boolean {
	return STRICT_ALLOWLIST_SET.has(toolName);
}

/**
 * Foreign-tool removal helper: keep only allowlist members from the
 * currently active set, in the FIXED canonical order — never the order Pi
 * or another extension reports them in.
 */
export function applyStrictAllowlist(currentlyActive: readonly string[]): string[] {
	return STRICT_SOL_DEV_ALLOWLIST.filter((tool) => currentlyActive.includes(tool));
}

/** Active tools that are NOT part of the strict allowlist, sorted (stable). */
export function foreignTools(currentlyActive: readonly string[]): string[] {
	return [...new Set(currentlyActive)].filter((tool) => !STRICT_ALLOWLIST_SET.has(tool)).sort();
}

// ---------------------------------------------------------------------------
// Temporary commander write lease (pure state)
// ---------------------------------------------------------------------------

export const ALLOWED_LEASE_REASONS = [
	"bootstrap-policy",
	"worker-unavailable",
	"security-emergency",
	"user-directed",
] as const;
export type LeaseReason = (typeof ALLOWED_LEASE_REASONS)[number];

export const LEASE_TOOLS = ["edit", "write"] as const;
export type LeaseTool = (typeof LEASE_TOOLS)[number];

/** Maximum authorized calls per lease. */
export const MAX_LEASE_CALLS = 10;
/** Maximum lease duration (30 minutes). */
export const MAX_LEASE_DURATION_MS = 30 * 60 * 1000;
const MAX_LEASE_ID_LENGTH = 64;
/** Per-part bound for the two-step non-TUI confirmation token. */
const MAX_CONFIRMATION_TOKEN_LENGTH = 64;
const MAX_SUMMARY_LENGTH = 160;

/** Custom session-entry type for the persisted write-lease state (runtime persist/restore via serializeLease / loadLeaseFromEntries). */
export const LEASE_STATE_ENTRY_TYPE = "workbench-write-lease";

export type LeaseStatus = "locked" | "pending" | "active" | "expired" | "exhausted" | "revoked";

export interface WriteLease {
	id: string;
	reason: LeaseReason;
	/** Project-relative path rules: exact paths, or subtrees via `/**` or a trailing `/`. */
	paths: readonly string[];
	/** Subset of edit/write — leases never authorize bash. */
	tools: readonly LeaseTool[];
	maxCalls: number;
	callsUsed: number;
	issuedAt: string;
	expiresAt: string;
	/**
	 * Two-step non-TUI confirmation: two bounded non-empty DISTINCT parts,
	 * both required for confirmation and both consumed (emptied) on
	 * success. Never appears in compact summaries.
	 */
	confirmationTokenA: string;
	confirmationTokenB: string;
	confirmationStatus: "pending" | "confirmed";
	confirmedAt?: string;
	revokedReason?: string;
	updatedAt: string;
}

export function isAllowedLeaseReason(raw: string): raw is LeaseReason {
	return (ALLOWED_LEASE_REASONS as readonly string[]).includes(raw);
}

/**
 * Categorical absolute-path check, applied BEFORE any normalization:
 * POSIX roots (`/`), backslash roots (`\`, `\\server\share`) and Windows
 * drive paths (`C:\...`, `C:/...`, even drive-relative `C:...`) are never
 * project-relative.
 */
function isAbsolutePath(raw: string): boolean {
	if (raw.startsWith("/") || raw.startsWith("\\")) return true;
	return /^[A-Za-z]:/.test(raw);
}

/**
 * Normalize a project-relative path rule. Rules are exact paths or
 * subtrees (`src/**`, `src/`); absolute POSIX, Windows drive and
 * backslash-root paths are categorically rejected before normalization,
 * and `..` escapes are refused. Returns the normalized rule or undefined.
 */
export function normalizeLeaseRule(raw: string): { path: string; subtree: boolean } | undefined {
	const trimmed = raw.trim();
	if (!trimmed || isAbsolutePath(trimmed)) return undefined;
	const subtree =
		trimmed.endsWith("/**") || trimmed.endsWith("\\**") || trimmed.endsWith("/") || trimmed.endsWith("\\");
	const withoutSuffix = subtree ? trimmed.replace(/(\/\*\*|\\\*\*|[\\/])$/, "") : trimmed;
	if (!withoutSuffix) return undefined;
	const path = normalizeProjectRelative(withoutSuffix);
	if (!path) return undefined;
	// Only the exact /** subtree marker is a wildcard; any other glob is refused.
	if (path.includes("*")) return undefined;
	return { path, subtree };
}

/**
 * Normalize a project-relative candidate/rule to forward-slash segments,
 * dropping empty and `.` segments. Absolute paths are categorically
 * rejected BEFORE normalization, and any `..` segment is an escape that
 * refuses the whole path.
 */
function normalizeProjectRelative(raw: string): string | undefined {
	if (isAbsolutePath(raw)) return undefined;
	const segments = raw.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
	if (segments.length === 0) return undefined;
	for (const segment of segments) {
		if (segment === "..") return undefined;
	}
	return segments.join("/");
}

const DIRECT_WRITE_HIGH_RISK_BASENAMES = new Set([
	"agents.md",
	"package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "deno.lock",
	"pyproject.toml", "poetry.lock", "uv.lock", "pipfile", "pipfile.lock", "requirements.txt",
	"cargo.toml", "cargo.lock", "go.mod", "go.sum", "composer.json", "composer.lock", "gemfile", "gemfile.lock",
	"dockerfile", "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml",
]);
const DIRECT_WRITE_HIGH_RISK_SEGMENTS = new Set([
	".pi", ".github", ".gitlab", "deploy", "deployment", "infra", "k8s", "kubernetes", "migrations", "terraform",
]);
const DIRECT_WRITE_HIGH_RISK_NAME = /(?:auth|security|permission|policy|credential|secret|crypto|lease|release|migration)/iu;

/**
 * Fixed, prompt-independent high-risk boundary for direct commander writes.
 * Ordinary source/tests/docs paths return undefined and need no lease. Paths
 * that can change dependencies, permissions, security, deployment, migration,
 * Pi policy, or release authority retain the explicit user-issued lease.
 */
export function directDevelopmentWriteBlockReason(path: string, input?: unknown): string | undefined {
	const normalized = normalizeProjectRelative(path);
	if (normalized === undefined || path !== path.trim() || path.includes("\\") || normalized !== path) {
		return "Direct development write requires a canonical project-relative path";
	}
	if (typeof input === "object" && input !== null) {
		for (const key of ["content", "oldText", "newText"] as const) {
			const value = (input as Record<string, unknown>)[key];
			if (typeof value === "string" && value.includes("\0")) {
				return "Direct development write refuses binary/NUL content";
			}
		}
	}
	const segments = normalized.toLowerCase().split("/");
	const basename = segments.at(-1) ?? "";
	if (
		DIRECT_WRITE_HIGH_RISK_BASENAMES.has(basename)
		|| segments.some((segment) => DIRECT_WRITE_HIGH_RISK_SEGMENTS.has(segment))
		|| segments.some((segment) => DIRECT_WRITE_HIGH_RISK_NAME.test(segment))
	) {
		return `Direct development write on high-risk path "${normalized}" requires an explicit user-issued write lease`;
	}
	return undefined;
}

/**
 * Does the lease authorize this candidate path? The candidate must be
 * project-relative — absolute POSIX, backslash-root and Windows drive
 * paths are categorically rejected BEFORE normalization (so a rule like
 * `repo/**` can never match `/repo/...`, `\repo\...` or `C:\repo\...`),
 * and `..` escapes are refused — and must match an exact rule or a
 * subtree rule.
 */
export function isLeasePathAuthorized(lease: WriteLease | undefined, candidatePath: string): boolean {
	if (!lease) return false;
	if (isAbsolutePath(candidatePath)) return false;
	const candidate = normalizeProjectRelative(candidatePath);
	if (!candidate) return false;
	for (const rawRule of lease.paths) {
		const rule = normalizeLeaseRule(rawRule);
		if (!rule) continue;
		if (candidate === rule.path) return true;
		if (rule.subtree && (candidate === rule.path || candidate.startsWith(`${rule.path}/`))) return true;
	}
	return false;
}

export function leaseCoversTool(lease: WriteLease, toolName: string): boolean {
	return (toolName === "edit" || toolName === "write") && lease.tools.includes(toolName);
}

/**
 * Derive the lease status from its fields. No lease at all is "locked"
 * (the default). Terminal precedence: revoked > expired > exhausted; a
 * confirmed, unexpired lease with remaining calls is "active", otherwise
 * it is still "pending" confirmation.
 */
export function leaseStatus(lease: WriteLease | undefined, now: string): LeaseStatus {
	if (!lease) return "locked";
	if (lease.revokedReason !== undefined) return "revoked";
	const nowMs = Date.parse(now);
	const expiresMs = Date.parse(lease.expiresAt);
	if (Number.isNaN(nowMs) || Number.isNaN(expiresMs) || nowMs >= expiresMs) return "expired";
	if (lease.callsUsed >= lease.maxCalls) return "exhausted";
	return lease.confirmationStatus === "confirmed" ? "active" : "pending";
}

export interface IssueLeaseInput {
	id: string;
	reason: string;
	paths: readonly string[];
	/** Defaults to edit+write. Anything outside edit/write is refused (never bash). */
	tools?: readonly string[];
	/** Defaults to MAX_LEASE_CALLS (10). */
	maxCalls?: number;
	/** Defaults to MAX_LEASE_DURATION_MS (30 minutes). */
	durationMs?: number;
	/**
	 * Two-step non-TUI confirmation: two bounded non-empty DISTINCT parts
	 * (generated by newConfirmationParts in core/lease-command.ts and
	 * displayed only by renderLeaseIssued). Both exact parts are required
	 * to confirm; both are consumed on success.
	 */
	confirmationTokenA: string;
	confirmationTokenB: string;
	now: string;
}

export type LeaseIssueResult = { ok: true; lease: WriteLease } | { ok: false; error: string };

/** Issue a lease: validated, deterministic, starts PENDING confirmation. */
export function issueLease(input: IssueLeaseInput): LeaseIssueResult {
	const id = input.id.trim();
	if (!id || id.length > MAX_LEASE_ID_LENGTH) {
		return { ok: false, error: `lease id must be a non-empty string of at most ${MAX_LEASE_ID_LENGTH} characters` };
	}
	if (!isAllowedLeaseReason(input.reason)) {
		return { ok: false, error: `lease reason must be one of: ${ALLOWED_LEASE_REASONS.join(", ")}` };
	}
	if (!input.paths || input.paths.length === 0) {
		return { ok: false, error: "lease requires at least one project-relative path rule" };
	}
	const paths: string[] = [];
	for (const raw of input.paths) {
		const rule = normalizeLeaseRule(raw);
		if (!rule) {
			return {
				ok: false,
				error: `invalid lease path rule "${raw}": must be project-relative (exact path or /** subtree), never absolute (POSIX, Windows drive, backslash-root) and never escaping via ".."`,
			};
		}
		paths.push(raw.trim());
	}
	const tools = input.tools ?? [...LEASE_TOOLS];
	if (tools.length === 0) {
		return { ok: false, error: "lease must authorize at least one of: edit, write" };
	}
	for (const tool of tools) {
		if (tool !== "edit" && tool !== "write") {
			return { ok: false, error: `lease tool "${tool}" is not authorized; leases cover edit/write only, never bash` };
		}
	}
	const maxCalls = input.maxCalls ?? MAX_LEASE_CALLS;
	if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > MAX_LEASE_CALLS) {
		return { ok: false, error: `lease maxCalls must be an integer between 1 and ${MAX_LEASE_CALLS}` };
	}
	const durationMs = input.durationMs ?? MAX_LEASE_DURATION_MS;
	if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > MAX_LEASE_DURATION_MS) {
		return { ok: false, error: `lease duration must be between 1ms and ${MAX_LEASE_DURATION_MS}ms (30 minutes)` };
	}
	const tokenA = input.confirmationTokenA.trim();
	const tokenB = input.confirmationTokenB.trim();
	if (!tokenA || !tokenB || tokenA.length > MAX_CONFIRMATION_TOKEN_LENGTH || tokenB.length > MAX_CONFIRMATION_TOKEN_LENGTH) {
		return {
			ok: false,
			error: `lease confirmation requires two non-empty parts of at most ${MAX_CONFIRMATION_TOKEN_LENGTH} characters each`,
		};
	}
	if (tokenA === tokenB) {
		return { ok: false, error: "lease confirmation parts must be distinct" };
	}
	const issuedMs = Date.parse(input.now);
	if (Number.isNaN(issuedMs)) return { ok: false, error: "lease issuance time must be a valid ISO timestamp" };
	const issuedAt = new Date(issuedMs).toISOString();
	const lease: WriteLease = {
		id,
		reason: input.reason as LeaseReason,
		paths,
		tools: [...tools] as LeaseTool[],
		maxCalls,
		callsUsed: 0,
		issuedAt,
		expiresAt: new Date(issuedMs + durationMs).toISOString(),
		confirmationTokenA: tokenA,
		confirmationTokenB: tokenB,
		confirmationStatus: "pending",
		updatedAt: issuedAt,
	};
	return { ok: true, lease };
}

export type LeaseConfirmResult = { ok: true; lease: WriteLease } | { ok: false; error: string };

/**
 * Two-step non-TUI confirmation facts: the lease becomes active only after
 * BOTH exact token parts are confirmed; both parts are consumed (cleared)
 * on success and a confirmed lease can never be re-confirmed.
 */
export function confirmLease(lease: WriteLease, tokenA: string, tokenB: string, now: string): LeaseConfirmResult {
	const status = leaseStatus(lease, now);
	if (status === "revoked") return { ok: false, error: `lease ${lease.id} is revoked and cannot be confirmed` };
	if (status === "expired") return { ok: false, error: `lease ${lease.id} expired before confirmation` };
	if (status === "exhausted") return { ok: false, error: `lease ${lease.id} is exhausted and cannot be confirmed` };
	if (lease.confirmationStatus === "confirmed") {
		return { ok: false, error: `lease ${lease.id} is already confirmed` };
	}
	if (
		lease.confirmationTokenA === "" ||
		lease.confirmationTokenB === "" ||
		tokenA !== lease.confirmationTokenA ||
		tokenB !== lease.confirmationTokenB
	) {
		return { ok: false, error: `confirmation token mismatch for lease ${lease.id}: both exact parts are required` };
	}
	return {
		ok: true,
		lease: {
			...lease,
			confirmationStatus: "confirmed",
			confirmationTokenA: "",
			confirmationTokenB: "",
			confirmedAt: now,
			updatedAt: now,
		},
	};
}

export type LeaseConsumeResult = { ok: true; lease: WriteLease } | { ok: false; error: string };

/**
 * Consume exactly one lease call per successful authorized write. Refused
 * (without consumption) when the lease is not active, the tool is not
 * covered, or the path is not authorized.
 */
export function consumeLeaseCall(
	lease: WriteLease,
	toolName: string,
	path: string,
	now: string,
): LeaseConsumeResult {
	const status = leaseStatus(lease, now);
	if (status !== "active") {
		return { ok: false, error: `lease ${lease.id} is ${status}; only active leases authorize write calls` };
	}
	if (!leaseCoversTool(lease, toolName)) {
		return { ok: false, error: `lease ${lease.id} authorizes only ${lease.tools.join(", ")}` };
	}
	if (!isLeasePathAuthorized(lease, path)) {
		return { ok: false, error: `lease ${lease.id} does not authorize path "${path}"` };
	}
	return { ok: true, lease: { ...lease, callsUsed: lease.callsUsed + 1, updatedAt: now } };
}

/** Revoke a lease (terminal; idempotent). */
export function revokeLease(lease: WriteLease, reason: string, now: string): WriteLease {
	if (lease.revokedReason !== undefined) return lease;
	return { ...lease, revokedReason: reason.trim() || "revoked", updatedAt: now };
}

export interface LeaseRevokeFacts {
	mode?: string | undefined;
	provider?: string | undefined;
	model?: string | undefined;
	sessionEnded?: boolean | undefined;
}

/**
 * Policy-required revocation check: leaving DEV mode, commander model /
 * provider change, and session end each require revocation. Returns the
 * reason, or undefined when no revocation is required (already-revoked
 * leases need no further action). Expiry/exhaustion are statuses, not
 * revocations — they surface through `leaseStatus`.
 */
export function leaseRevokeReason(lease: WriteLease | undefined, facts: LeaseRevokeFacts): string | undefined {
	if (!lease || lease.revokedReason !== undefined) return undefined;
	if (facts.sessionEnded === true) return "session ended";
	if (facts.mode !== undefined && facts.mode !== "DEV") {
		return `write leases are revoked when leaving DEV mode (current mode: ${facts.mode})`;
	}
	if (!isApprovedSolIdentity(facts.provider, facts.model)) {
		return "commander model/provider change; write leases are bound to GPT-5.6 Sol on approved providers";
	}
	return undefined;
}

/**
 * Only the worker-first-strict policy (approved Sol) may hold a
 * user-issued lease; `undefined` (policy not applicable) never can.
 */
export function canIssueLease(policy: WritePolicy | undefined): boolean {
	return policy === "worker-first-strict";
}

// ---------------------------------------------------------------------------
// Lease serialization / restore / compact summary
// ---------------------------------------------------------------------------

export interface LeaseRecord {
	id: string;
	reason: LeaseReason;
	paths: string[];
	tools: string[];
	maxCalls: number;
	callsUsed: number;
	issuedAt: string;
	expiresAt: string;
	confirmationTokenA: string;
	confirmationTokenB: string;
	confirmationStatus: "pending" | "confirmed";
	confirmedAt?: string;
	revokedReason?: string;
	updatedAt: string;
}

/** JSON-safe serialization (both confirmation parts are carried, never the summary). */
export function serializeLease(lease: WriteLease): LeaseRecord {
	return {
		id: lease.id,
		reason: lease.reason,
		paths: [...lease.paths],
		tools: [...lease.tools],
		maxCalls: lease.maxCalls,
		callsUsed: lease.callsUsed,
		issuedAt: lease.issuedAt,
		expiresAt: lease.expiresAt,
		confirmationTokenA: lease.confirmationTokenA,
		confirmationTokenB: lease.confirmationTokenB,
		confirmationStatus: lease.confirmationStatus,
		confirmedAt: lease.confirmedAt,
		revokedReason: lease.revokedReason,
		updatedAt: lease.updatedAt,
	};
}

/**
 * Restore a lease from a persisted record, fail-closed: any invalid field
 * (unknown reason, absolute/escaping path rules, bash-like tools,
 * out-of-range calls/duration, malformed timestamps, missing/identical/
 * overlong confirmation parts while pending, or unconsumed confirmation
 * parts while confirmed) refuses the whole record.
 */
export function restoreLease(raw: unknown): WriteLease | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	const id = typeof r.id === "string" ? r.id.trim() : "";
	if (!id || id.length > MAX_LEASE_ID_LENGTH) return undefined;
	if (typeof r.reason !== "string" || !isAllowedLeaseReason(r.reason)) return undefined;
	if (!Array.isArray(r.paths)) return undefined;
	const paths: string[] = [];
	for (const item of r.paths) {
		if (typeof item !== "string") return undefined;
		const rule = normalizeLeaseRule(item);
		if (!rule) return undefined;
		paths.push(item.trim());
	}
	if (paths.length === 0) return undefined;
	if (!Array.isArray(r.tools)) return undefined;
	const tools: LeaseTool[] = [];
	for (const item of r.tools) {
		if (item !== "edit" && item !== "write") return undefined;
		tools.push(item);
	}
	if (tools.length === 0) return undefined;
	if (typeof r.maxCalls !== "number" || !Number.isInteger(r.maxCalls) || r.maxCalls < 1 || r.maxCalls > MAX_LEASE_CALLS) {
		return undefined;
	}
	if (
		typeof r.callsUsed !== "number" ||
		!Number.isInteger(r.callsUsed) ||
		r.callsUsed < 0 ||
		r.callsUsed > r.maxCalls
	) {
		return undefined;
	}
	const issuedAt = typeof r.issuedAt === "string" ? r.issuedAt : "";
	const expiresAt = typeof r.expiresAt === "string" ? r.expiresAt : "";
	if (!issuedAt || !expiresAt) return undefined;
	const issuedMs = Date.parse(issuedAt);
	const expiresMs = Date.parse(expiresAt);
	if (Number.isNaN(issuedMs) || Number.isNaN(expiresMs)) return undefined;
	const durationMs = expiresMs - issuedMs;
	if (durationMs < 1 || durationMs > MAX_LEASE_DURATION_MS) return undefined;
	const confirmationStatus = r.confirmationStatus;
	if (confirmationStatus !== "pending" && confirmationStatus !== "confirmed") return undefined;
	const confirmationTokenA = typeof r.confirmationTokenA === "string" ? r.confirmationTokenA : "";
	const confirmationTokenB = typeof r.confirmationTokenB === "string" ? r.confirmationTokenB : "";
	if (confirmationStatus === "pending") {
		// A pending lease carries both bounded, non-empty, DISTINCT parts.
		if (
			confirmationTokenA.length === 0 ||
			confirmationTokenB.length === 0 ||
			confirmationTokenA.length > MAX_CONFIRMATION_TOKEN_LENGTH ||
			confirmationTokenB.length > MAX_CONFIRMATION_TOKEN_LENGTH ||
			confirmationTokenA === confirmationTokenB
		) {
			return undefined;
		}
	}
	// A confirmed lease must have BOTH parts consumed; carried parts are tampering.
	if (confirmationStatus === "confirmed" && (confirmationTokenA.length > 0 || confirmationTokenB.length > 0)) {
		return undefined;
	}
	const confirmedAt = typeof r.confirmedAt === "string" && r.confirmedAt ? r.confirmedAt : undefined;
	const revokedReason = typeof r.revokedReason === "string" && r.revokedReason ? r.revokedReason : undefined;
	const updatedAt = typeof r.updatedAt === "string" && r.updatedAt ? r.updatedAt : issuedAt;
	return {
		id,
		reason: r.reason,
		paths,
		tools,
		maxCalls: r.maxCalls,
		callsUsed: r.callsUsed,
		issuedAt,
		expiresAt,
		confirmationTokenA: confirmationStatus === "confirmed" ? "" : confirmationTokenA,
		confirmationTokenB: confirmationStatus === "confirmed" ? "" : confirmationTokenB,
		confirmationStatus,
		confirmedAt,
		revokedReason,
		updatedAt,
	};
}

/** Minimal structural shape of a Pi custom session entry (mirrors state.ts). */
export interface LeaseStateEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/**
 * Reconstruct the persisted lease from session entries. Only entries whose
 * payload restores to a valid lease are adopted; later entries win. A
 * corrupt payload is skipped (fail-closed: the lease stays locked).
 */
export function loadLeaseFromEntries(entries: readonly LeaseStateEntry[]): WriteLease | undefined {
	let lease: WriteLease | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== LEASE_STATE_ENTRY_TYPE) continue;
		const restored = restoreLease(entry.data);
		if (restored) lease = restored;
	}
	return lease;
}

/**
 * Bounded compact-safe summary for the compaction note (the runtime
 * records it in the compact state). Carries
 * status, id, reason, call usage, tools and a path hint — NEVER either
 * confirmation token part.
 */
export function leaseCompactSummary(lease: WriteLease | undefined, now: string): string {
	if (!lease) return "WRITE-LEASE locked";
	const status = leaseStatus(lease, now);
	const paths = lease.paths.length <= 2 ? lease.paths.join(",") : `${lease.paths.length} path rules`;
	return `WRITE-LEASE ${status} ${lease.id} ${lease.reason} ${lease.callsUsed}/${lease.maxCalls} ${lease.tools.join(",")} ${paths}`.slice(
		0,
		MAX_SUMMARY_LENGTH,
	);
}

// ---------------------------------------------------------------------------
// Second-layer commander decision
// ---------------------------------------------------------------------------

export interface CommanderToolCallFacts {
	actor: ActorRole;
	toolName: string;
	input?: unknown;
	/** The current lease (if any); absent means locked. */
	lease?: WriteLease | undefined;
	/** Deterministic clock; defaults to the current time when omitted. */
	now?: string | undefined;
}

function extractPath(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const path = (input as { path?: unknown }).path;
	return typeof path === "string" ? path : undefined;
}

/**
 * Pure second-layer commander decision (wired into the Pi runtime's
 * `tool_call` guard). The guard applies ONLY to the
 * approved Sol commander under the development-first policy (whose
 * serialized compatibility id is worker-first-strict):
 * delegated workers and other controllers are OUTSIDE it — the existing
 * worker guards (worker-policy.ts) remain authoritative for workers, and
 * other controllers are not newly denied by this module. Semantics for
 * Sol:
 *   - bash is always blocked;
 *   - ordinary canonical project-relative edit/write are allowed directly;
 *   - high-risk edit/write require a valid user-issued lease;
 *   - every other tool outside the strict allowlist is blocked;
 *   - reasons direct Sol to workbench_delegate_worker or an explicit
 *     temporary commander write lease.
 */
export function commanderToolCallBlockReason(facts: CommanderToolCallFacts): string | undefined {
	if (facts.actor !== "sol-commander") return undefined;
	const { toolName } = facts;
	const now = facts.now ?? new Date().toISOString();
	if (toolName === "bash") {
		return "Development safety blocks free-form bash for commanders: use declared workbench recipes; workbench_delegate_worker is optional, and a temporary lease authorizes only high-risk edit/write paths";
	}
	if (toolName === "edit" || toolName === "write") {
		const path = extractPath(facts.input);
		if (!path) {
			return `Commander ${toolName} requires a non-empty canonical project-relative path`;
		}
		const riskReason = directDevelopmentWriteBlockReason(path, facts.input);
		if (riskReason === undefined) return undefined;
		if (!riskReason.includes("high-risk path")) return riskReason;
		const lease = facts.lease;
		if (!lease || leaseStatus(lease, now) !== "active") {
			const status = lease ? leaseStatus(lease, now) : "locked";
			return `${riskReason} (lease ${status})`;
		}
		if (!isLeasePathAuthorized(lease, path)) {
			return `Commander ${toolName} on high-risk path "${path}" is outside the active write lease`;
		}
		if (!leaseCoversTool(lease, toolName)) {
			return `The active write lease authorizes only ${lease.tools.join(", ")}`;
		}
		return undefined;
	}
	if (!isInStrictAllowlist(toolName)) {
		return `Tool "${toolName}" is outside the strict Sol DEV allowlist; use workbench_delegate_worker or an explicit temporary commander write lease for write-capable work`;
	}
	return undefined;
}
