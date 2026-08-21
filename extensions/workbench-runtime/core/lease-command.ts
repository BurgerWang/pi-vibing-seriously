/**
 * P7 lease slash-command helpers — pure parsing/rendering, no Pi imports.
 *
 * The Pi wiring lives in index.ts; this module is the unit-testable core:
 *   - `/q-commander-write-unlock` argument parsing: the issuance form
 *     (`<reason> --paths <comma-list> --calls <N> --minutes <N>`) and the
 *     two-step non-TUI confirmation form (`confirm <partA> <partB>`,
 *     optionally `confirm <lease-id> <partA> <partB>`)
 *   - bounded lease id and two-part confirmation token generation
 *   - the TUI confirmation preview (every scope/reason/calls/expiry fact)
 *   - the non-TUI issuance/confirmation result renderers — the ONLY
 *     renderers that ever display the two confirmation token parts
 *   - `/q-write-policy` argument parsing (accepts EXACTLY the trimmed
 *     `status` subcommand) and rendering (actor, development-first direct
 *     writes, bounded high-risk lease summary — NEVER any token part)
 *   - the compact footer segment: `WF:LEASE <used>/<max>` for an ACTIVE
 *     high-risk lease, `WF:DIRECT` otherwise (the WF:REVIEW
 *     segment is appended independently by the caller, never merged here)
 *
 * Bounded-output discipline: every renderer is line-bounded and no renderer
 * other than `renderLeaseIssued` ever prints a confirmation token part.
 */

import { randomBytes } from "node:crypto";

import {
	ALLOWED_LEASE_REASONS,
	isAllowedLeaseReason,
	leaseCompactSummary,
	leaseStatus,
	MAX_LEASE_CALLS,
	MAX_LEASE_DURATION_MS,
	normalizeLeaseRule,
	type ActorRole,
	type LeaseReason,
	type WriteLease,
	type WritePolicy,
} from "./write-authority.ts";

/** The exact user-only slash commands of this slice (never model tools). */
export const LEASE_COMMAND_NAMES = [
	"q-write-policy",
	"q-commander-write-unlock",
	"q-commander-write-lock",
] as const;

/** Minutes bound = MAX_LEASE_DURATION_MS (30 minutes). */
export const MAX_LEASE_MINUTES = MAX_LEASE_DURATION_MS / 60_000;

const MAX_LEASE_ID_LENGTH = 64;
/** Per-part bound for the two-step non-TUI confirmation token. */
const MAX_TOKEN_PART_LENGTH = 64;

export const UNLOCK_USAGE =
	"/q-commander-write-unlock <reason> --paths <comma-list> --calls <N> --minutes <N> " +
	"| /q-commander-write-unlock confirm <partA> <partB> " +
	"| /q-commander-write-unlock confirm <lease-id> <partA> <partB>";

/** The only implemented `/q-write-policy` subcommand form. */
export const WRITE_POLICY_USAGE = "/q-write-policy status";

/**
 * Parse `/q-write-policy` arguments: the command accepts EXACTLY the
 * trimmed `status` subcommand. Missing or any other argument is refused
 * with usage — the caller prints it and changes no state.
 */
export function parseWritePolicyArgs(args: string): { ok: true; kind: "status" } | { ok: false; error: string } {
	if (args.trim() !== "status") {
		return { ok: false, error: `usage: ${WRITE_POLICY_USAGE} — the only subcommand is "status"` };
	}
	return { ok: true, kind: "status" };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export type UnlockIssueArgs = {
	ok: true;
	kind: "issue";
	reason: LeaseReason;
	paths: string[];
	calls: number;
	minutes: number;
};

export type UnlockConfirmArgs = {
	ok: true;
	kind: "confirm";
	/** Optional lease id — when given it must match the pending lease. */
	leaseId?: string;
	partA: string;
	partB: string;
};

export type UnlockArgs = UnlockIssueArgs | UnlockConfirmArgs | { ok: false; error: string };

/**
 * Parse `/q-commander-write-unlock` arguments. The issuance form requires
 * an allowed reason, a non-empty comma-separated list of project-relative
 * path rules (exact paths or `/**` subtrees — validated here AND again by
 * issueLease), `--calls` 1..10 and `--minutes` 1..30; unknown/duplicate
 * flags are refused. The confirmation form requires both exact token parts
 * (optionally prefixed by the lease id).
 */
export function parseUnlockArgs(args: string): UnlockArgs {
	const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length === 0) return { ok: false, error: "missing arguments" };
	if (tokens[0] === "confirm") {
		const rest = tokens.slice(1);
		if (rest.length === 2) {
			return { ok: true, kind: "confirm", partA: rest[0]!, partB: rest[1]! };
		}
		if (rest.length === 3) {
			return { ok: true, kind: "confirm", leaseId: rest[0]!, partA: rest[1]!, partB: rest[2]! };
		}
		return {
			ok: false,
			error: 'confirmation form: "confirm <partA> <partB>" or "confirm <lease-id> <partA> <partB>"',
		};
	}
	const reason = tokens[0]!;
	if (!isAllowedLeaseReason(reason)) {
		return { ok: false, error: `lease reason must be one of: ${ALLOWED_LEASE_REASONS.join(", ")}` };
	}
	let paths: string[] | undefined;
	let calls: number | undefined;
	let minutes: number | undefined;
	let i = 1;
	while (i < tokens.length) {
		const flag = tokens[i]!;
		const value = tokens[i + 1];
		if (value === undefined) return { ok: false, error: `flag "${flag}" requires a value` };
		if (flag === "--paths") {
			if (paths !== undefined) return { ok: false, error: 'duplicate flag "--paths"' };
			paths = value
				.split(",")
				.map((p) => p.trim())
				.filter((p) => p.length > 0);
		} else if (flag === "--calls") {
			if (calls !== undefined) return { ok: false, error: 'duplicate flag "--calls"' };
			if (!/^\d+$/.test(value)) {
				return { ok: false, error: `--calls must be an integer between 1 and ${MAX_LEASE_CALLS}` };
			}
			calls = Number(value);
		} else if (flag === "--minutes") {
			if (minutes !== undefined) return { ok: false, error: 'duplicate flag "--minutes"' };
			if (!/^\d+$/.test(value)) {
				return { ok: false, error: `--minutes must be an integer between 1 and ${MAX_LEASE_MINUTES}` };
			}
			minutes = Number(value);
		} else {
			return { ok: false, error: `unknown flag "${flag}"` };
		}
		i += 2;
	}
	if (paths === undefined) {
		return { ok: false, error: 'missing "--paths <comma-list>" (project-relative exact paths or /** subtrees)' };
	}
	if (calls === undefined) return { ok: false, error: `missing "--calls <N>" (1..${MAX_LEASE_CALLS})` };
	if (minutes === undefined) return { ok: false, error: `missing "--minutes <N>" (1..${MAX_LEASE_MINUTES})` };
	if (calls < 1 || calls > MAX_LEASE_CALLS) {
		return { ok: false, error: `--calls must be between 1 and ${MAX_LEASE_CALLS}` };
	}
	if (minutes < 1 || minutes > MAX_LEASE_MINUTES) {
		return { ok: false, error: `--minutes must be between 1 and ${MAX_LEASE_MINUTES}` };
	}
	for (const raw of paths) {
		const rule = normalizeLeaseRule(raw);
		if (!rule) {
			return {
				ok: false,
				error: `invalid lease path rule "${raw}": must be project-relative (exact path or /** subtree), never absolute (POSIX, Windows drive, backslash-root) and never escaping via ".."`,
			};
		}
	}
	if (paths.length === 0) {
		return { ok: false, error: "--paths requires at least one project-relative path rule" };
	}
	return { ok: true, kind: "issue", reason, paths, calls, minutes };
}

// ---------------------------------------------------------------------------
// Bounded id / token generation
// ---------------------------------------------------------------------------

/** Bounded lease id: `wl-<timestamp>-<random>` (never longer than 64 chars). */
export function makeLeaseId(now: string, rand?: () => string): string {
	const stamp = now
		.replace(/[^0-9TZ]/g, "")
		.replace("T", "-")
		.slice(0, 15);
	const suffix = (rand ?? (() => randomBytes(4).toString("hex")))();
	return `wl-${stamp}-${suffix}`.slice(0, MAX_LEASE_ID_LENGTH);
}

/**
 * Deterministic fallback pair for a degenerate rng — non-empty, bounded,
 * never equal, and independent of whatever the rng yielded.
 */
const FALLBACK_PART_A = "wb-confirm-a";
const FALLBACK_PART_B = "wb-confirm-b";

/**
 * Two bounded non-empty DISTINCT confirmation parts for the two-step
 * non-TUI flow. The rng is injectable for tests; the default is
 * crypto-random. The guarantees hold for ANY rng output — empty, equal or
 * overlong values included: a bounded retry loop gives the source a
 * chance to yield usable values, then a deterministic fallback pair
 * guarantees two non-empty parts of at most MAX_TOKEN_PART_LENGTH
 * characters that are never equal. Distinctness is always checked on the
 * FINAL bounded values, since two different raw values can still collide
 * after the 64-char slice.
 */
export function newConfirmationParts(rand?: () => string): { partA: string; partB: string } {
	const next = rand ?? (() => randomBytes(12).toString("base64url"));
	const bounded = (raw: string): string => raw.slice(0, MAX_TOKEN_PART_LENGTH);
	let partA = bounded(next());
	let partB = bounded(next());
	// Bounded retry loop: prefer two genuinely random distinct non-empty
	// values; capped so a degenerate source can never hang the generator.
	let attempts = 0;
	while ((partA.length === 0 || partB.length === 0 || partA === partB) && attempts < 16) {
		partA = bounded(next());
		partB = bounded(next());
		attempts += 1;
	}
	// Deterministic fallback: guarantees two bounded non-empty DISTINCT
	// parts even when the source only ever yields degenerate values
	// (empty, equal, or colliding after the bound slice).
	if (partA.length === 0) partA = partB === FALLBACK_PART_A ? FALLBACK_PART_B : FALLBACK_PART_A;
	if (partB.length === 0) partB = partA === FALLBACK_PART_B ? FALLBACK_PART_A : FALLBACK_PART_B;
	if (partA === partB) partB = partA === FALLBACK_PART_A ? FALLBACK_PART_B : FALLBACK_PART_A;
	return { partA, partB };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** Minutes between issuedAt and expiresAt (exact for valid leases). */
function leaseMinutes(lease: WriteLease): number {
	return Math.round((Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt)) / 60_000);
}

/**
 * TUI confirmation preview: every scope/reason/calls/expiry fact the human
 * needs before confirming. Never any token part (TUI confirmation does not
 * use tokens).
 */
export function renderUnlockPreview(input: {
	leaseId: string;
	reason: string;
	paths: readonly string[];
	calls: number;
	minutes: number;
	now: string;
}): string[] {
	const expiresAt = new Date(Date.parse(input.now) + input.minutes * 60_000).toISOString();
	return [
		`lease id : ${input.leaseId}`,
		`reason   : ${input.reason} (fixed reasons: ${ALLOWED_LEASE_REASONS.join("|")})`,
		`paths    : ${input.paths.join(", ")} (project-relative exact paths or /** subtrees)`,
		`tools    : edit, write only — bash is never authorized`,
		`calls    : up to ${input.calls} authorized edit/write call(s) (max ${MAX_LEASE_CALLS})`,
		`expires  : ${expiresAt} (in ${input.minutes} minute(s), max ${MAX_LEASE_MINUTES})`,
	];
}

/**
 * Non-TUI issuance result: the ONLY renderer that visibly emits the two
 * distinct bounded confirmation token parts. Both exact parts are required
 * by a second `/q-commander-write-unlock confirm` invocation.
 */
export function renderLeaseIssued(lease: WriteLease, _now: string): string[] {
	return [
		`/q-commander-write-unlock: pending lease ${lease.id} issued — edit/write stay BLOCKED until confirmed`,
		`reason   : ${lease.reason}`,
		`paths    : ${lease.paths.join(", ")}`,
		`tools    : ${lease.tools.join(", ")} only — bash is never authorized`,
		`calls    : ${lease.callsUsed}/${lease.maxCalls} used (one per authorized edit/write)`,
		`expires  : ${lease.expiresAt} (${leaseMinutes(lease)} minute(s))`,
		`confirmation part A: ${lease.confirmationTokenA}`,
		`confirmation part B: ${lease.confirmationTokenB}`,
		`confirm with: /q-commander-write-unlock confirm <partA> <partB>`,
	];
}

/** Confirmation result (TUI or non-TUI). Never any token part. */
export function renderLeaseConfirmed(lease: WriteLease, _now: string): string[] {
	return [
		`/q-commander-write-unlock: lease ${lease.id} CONFIRMED and active`,
		`reason   : ${lease.reason}`,
		`paths    : ${lease.paths.join(", ")}`,
		`tools    : ${lease.tools.join(", ")} only — bash is never authorized`,
		`calls    : ${lease.callsUsed}/${lease.maxCalls} used (one per authorized edit/write)`,
		`expires  : ${lease.expiresAt}`,
		`edit/write are active in strict Sol DEV (canonical 14-tool allowlist + lease tools); lock, expiry or exhaustion revokes them`,
	];
}

/**
 * Compact footer segment for the development-first Sol write authority. An ACTIVE
 * confirmed lease renders the required compact `WF:LEASE <callsUsed>/<maxCalls>`;
 * every other state renders `WF:DIRECT`: ordinary edit/write remain directly
 * available while high-risk paths still require a lease. Other actors
 * render no segment at all. The WF:REVIEW segment is appended by the
 * caller independently and is never merged into this segment.
 */
export function writeAuthorityFooterSegment(facts: {
	actor: ActorRole;
	policy: WritePolicy | undefined;
	lease: WriteLease | undefined;
	now: string;
}): string | undefined {
	if (facts.actor !== "sol-commander" || facts.policy !== "worker-first-strict") return undefined;
	const status = leaseStatus(facts.lease, facts.now);
	if (status === "active" && facts.lease) {
		return `WF:LEASE ${facts.lease.callsUsed}/${facts.lease.maxCalls}`;
	}
	return "WF:DIRECT";
}

export interface WritePolicyStatusFacts {
	actor: ActorRole;
	provider?: string | undefined;
	model?: string | undefined;
	policy: WritePolicy | undefined;
	lease: WriteLease | undefined;
	now: string;
}

/**
 * `/q-write-policy status` lines: actor, fixed policy, direct-write
 * lock/lease status and a bounded lease summary. NEVER any confirmation
 * token part and no other secrets.
 */
export function renderWritePolicyStatus(facts: WritePolicyStatusFacts): string[] {
	const lines = [`actor        : ${facts.actor} (${facts.provider ?? "(none)"}/${facts.model ?? "(none)"})`];
	if (facts.policy === "worker-first-strict") {
		lines.push("policy       : development-first direct editing (compatibility id: worker-first-strict)");
		const status = facts.lease ? leaseStatus(facts.lease, facts.now) : "locked";
		if (status === "active") {
			lines.push(`direct write : ordinary paths direct; high-risk paths allowed via lease ${facts.lease!.id} within its scope`);
		} else if (status === "pending") {
			lines.push(
				"direct write : ordinary paths direct; high-risk lease pending confirmation (run /q-commander-write-unlock confirm <partA> <partB> with the issued parts)",
			);
		} else {
			lines.push(`direct write : ordinary paths direct; high-risk paths require a lease (lease ${status})`);
		}
		lines.push(`lease        : ${leaseCompactSummary(facts.lease, facts.now)}`);
	} else {
		lines.push(
			"policy       : not-applicable — existing worker/controller guards govern write access",
			"direct write : governed by existing guards (the P7 lease applies only to strict Sol)",
			"lease        : (not applicable)",
		);
	}
	return lines;
}
