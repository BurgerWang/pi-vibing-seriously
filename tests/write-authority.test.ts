/**
 * P7 tests for the pure write-authority foundations (core/write-authority.ts).
 *
 * Focus: actor detection (env worker identity, Sol identity, no config
 * self-labeling), the legacy-compatible policy identity (approved Sol
 * always, non-Sol not applicable), the fixed development-first Sol DEV
 * surface, the foreign-tool removal helper, the second-layer commander
 * decision (Sol-only guard: bash blocked, ordinary edit/write direct,
 * high-risk edit/write lease-gated,
 * non-allowlist tools blocked; workers and other controllers outside the
 * guard), temporary commander write leases (reason / path / calls /
 * duration / two-part confirmation tokens / timeout / exhaustion /
 * revocation / serialization-restore / compact summary), and policy
 * restore that is independent of prompt, persistence and config claims.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	ALLOWED_LEASE_REASONS,
	applyStrictAllowlist,
	canIssueLease,
	commanderToolCallBlockReason,
	confirmLease,
	consumeLeaseCall,
	DEVELOPMENT_FIRST_SOL_DEV_ALLOWLIST,
	defaultWritePolicy,
	detectActorRole,
	directDevelopmentWriteBlockReason,
	foreignTools,
	isInStrictAllowlist,
	isLeasePathAuthorized,
	issueLease,
	leaseCompactSummary,
	leaseRevokeReason,
	leaseStatus,
	MAX_LEASE_CALLS,
	MAX_LEASE_DURATION_MS,
	resolveSessionWritePolicy,
	restoreLease,
	revokeLease,
	serializeLease,
	STRICT_SOL_DEV_ALLOWLIST,
	WRITE_POLICIES,
	type CommanderToolCallFacts,
	type IssueLeaseInput,
	type WriteLease,
} from "../extensions/workbench-runtime/core/write-authority.ts";
import {
	makeLeaseId,
	newConfirmationParts,
	parseUnlockArgs,
	parseWritePolicyArgs,
	renderLeaseConfirmed,
	renderLeaseIssued,
	renderUnlockPreview,
	renderWritePolicyStatus,
	writeAuthorityFooterSegment,
	WRITE_POLICY_USAGE,
} from "../extensions/workbench-runtime/core/lease-command.ts";

const NOW = "2026-06-01T12:00:00.000Z";
const BEFORE_EXPIRY = "2026-06-01T12:29:59.999Z";
const AT_EXPIRY = "2026-06-01T12:30:00.000Z";
const AFTER_EXPIRY = "2026-06-01T12:30:00.001Z";
const TOKEN_A = "A1B2C3-D4E5";
const TOKEN_B = "F6G7H8-J9K0";

function baseIssue(overrides: Partial<IssueLeaseInput> = {}): IssueLeaseInput {
	return {
		id: "lease-1",
		reason: "user-directed",
		paths: ["src/**", "README.md"],
		confirmationTokenA: TOKEN_A,
		confirmationTokenB: TOKEN_B,
		now: NOW,
		...overrides,
	};
}

function issueOk(overrides: Partial<IssueLeaseInput> = {}): WriteLease {
	const result = issueLease(baseIssue(overrides));
	if (!result.ok) throw new Error(result.error);
	return result.lease;
}

function activeLease(overrides: Partial<IssueLeaseInput> = {}): WriteLease {
	const lease = issueOk(overrides);
	const confirmed = confirmLease(
		lease,
		overrides.confirmationTokenA ?? TOKEN_A,
		overrides.confirmationTokenB ?? TOKEN_B,
		NOW,
	);
	if (!confirmed.ok) throw new Error(confirmed.error);
	return confirmed.lease;
}

function guard(
	toolName: string,
	input: unknown,
	extra: Partial<CommanderToolCallFacts> = {},
): string | undefined {
	return commanderToolCallBlockReason({
		actor: "sol-commander",
		toolName,
		input,
		now: NOW,
		...extra,
	});
}

/** Rng that yields the given values in order, then repeats the last one forever. */
function sequenceRng(values: string[]): () => string {
	let i = 0;
	return () => values[Math.min(i++, values.length - 1)]!;
}

// ---------------------------------------------------------------------------
// actor detection
// ---------------------------------------------------------------------------

test("delegated-worker identity comes only from the WORKBENCH_AGENT_ROLE=worker env contract", () => {
	assert.equal(detectActorRole({ roleEnv: "worker" }), "delegated-worker");
	// The env contract wins even against Sol-looking provider/model facts:
	// only the workbench worker child sets it.
	assert.equal(detectActorRole({ roleEnv: "worker", provider: "openai", model: "gpt-5.6-sol" }), "delegated-worker");
	// Other env values are not worker labels and cannot self-label as Sol.
	assert.equal(detectActorRole({ roleEnv: "commander", provider: "deepseek", model: "deepseek-v4-flash" }), "other-controller");
	assert.equal(detectActorRole({ roleEnv: "sol", provider: "deepseek", model: "deepseek-v4-flash" }), "other-controller");
});

test("Sol identity comes only from the approved provider/model pair", () => {
	assert.equal(detectActorRole({ provider: "openai-codex", model: "gpt-5.6-sol" }), "sol-commander");
	assert.equal(detectActorRole({ provider: "openai", model: "gpt-5.6-sol" }), "sol-commander");
	assert.equal(detectActorRole({ provider: "deepseek", model: "deepseek-v4-flash" }), "other-controller");
	assert.equal(detectActorRole({ provider: "openai-codex", model: "gpt-5.6-terra" }), "other-controller");
	assert.equal(detectActorRole({ provider: "anthropic", model: "claude-4.5-sonnet" }), "other-controller");
	assert.equal(detectActorRole({}), "other-controller");
	assert.equal(detectActorRole({ provider: undefined, model: undefined }), "other-controller");
});

test("project config can never self-label a controller as Sol or as a worker", () => {
	// A deepseek controller claiming "sol-commander" in project config stays other-controller.
	assert.equal(
		detectActorRole({ provider: "deepseek", model: "deepseek-v4-flash", configRole: "sol-commander" }),
		"other-controller",
	);
	// A controller claiming "worker" in project config is not a worker (no env contract).
	assert.equal(
		detectActorRole({ provider: "openai-codex", model: "gpt-5.6-sol", configRole: "worker" }),
		"sol-commander",
	);
	// A config claim cannot demote real Sol identity either — config is never consulted.
	assert.equal(
		detectActorRole({ provider: "openai", model: "gpt-5.6-sol", configRole: "other-controller" }),
		"sol-commander",
	);
});

// ---------------------------------------------------------------------------
// write policy: exactly worker-first-strict, Sol-only applicability
// ---------------------------------------------------------------------------

test("the write policy is exactly worker-first-strict and applies only to approved Sol", () => {
	assert.deepEqual(WRITE_POLICIES, ["worker-first-strict"]);
	assert.equal(defaultWritePolicy("openai-codex", "gpt-5.6-sol"), "worker-first-strict");
	assert.equal(defaultWritePolicy("openai", "gpt-5.6-sol"), "worker-first-strict");
	// Non-Sol controllers: the policy is NOT applicable (undefined) — this
	// module neither grants nor denies them anything.
	assert.equal(defaultWritePolicy("deepseek", "deepseek-v4-flash"), undefined);
	assert.equal(defaultWritePolicy("openai-codex", "gpt-5.6-terra"), undefined);
	assert.equal(defaultWritePolicy(undefined, undefined), undefined);
	assert.equal(defaultWritePolicy("openai", undefined), undefined);
});

test("canIssueLease is true exactly for the worker-first-strict policy", () => {
	assert.equal(canIssueLease("worker-first-strict"), true);
	assert.equal(canIssueLease(undefined), false);
});

// ---------------------------------------------------------------------------
// strict Sol DEV allowlist
// ---------------------------------------------------------------------------

test("strict Sol DEV allowlist is exactly the fixed 15-tool order, no bash/edit/write, no foreign tools", () => {
	assert.deepEqual(STRICT_SOL_DEV_ALLOWLIST, [
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
		// P8b: the public read-only recovery tool is appended LAST (14 → 15).
		"workbench_recover_tool_result",
	]);
	assert.equal(new Set(STRICT_SOL_DEV_ALLOWLIST).size, STRICT_SOL_DEV_ALLOWLIST.length, "no duplicates");
	for (const tool of STRICT_SOL_DEV_ALLOWLIST) {
		assert.notEqual(tool, "bash", "bash is never in the strict allowlist");
		assert.notEqual(tool, "edit", "edit is never in the strict allowlist");
		assert.notEqual(tool, "write", "write is never in the strict allowlist");
	}
	for (const foreign of ["my_extension_tool", "workbench_grant_write", "workbench_sudo", "web_search"]) {
		assert.equal(isInStrictAllowlist(foreign), false, foreign);
	}
	assert.equal(isInStrictAllowlist("read"), true);
	assert.equal(isInStrictAllowlist("bash"), false);
	assert.equal(isInStrictAllowlist("workbench_delegate_worker"), true);
	assert.equal(isInStrictAllowlist("workbench_review_worker_diff"), true);
	assert.equal(isInStrictAllowlist("workbench_delegation_status"), true);
	assert.equal(isInStrictAllowlist("workbench_recover_tool_result"), true);
});

test("foreign removal helper keeps only allowlist tools in the fixed canonical order", () => {
	const active = [
		"bash",
		"workbench_read_run",
		"my_extension_tool",
		"read",
		"edit",
		"workbench_review_worker_diff",
		"write",
	];
	assert.deepEqual(applyStrictAllowlist(active), ["read", "workbench_read_run", "workbench_review_worker_diff"]);
	// Full DEV-like set: all 14 members survive in the exact fixed order,
	// everything else (bash/edit/write/foreign) is removed.
	const full = [...STRICT_SOL_DEV_ALLOWLIST, "bash", "edit", "write", "z_foreign", "a_foreign"];
	assert.deepEqual(applyStrictAllowlist(full), [...STRICT_SOL_DEV_ALLOWLIST]);
	assert.deepEqual(foreignTools(full), ["a_foreign", "bash", "edit", "write", "z_foreign"]);
	assert.deepEqual(foreignTools([...STRICT_SOL_DEV_ALLOWLIST]), []);
});

// ---------------------------------------------------------------------------
// second-layer commander decision
// ---------------------------------------------------------------------------

test("the Sol strict guard applies only to sol-commander; workers and other controllers are outside it", () => {
	// Other controllers are OUTSIDE the Sol strict guard: this module does
	// not newly deny them — existing guards govern them.
	for (const toolName of ["bash", "edit", "write", "workbench_grant_write", "read"]) {
		assert.equal(
			commanderToolCallBlockReason({
				actor: "other-controller",
				toolName,
				input: toolName === "bash" ? { command: "npm test" } : { path: "src/main.ts" },
				now: NOW,
			}),
			undefined,
			`other-controller must be outside the Sol strict guard for ${toolName}`,
		);
	}
	// Delegated workers are equally outside; the existing worker guards
	// (worker-policy.ts) remain authoritative.
	const lease = activeLease();
	for (const toolName of ["bash", "edit", "write", "workbench_grant_write", "read", "workbench_run_recipe"]) {
		assert.equal(
			commanderToolCallBlockReason({
				actor: "delegated-worker",
				toolName,
				input: toolName === "bash" ? { command: "npm test" } : { path: "src/main.ts" },
				now: NOW,
				lease,
			}),
			undefined,
			`worker must be outside the Sol strict guard for ${toolName}`,
		);
	}
});

test("commander guard blocks bash always for Sol, even with an active lease and even if re-enabled", () => {
	const reason = guard("bash", { command: "npm test" });
	assert.ok(reason);
	assert.match(reason, /workbench_delegate_worker/);
	assert.match(reason, /optional/);
	assert.match(reason, /lease/);
	// An active lease never authorizes bash.
	const lease = activeLease();
	assert.ok(guard("bash", { command: "npm test" }, { lease }));
	// Re-enabling bash in the active tool set does not weaken the guard.
	assert.ok(guard("bash", { command: "npm test" }));
});

test("commander edit/write is direct for ordinary paths and lease-gated for high-risk paths", () => {
	const lease = activeLease();
	assert.equal(guard("edit", { path: "src/main.ts" }, { lease }), undefined);
	assert.equal(guard("write", { path: "README.md" }, { lease }), undefined);
	assert.equal(guard("edit", { path: "src/main.ts" }), undefined);
	assert.equal(guard("write", { path: "README.md" }), undefined);
	assert.equal(guard("write", { path: "src/nested/deep/file.ts" }, { lease }), undefined);

	const locked = guard("edit", { path: "package.json" });
	assert.ok(locked);
	assert.match(locked, /lease locked/);
	assert.match(locked, /high-risk path/);
	const highRiskLease = activeLease({ paths: ["package.json", "src/security/**"] });
	assert.equal(guard("edit", { path: "package.json" }, { lease: highRiskLease }), undefined);
	assert.equal(guard("write", { path: "src/security/auth.ts" }, { lease: highRiskLease }), undefined);
	// Lease still pending confirmation.
	const pending = issueOk({ paths: ["package.json"] });
	const pendingReason = guard("edit", { path: "package.json" }, { lease: pending });
	assert.ok(pendingReason);
	assert.match(pendingReason, /lease pending/);
	// Wrong confirmation parts never activate the lease.
	const badConfirm = confirmLease(pending, "WRONG", TOKEN_B, NOW);
	assert.equal(badConfirm.ok, false);
	// Exhausted lease (no remaining call).
	const exhausted = { ...activeLease({ maxCalls: 1, paths: ["package.json"] }), callsUsed: 1 };
	const exhaustedReason = guard("write", { path: "package.json" }, { lease: exhausted });
	assert.ok(exhaustedReason);
	assert.match(exhaustedReason, /lease exhausted/);
	// Expired lease.
	const expired = activeLease({ paths: ["package.json"] });
	const expiredReason = guard("write", { path: "package.json" }, { lease: expired, now: AFTER_EXPIRY });
	assert.ok(expiredReason);
	assert.match(expiredReason, /lease expired/);
	// Revoked lease.
	const revoked = revokeLease(activeLease({ paths: ["package.json"] }), "model change", NOW);
	const revokedReason = guard("write", { path: "package.json" }, { lease: revoked });
	assert.ok(revokedReason);
	assert.match(revokedReason, /lease revoked/);
});

test("high-risk writes require matching lease scope/tool while malformed direct writes fail closed", () => {
	const lease = activeLease({ paths: [".github/workflows/ci.yml"] });
	// Exact-path rules do not cover descendants.
	const exactReason = guard("edit", { path: ".github/workflows/ci.yml/sub" }, { lease });
	assert.ok(exactReason);
	assert.match(exactReason, /outside the active write lease/);
	// Uncovered path.
	const pathReason = guard("edit", { path: ".github/workflows/release.yml" }, { lease });
	assert.ok(pathReason);
	assert.match(pathReason, /outside the active write lease/);
	// Absolute and escaping candidates are never authorized.
	assert.equal(isLeasePathAuthorized(lease, "/repo/src/main.ts"), false);
	assert.equal(isLeasePathAuthorized(lease, "src/../../etc/passwd"), false);
	assert.ok(guard("edit", { path: "/repo/src/main.ts" }, { lease }));
	assert.ok(guard("write", { path: "../outside.ts" }, { lease }));
	assert.ok(guard("write", { path: "src\\main.ts" }, { lease }));
	assert.ok(guard("write", { path: " src/main.ts" }, { lease }));
	assert.match(guard("write", { path: "src/main.ts", content: "ok\0bad" }, { lease }) ?? "", /NUL/);
	// Missing path is refused even with an active lease.
	const missingReason = guard("edit", { path: "" }, { lease });
	assert.ok(missingReason);
	assert.match(missingReason, /non-empty canonical project-relative path/);
	assert.ok(guard("write", {}, { lease }));
	// A lease scoped to write only never authorizes edit.
	const writeOnly = activeLease({ tools: ["write"], paths: ["package.json"] });
	const toolReason = guard("edit", { path: "package.json" }, { lease: writeOnly });
	assert.ok(toolReason);
	assert.match(toolReason, /authorizes only write/);
	assert.equal(guard("write", { path: "package.json" }, { lease: writeOnly }), undefined);
});

test("commander guard blocks every tool outside the allowlist even when re-enabled", () => {
	const blocked = ["workbench_grant_write", "my_extension_tool", "web_search", "workbench_sudo"];
	for (const tool of blocked) {
		const reason = guard(tool, {});
		assert.ok(reason, tool);
		assert.match(reason, /outside the strict Sol DEV allowlist/);
		assert.match(reason, /workbench_delegate_worker/);
	}
	// Re-enabling such a tool in the active set never weakens the guard.
	assert.ok(guard("workbench_grant_write", {}));
});

test("allowlist tools pass the commander guard for commanders", () => {
	for (const tool of ["read", "grep", "find", "ls", "workbench_project_inspect", "workbench_run_recipe", "workbench_run_gate", "workbench_delegate_worker", "workbench_review_worker_diff", "workbench_delegation_status"]) {
		assert.equal(guard(tool, {}), undefined, tool);
	}
});

test("development-first surface exposes direct ordinary writes while retaining a fixed high-risk gate", () => {
	assert.deepEqual(DEVELOPMENT_FIRST_SOL_DEV_ALLOWLIST, [...STRICT_SOL_DEV_ALLOWLIST, "edit", "write"]);
	assert.equal(guard("edit", { path: "src/main.ts" }), undefined);
	assert.equal(guard("write", { path: "docs/guide.md" }), undefined);
	const blocked = guard("edit", { path: ".github/workflows/ci.yml" });
	assert.ok(blocked);
	assert.match(blocked, /high-risk path/);
	assert.match(blocked, /lease locked/);
	assert.equal(directDevelopmentWriteBlockReason("src/main.ts"), undefined);
	assert.match(directDevelopmentWriteBlockReason("src/security/auth.ts") ?? "", /high-risk/);
});

// ---------------------------------------------------------------------------
// temporary commander write lease
// ---------------------------------------------------------------------------

test("lease default is locked; allowed reasons are exactly the four fixed ones", () => {
	assert.equal(leaseStatus(undefined, NOW), "locked");
	assert.deepEqual(ALLOWED_LEASE_REASONS, ["bootstrap-policy", "worker-unavailable", "security-emergency", "user-directed"]);
	for (const reason of ALLOWED_LEASE_REASONS) {
		assert.equal(issueLease(baseIssue({ reason })).ok, true, reason);
	}
	for (const reason of ["anything-else", "", "USER-DIRECTED", "manual-override", "policy-bootstrap"]) {
		const result = issueLease(baseIssue({ reason }));
		assert.equal(result.ok, false, reason);
		if (!result.ok) assert.match(result.error, /reason must be one of/);
	}
});

test("lease issue validates project-relative exact and subtree paths, never absolute or ..", () => {
	for (const paths of [["src/**"], ["src/"], ["src/main.ts"], ["src/nested/deep.ts", "README.md"], ["src\\main.ts"]]) {
		assert.equal(issueLease(baseIssue({ paths })).ok, true, paths.join(","));
	}
	// Absolute POSIX, backslash-root, Windows drive (even drive-relative)
	// and `..` escaping rules are categorically refused.
	const invalid = [
		[],
		[""],
		["/repo/src/**"],
		["../**"],
		["src/../escape"],
		["a/../../b"],
		["/**"],
		["src/**/x"],
		["*.ts"],
		["C:\\repo\\src\\**"],
		["C:/repo/src"],
		["C:notes.md"],
		["\\repo\\src\\**"],
		["\\\\server\\share\\x.ts"],
	];
	for (const paths of invalid) {
		const result = issueLease(baseIssue({ paths }));
		assert.equal(result.ok, false, JSON.stringify(paths));
		if (!result.ok) assert.match(result.error, /project-relative/);
	}
});

test("lease issue validates tools (edit/write only, never bash), calls <= 10, duration <= 30 minutes", () => {
	for (const tools of [undefined, ["edit"], ["write"], ["edit", "write"]]) {
		assert.equal(issueLease(baseIssue({ tools })).ok, true, JSON.stringify(tools));
	}
	for (const tools of [[], ["bash"], ["edit", "bash"], ["rm"]]) {
		const result = issueLease(baseIssue({ tools }));
		assert.equal(result.ok, false, JSON.stringify(tools));
		if (!result.ok) assert.match(result.error, /edit, write|edit\/write/);
	}
	assert.equal(issueLease(baseIssue({ maxCalls: 10 })).ok, true);
	assert.equal(issueLease(baseIssue({ maxCalls: 1 })).ok, true);
	for (const maxCalls of [0, 11, 1.5, -1]) {
		const result = issueLease(baseIssue({ maxCalls }));
		assert.equal(result.ok, false, String(maxCalls));
		if (!result.ok) assert.match(result.error, /maxCalls/);
	}
	assert.equal(issueLease(baseIssue({ durationMs: MAX_LEASE_DURATION_MS })).ok, true);
	for (const durationMs of [0, -1, MAX_LEASE_DURATION_MS + 1, 1.5]) {
		const result = issueLease(baseIssue({ durationMs }));
		assert.equal(result.ok, false, String(durationMs));
		if (!result.ok) assert.match(result.error, /duration/);
	}
});

test("lease issue validates the two-part confirmation token: bounded, non-empty, distinct", () => {
	assert.equal(issueLease(baseIssue()).ok, true);
	assert.equal(issueLease(baseIssue({ confirmationTokenA: "", confirmationTokenB: TOKEN_B })).ok, false);
	assert.equal(issueLease(baseIssue({ confirmationTokenA: TOKEN_A, confirmationTokenB: "" })).ok, false);
	assert.equal(issueLease(baseIssue({ confirmationTokenA: "x".repeat(65), confirmationTokenB: TOKEN_B })).ok, false);
	assert.equal(issueLease(baseIssue({ confirmationTokenA: TOKEN_A, confirmationTokenB: "y".repeat(65) })).ok, false);
	// Distinct parts are required: identical parts cannot secure a two-step confirmation.
	const same = issueLease(baseIssue({ confirmationTokenA: "SAME", confirmationTokenB: "SAME" }));
	assert.equal(same.ok, false);
	if (!same.ok) assert.match(same.error, /distinct/);
});

test("issued lease carries bounded deterministic facts; expiry is exactly issuedAt + duration", () => {
	const lease = issueOk({ durationMs: MAX_LEASE_DURATION_MS });
	assert.equal(lease.id, "lease-1");
	assert.equal(lease.reason, "user-directed");
	assert.deepEqual([...lease.paths], ["src/**", "README.md"]);
	assert.deepEqual([...lease.tools], ["edit", "write"]);
	assert.equal(lease.maxCalls, MAX_LEASE_CALLS);
	assert.equal(lease.callsUsed, 0);
	assert.equal(lease.confirmationStatus, "pending");
	assert.equal(lease.confirmationTokenA, TOKEN_A);
	assert.equal(lease.confirmationTokenB, TOKEN_B);
	assert.notEqual(lease.confirmationTokenA, lease.confirmationTokenB);
	assert.equal(lease.issuedAt, NOW);
	assert.equal(lease.expiresAt, AT_EXPIRY);
	assert.equal(leaseStatus(lease, NOW), "pending");
	assert.equal(leaseStatus(lease, BEFORE_EXPIRY), "pending");
});

test("two-step non-TUI confirmation: both exact parts activate, both are consumed, replay refused", () => {
	const lease = issueOk();
	assert.equal(leaseStatus(lease, NOW), "pending");
	// Partial or wrong parts: still pending, nothing consumed.
	assert.equal(confirmLease(lease, "WRONG", TOKEN_B, NOW).ok, false);
	assert.equal(confirmLease(lease, TOKEN_A, "WRONG", NOW).ok, false);
	assert.equal(confirmLease(lease, "WRONG", "WRONG", NOW).ok, false);
	assert.equal(confirmLease(lease, TOKEN_B, TOKEN_A, NOW).ok, false, "swapped parts are not a confirmation");
	assert.equal(leaseStatus(lease, NOW), "pending");
	assert.equal(lease.confirmationTokenA, TOKEN_A);
	assert.equal(lease.confirmationTokenB, TOKEN_B);
	// Both exact parts: active, both consumed.
	const confirmed = confirmLease(lease, TOKEN_A, TOKEN_B, NOW);
	if (!confirmed.ok) throw new Error(confirmed.error);
	assert.equal(leaseStatus(confirmed.lease, NOW), "active");
	assert.equal(confirmed.lease.confirmationStatus, "confirmed");
	assert.equal(confirmed.lease.confirmationTokenA, "");
	assert.equal(confirmed.lease.confirmationTokenB, "");
	assert.equal(confirmed.lease.confirmedAt, NOW);
	// Replay refused, even with the exact parts.
	assert.equal(confirmLease(confirmed.lease, TOKEN_A, TOKEN_B, NOW).ok, false);
	// A lease that expires before confirmation can never become active.
	const late = issueOk();
	assert.equal(confirmLease(late, TOKEN_A, TOKEN_B, AFTER_EXPIRY).ok, false);
	assert.equal(leaseStatus(late, AFTER_EXPIRY), "expired");
});

test("one call is consumed per successful authorized write; exhaustion is terminal", () => {
	let lease = activeLease({ maxCalls: 3 });
	for (let i = 1; i <= 3; i++) {
		const result = consumeLeaseCall(lease, "edit", "src/main.ts", NOW);
		if (!result.ok) throw new Error(result.error);
		lease = result.lease;
		assert.equal(lease.callsUsed, i);
		assert.equal(leaseStatus(lease, NOW), i < 3 ? "active" : "exhausted");
	}
	// Exhausted: no remaining call.
	assert.equal(consumeLeaseCall(lease, "edit", "src/main.ts", NOW).ok, false);
	assert.equal(leaseStatus(lease, NOW), "exhausted");
	// Unauthorized attempts consume nothing.
	const fresh = activeLease();
	assert.equal(consumeLeaseCall(fresh, "edit", "tests/uncovered.ts", NOW).ok, false);
	assert.equal(consumeLeaseCall(fresh, "bash", "src/main.ts", NOW).ok, false);
	assert.equal(consumeLeaseCall(fresh, "read", "src/main.ts", NOW).ok, false);
	assert.equal(fresh.callsUsed, 0);
	// Pending leases never consume.
	const pending = issueOk();
	assert.equal(consumeLeaseCall(pending, "edit", "src/main.ts", NOW).ok, false);
	assert.equal(pending.callsUsed, 0);
});

test("absolute candidates are categorically rejected, even when the first segment could match a rule", () => {
	// A lease rule whose first segment matches the first segment of an
	// absolute candidate: normalization must never bridge them.
	const adversarial = activeLease({ paths: ["repo/src/**"] });
	assert.equal(isLeasePathAuthorized(adversarial, "repo/src/main.ts"), true);
	assert.equal(isLeasePathAuthorized(adversarial, "/repo/src/main.ts"), false);
	assert.equal(isLeasePathAuthorized(adversarial, "//repo/src/main.ts"), false);
	assert.equal(isLeasePathAuthorized(adversarial, "\\repo\\src\\main.ts"), false);
	assert.equal(isLeasePathAuthorized(adversarial, "\\\\server\\share\\repo\\src\\main.ts"), false);
	assert.equal(isLeasePathAuthorized(adversarial, "C:\\repo\\src\\main.ts"), false);
	assert.equal(isLeasePathAuthorized(adversarial, "C:/repo/src/main.ts"), false);
	assert.equal(isLeasePathAuthorized(adversarial, "c:repo\\src\\main.ts"), false);
	assert.equal(isLeasePathAuthorized(adversarial, "D:repo/src/main.ts"), false);
	// The guard refuses the same candidates for Sol.
	assert.ok(guard("edit", { path: "/repo/src/main.ts" }, { lease: adversarial }));
	assert.ok(guard("write", { path: "C:\\repo\\src\\main.ts" }, { lease: adversarial }));
	assert.ok(guard("edit", { path: "\\\\server\\share\\repo\\src\\main.ts" }, { lease: adversarial }));
	// Relative candidates with backslash separators still normalize and match.
	assert.equal(isLeasePathAuthorized(adversarial, "repo\\src\\main.ts"), true);
});

test("lease timeout at exactly 30 minutes; revocation on leaving DEV, model change, and session end", () => {
	const lease = activeLease();
	assert.equal(leaseStatus(lease, BEFORE_EXPIRY), "active");
	assert.equal(leaseStatus(lease, AT_EXPIRY), "expired");
	assert.equal(leaseStatus(lease, AFTER_EXPIRY), "expired");
	// Revocation checks: no revocation required while DEV + Sol + session alive.
	assert.equal(leaseRevokeReason(lease, { mode: "DEV", provider: "openai-codex", model: "gpt-5.6-sol", sessionEnded: false }), undefined);
	assert.match(leaseRevokeReason(lease, { mode: "AUDIT", provider: "openai-codex", model: "gpt-5.6-sol" }) ?? "", /leaving DEV/);
	assert.match(leaseRevokeReason(lease, { mode: "VERIFY", provider: "openai-codex", model: "gpt-5.6-sol" }) ?? "", /leaving DEV/);
	assert.match(leaseRevokeReason(lease, { mode: "DEV", provider: "deepseek", model: "deepseek-v4-flash" }) ?? "", /model\/provider change/);
	assert.match(leaseRevokeReason(lease, { mode: "DEV", provider: "openai-codex", model: "gpt-5.6-terra" }) ?? "", /model\/provider change/);
	assert.match(leaseRevokeReason(lease, { mode: "DEV", provider: "openai-codex", model: "gpt-5.6-sol", sessionEnded: true }) ?? "", /session ended/);
	// Revocation is terminal and idempotent.
	const revoked = revokeLease(lease, "model change", NOW);
	assert.equal(leaseStatus(revoked, NOW), "revoked");
	assert.deepEqual(revokeLease(revoked, "again", NOW), revoked);
	assert.equal(leaseRevokeReason(revoked, { mode: "AUDIT" }), undefined, "already-revoked leases need no further action");
});

test("lease serialization round-trips exactly and restore fails closed on any invalid field", () => {
	for (const lease of [issueOk(), activeLease(), { ...activeLease(), callsUsed: 4 }, revokeLease(activeLease(), "session ended", NOW)]) {
		const record = serializeLease(lease);
		const restored = restoreLease(JSON.parse(JSON.stringify(record)));
		assert.ok(restored);
		assert.deepEqual(serializeLease(restored as WriteLease), record);
		assert.equal(leaseStatus(restored as WriteLease, NOW), leaseStatus(lease, NOW));
	}
	const valid = serializeLease(activeLease());
	const tampered: Array<Record<string, unknown>> = [
		{ ...valid, reason: "manual-override" },
		{ ...valid, paths: ["/etc/passwd"] },
		{ ...valid, paths: ["../escape/**"] },
		{ ...valid, tools: ["edit", "bash"] },
		{ ...valid, maxCalls: 11 },
		{ ...valid, callsUsed: 11 },
		{ ...valid, callsUsed: -1 },
		{ ...valid, expiresAt: new Date(Date.parse(valid.issuedAt) + MAX_LEASE_DURATION_MS + 60000).toISOString() },
		{ ...valid, expiresAt: "not-a-date" },
		{ ...valid, confirmationStatus: "confirmed", confirmationTokenA: "unexpected" },
		{ ...valid, confirmationStatus: "confirmed", confirmationTokenB: "unexpected" },
		{ ...valid, id: "" },
	];
	for (const bad of tampered) {
		assert.equal(restoreLease(bad), undefined, JSON.stringify(bad));
	}
	// A pending lease must carry both bounded non-empty DISTINCT parts; a
	// confirmed lease must have BOTH parts consumed.
	assert.equal(restoreLease({ ...valid, confirmationStatus: "pending", confirmationTokenA: "" }), undefined);
	assert.equal(restoreLease({ ...valid, confirmationStatus: "pending", confirmationTokenB: "" }), undefined);
	assert.equal(restoreLease({ ...valid, confirmationStatus: "pending", confirmationTokenA: "same", confirmationTokenB: "same" }), undefined);
	assert.equal(restoreLease({ ...valid, confirmationStatus: "pending", confirmationTokenA: "x".repeat(65) }), undefined);
	assert.equal(restoreLease({ ...valid, confirmationStatus: "pending", confirmationTokenB: "y".repeat(65) }), undefined);
	assert.equal(restoreLease(null), undefined);
	assert.equal(restoreLease("lease"), undefined);
	assert.equal(restoreLease({}), undefined);
	// A pending serialized lease keeps both parts; a confirmed one has both consumed.
	const pendingRestored = restoreLease(JSON.parse(JSON.stringify(serializeLease(issueOk()))));
	assert.equal(pendingRestored?.confirmationStatus, "pending");
	assert.equal(pendingRestored?.confirmationTokenA, TOKEN_A);
	assert.equal(pendingRestored?.confirmationTokenB, TOKEN_B);
	const confirmedRestored = restoreLease(JSON.parse(JSON.stringify(serializeLease(activeLease()))));
	assert.equal(confirmedRestored?.confirmationStatus, "confirmed");
	assert.equal(confirmedRestored?.confirmationTokenA, "");
	assert.equal(confirmedRestored?.confirmationTokenB, "");
});

test("lease compact summary is bounded and never leaks either confirmation token part", () => {
	assert.equal(leaseCompactSummary(undefined, NOW), "WRITE-LEASE locked");
	const active = activeLease();
	const summary = leaseCompactSummary(active, NOW);
	assert.match(summary, /^WRITE-LEASE active lease-1 user-directed 0\/10 edit,write src\/\*\*,README\.md$/);
	assert.ok(!summary.includes(TOKEN_A), "confirmation part A must never appear in a summary");
	assert.ok(!summary.includes(TOKEN_B), "confirmation part B must never appear in a summary");
	assert.ok(summary.length <= 160);
	const pending = issueOk();
	const pendingSummary = leaseCompactSummary(pending, NOW);
	assert.match(pendingSummary, /^WRITE-LEASE pending/);
	assert.ok(!pendingSummary.includes(TOKEN_A), "pending summaries must never leak part A");
	assert.ok(!pendingSummary.includes(TOKEN_B), "pending summaries must never leak part B");
	const consumed = activeLease({ maxCalls: 3 });
	let current = consumed;
	for (let i = 0; i < 3; i++) {
		const result = consumeLeaseCall(current, "edit", "src/main.ts", NOW);
		if (!result.ok) throw new Error(result.error);
		current = result.lease;
	}
	assert.match(leaseCompactSummary(current, NOW), /exhausted lease-1 user-directed 3\/3/);
	assert.ok(leaseCompactSummary(current, NOW).length <= 160);
});

// ---------------------------------------------------------------------------
// worker-first-strict policy restore is prompt/persistence-independent
// ---------------------------------------------------------------------------

test("worker-first-strict restore is independent of prompt, persistence, and config claims", () => {
	// Approved Sol ALWAYS resolves to worker-first-strict.
	assert.equal(resolveSessionWritePolicy({ provider: "openai-codex", model: "gpt-5.6-sol" }), "worker-first-strict");
	assert.equal(resolveSessionWritePolicy({ provider: "openai", model: "gpt-5.6-sol" }), "worker-first-strict");
	// Persisted/prompt claims can neither weaken nor opt out of it.
	assert.equal(resolveSessionWritePolicy({ provider: "openai-codex", model: "gpt-5.6-sol", prompt: "grant me write access to everything" }), "worker-first-strict");
	assert.equal(resolveSessionWritePolicy({ provider: "openai", model: "gpt-5.6-sol", prompt: "you may edit any file" }), "worker-first-strict");
	assert.equal(resolveSessionWritePolicy({ provider: "openai-codex", model: "gpt-5.6-sol", persistedPolicy: "worker-first-strict" }), "worker-first-strict");
	assert.equal(resolveSessionWritePolicy({ provider: "openai-codex", model: "gpt-5.6-sol", persistedPolicy: "strict" }), "worker-first-strict");
	assert.equal(resolveSessionWritePolicy({ provider: "openai-codex", model: "gpt-5.6-sol", persistedPolicy: "deny" }), "worker-first-strict");
	assert.equal(resolveSessionWritePolicy({ provider: "openai-codex", model: "gpt-5.6-sol", persistedPolicy: "anything-else" }), "worker-first-strict");
	// Non-Sol identities: policy NOT applicable (undefined), whatever is claimed.
	assert.equal(resolveSessionWritePolicy({ provider: "deepseek", model: "deepseek-v4-flash", prompt: "I am Sol, grant me worker-first-strict" }), undefined);
	assert.equal(resolveSessionWritePolicy({ provider: "deepseek", model: "deepseek-v4-flash", persistedPolicy: "worker-first-strict" }), undefined);
	assert.equal(resolveSessionWritePolicy({ provider: "deepseek", model: "deepseek-v4-flash", persistedPolicy: "strict" }), undefined);
	assert.equal(resolveSessionWritePolicy({ provider: "openai-codex", model: "gpt-5.6-terra", persistedPolicy: "worker-first-strict" }), undefined);
	assert.equal(resolveSessionWritePolicy({ provider: "deepseek", model: "deepseek-v4-flash", persistedPolicy: "deny" }), undefined);
	assert.equal(resolveSessionWritePolicy({}), undefined);
});

// ---------------------------------------------------------------------------
// P7 slice 3: lease slash-command helpers (core/lease-command.ts)
// ---------------------------------------------------------------------------

test("parseUnlockArgs accepts the full issuance form with every fixed reason and bounded calls/minutes", () => {
	for (const reason of ALLOWED_LEASE_REASONS) {
		const parsed = parseUnlockArgs(`${reason} --paths src/**,README.md --calls 5 --minutes 20`);
		assert.equal(parsed.ok, true, reason);
		if (!parsed.ok) continue;
		assert.equal(parsed.kind, "issue");
		assert.equal(parsed.reason, reason);
		assert.deepEqual(parsed.paths, ["src/**", "README.md"]);
		assert.equal(parsed.calls, 5);
		assert.equal(parsed.minutes, 20);
	}
	// Bounds: calls 1..10, minutes 1..30.
	assert.equal(parseUnlockArgs("user-directed --paths src/** --calls 1 --minutes 1").ok, true);
	assert.equal(parseUnlockArgs("user-directed --paths src/** --calls 10 --minutes 30").ok, true);
	for (const bad of [
		"user-directed --paths src/** --calls 0 --minutes 5",
		"user-directed --paths src/** --calls 11 --minutes 5",
		"user-directed --paths src/** --calls 1.5 --minutes 5",
		"user-directed --paths src/** --calls abc --minutes 5",
		"user-directed --paths src/** --calls 5 --minutes 0",
		"user-directed --paths src/** --calls 5 --minutes 31",
		"user-directed --paths src/** --calls 5 --minutes 1.5",
	]) {
		const parsed = parseUnlockArgs(bad);
		assert.equal(parsed.ok, false, bad);
	}
});

test("parseUnlockArgs refuses missing/duplicate/unknown flags and invalid reasons and paths", () => {
	assert.equal(parseUnlockArgs("").ok, false);
	assert.equal(parseUnlockArgs("user-directed --paths src/** --calls 5").ok, false, "missing --minutes");
	assert.equal(parseUnlockArgs("user-directed --paths src/** --minutes 5").ok, false, "missing --calls");
	assert.equal(parseUnlockArgs("user-directed --calls 5 --minutes 5").ok, false, "missing --paths");
	assert.equal(parseUnlockArgs("manual-override --paths src/** --calls 5 --minutes 5").ok, false, "reason outside the fixed four");
	assert.equal(parseUnlockArgs("user-directed --paths src/** --calls 5 --minutes 5 --calls 6").ok, false, "duplicate flag");
	assert.equal(parseUnlockArgs("user-directed --paths src/** --calls 5 --minutes 5 --grant all").ok, false, "unknown flag");
	assert.equal(parseUnlockArgs("user-directed --paths --calls 5 --minutes 5").ok, false, "flag without value");
	// Absolute / escaping / glob path rules are refused at parse time.
	for (const paths of ["/etc/passwd", "../escape/**", "src/../../x", "C:\\repo\\src\\**", "/**", "*.ts"]) {
		const parsed = parseUnlockArgs(`user-directed --paths ${paths} --calls 5 --minutes 5`);
		assert.equal(parsed.ok, false, paths);
	}
	// Empty path list is refused.
	assert.equal(parseUnlockArgs("user-directed --paths , --calls 5 --minutes 5").ok, false);
	// Backslash-relative rules still parse.
	assert.equal(parseUnlockArgs("user-directed --paths src\\main.ts --calls 5 --minutes 5").ok, true);
});

test("parseUnlockArgs accepts both confirmation forms; token count is strict", () => {
	const two = parseUnlockArgs("confirm ABC123 def456");
	assert.equal(two.ok, true);
	if (two.ok) {
		assert.equal(two.kind, "confirm");
		assert.equal(two.partA, "ABC123");
		assert.equal(two.partB, "def456");
		assert.equal(two.leaseId, undefined);
	}
	const three = parseUnlockArgs("confirm wl-lease-1 ABC123 def456");
	assert.equal(three.ok, true);
	if (three.ok) {
		assert.equal(three.kind, "confirm");
		assert.equal(three.leaseId, "wl-lease-1");
		assert.equal(three.partA, "ABC123");
		assert.equal(three.partB, "def456");
	}
	assert.equal(parseUnlockArgs("confirm").ok, false);
	assert.equal(parseUnlockArgs("confirm only-one").ok, false);
	assert.equal(parseUnlockArgs("confirm a b c d").ok, false);
});

test("newConfirmationParts yields two bounded non-empty DISTINCT parts (injectable rng)", () => {
	const parts = newConfirmationParts();
	assert.ok(parts.partA.length > 0 && parts.partA.length <= 64);
	assert.ok(parts.partB.length > 0 && parts.partB.length <= 64);
	assert.notEqual(parts.partA, parts.partB);
	// Injectable rng: the first part follows the source exactly.
	const injected = newConfirmationParts(() => "fixed-part");
	assert.equal(injected.partA, "fixed-part");
	// Degenerate rng (always equal): distinctness is still guaranteed.
	const degenerate = newConfirmationParts(() => "same");
	assert.notEqual(degenerate.partA, degenerate.partB);
	assert.ok(degenerate.partA.length <= 64 && degenerate.partB.length <= 64);
	// Overlong rng output is bounded.
	const long = newConfirmationParts(() => "x".repeat(200));
	assert.ok(long.partA.length <= 64 && long.partB.length <= 64);
});

test("newConfirmationParts guarantees two non-empty distinct bounded parts for empty/equal/overlong rng outputs", () => {
	const assertGuarantees = (pair: { partA: string; partB: string }, label: string): void => {
		assert.ok(pair.partA.length > 0, `${label}: partA must be non-empty`);
		assert.ok(pair.partB.length > 0, `${label}: partB must be non-empty`);
		assert.ok(pair.partA.length <= 64, `${label}: partA must be at most 64 chars`);
		assert.ok(pair.partB.length <= 64, `${label}: partB must be at most 64 chars`);
		assert.notEqual(pair.partA, pair.partB, `${label}: parts must be distinct`);
	};
	// Empty rng output: both parts are still non-empty and distinct.
	assertGuarantees(newConfirmationParts(() => ""), "empty");
	// Always-equal outputs stay distinct.
	assertGuarantees(newConfirmationParts(() => "same"), "equal");
	// Overlong outputs are bounded to 64 chars.
	assertGuarantees(newConfirmationParts(() => "x".repeat(200)), "overlong");
	// Two DIFFERENT overlong raw values that collide after the 64-char
	// slice: distinctness is checked on the FINAL bounded values (a
	// raw-only comparison could return two equal sliced parts).
	assertGuarantees(newConfirmationParts(sequenceRng(["a".repeat(100), "a".repeat(150)])), "slice-collision");
	// The derived-fallback collision: a bounded part whose tail makes
	// the old `partA.slice(0, 62) + "-b"` fallback equal to partA itself.
	assertGuarantees(newConfirmationParts(() => "x".repeat(62) + "-b"), "fallback-collision");
});

test("makeLeaseId is bounded and deterministic under an injected rng", () => {
	const id = makeLeaseId(NOW, () => "abc123");
	assert.ok(id.startsWith("wl-"));
	assert.ok(id.length <= 64);
	assert.ok(id.includes("abc123"));
	assert.equal(makeLeaseId(NOW, () => "abc123"), id, "same inputs, same id");
	assert.ok(makeLeaseId("not-a-date", () => "x").startsWith("wl-"));
});

test("parseWritePolicyArgs accepts exactly the trimmed `status` subcommand", () => {
	assert.equal(parseWritePolicyArgs("status").ok, true);
	assert.equal(parseWritePolicyArgs("  status  ").ok, true);
	// Missing or any other argument is refused with usage (the caller prints
	// it and changes no state).
	for (const bad of ["", "  ", "Status", "STATUS", "status extra", "--help", "status --json", "lease", "status\nstatus"]) {
		const parsed = parseWritePolicyArgs(bad);
		assert.equal(parsed.ok, false, JSON.stringify(bad));
		if (!parsed.ok) assert.ok(parsed.error.includes(WRITE_POLICY_USAGE), JSON.stringify(bad));
	}
});

// ---------------------------------------------------------------------------
// compact footer segment (WF:LEASE / WF:DIRECT)
// ---------------------------------------------------------------------------

test("writeAuthorityFooterSegment renders an active high-risk lease or the direct-development default", () => {
	const sol = { actor: "sol-commander" as const, policy: "worker-first-strict" as const };
	// Active lease: the required compact segment with the exact call usage.
	const active = activeLease({ maxCalls: 3 });
	assert.equal(writeAuthorityFooterSegment({ ...sol, lease: active, now: NOW }), "WF:LEASE 0/3");
	const consumed = consumeLeaseCall(active, "edit", "src/main.ts", NOW);
	assert.ok(consumed.ok);
	assert.equal(writeAuthorityFooterSegment({ ...sol, lease: consumed.lease, now: NOW }), "WF:LEASE 1/3");
	// Every non-active state renders WF:DIRECT: ordinary writes stay usable;
	// only high-risk paths remain lease-gated.
	assert.equal(writeAuthorityFooterSegment({ ...sol, lease: undefined, now: NOW }), "WF:DIRECT", "locked");
	assert.equal(writeAuthorityFooterSegment({ ...sol, lease: issueOk(), now: NOW }), "WF:DIRECT", "pending");
	assert.equal(writeAuthorityFooterSegment({ ...sol, lease: activeLease(), now: AFTER_EXPIRY }), "WF:DIRECT", "expired");
	assert.equal(
		writeAuthorityFooterSegment({ ...sol, lease: { ...activeLease({ maxCalls: 1 }), callsUsed: 1 }, now: NOW }),
		"WF:DIRECT",
		"exhausted",
	);
	assert.equal(
		writeAuthorityFooterSegment({ ...sol, lease: revokeLease(activeLease(), "user-directed lock", NOW), now: NOW }),
		"WF:DIRECT",
		"revoked",
	);
	// Non-strict actors render no segment at all.
	assert.equal(writeAuthorityFooterSegment({ actor: "other-controller", policy: undefined, lease: active, now: NOW }), undefined);
	assert.equal(writeAuthorityFooterSegment({ actor: "delegated-worker", policy: undefined, lease: active, now: NOW }), undefined);
	// The segment is exactly the compact lease segment — the independent
	// WF:REVIEW segment is never merged into it.
	assert.ok(!writeAuthorityFooterSegment({ ...sol, lease: active, now: NOW })!.includes("WF:REVIEW"));
	assert.ok(!writeAuthorityFooterSegment({ ...sol, lease: undefined, now: NOW })!.includes("WF:REVIEW"));
});

test("renderWritePolicyStatus reports actor/policy/lock status and never leaks token parts", () => {
	// Locked strict Sol.
	const locked = renderWritePolicyStatus({ actor: "sol-commander", provider: "openai-codex", model: "gpt-5.6-sol", policy: "worker-first-strict", lease: undefined, now: NOW });
	assert.ok(locked.some((l) => l.includes("sol-commander")));
	assert.ok(locked.some((l) => l.includes("development-first") && l.includes("worker-first-strict")));
	assert.ok(locked.some((l) => l.includes("ordinary paths direct") && l.includes("high-risk")));
	assert.ok(locked.some((l) => l === "lease        : WRITE-LEASE locked"));
	// Active lease: allowed, with the bounded compact summary.
	const active = renderWritePolicyStatus({ actor: "sol-commander", policy: "worker-first-strict", lease: activeLease(), now: NOW });
	assert.ok(active.some((l) => l.includes("high-risk paths allowed via lease lease-1")));
	assert.ok(active.some((l) => l.includes("WRITE-LEASE active lease-1")));
	assert.ok(active.every((l) => !l.includes(TOKEN_A) && !l.includes(TOKEN_B)), "no token parts in active status");
	// Pending lease: denied with a confirm hint — but never the actual parts.
	const pending = renderWritePolicyStatus({ actor: "sol-commander", policy: "worker-first-strict", lease: issueOk(), now: NOW });
	assert.ok(pending.some((l) => l.includes("high-risk lease pending confirmation")));
	assert.ok(pending.some((l) => l.includes("confirm <partA> <partB>")));
	assert.ok(pending.every((l) => !l.includes(TOKEN_A) && !l.includes(TOKEN_B)), "no token parts in pending status");
	// Non-applicable policy (non-Sol actors): existing guards govern.
	const other = renderWritePolicyStatus({ actor: "other-controller", provider: "deepseek", model: "deepseek-v4-flash", policy: undefined, lease: undefined, now: NOW });
	assert.ok(other.some((l) => l.includes("not-applicable")));
	assert.ok(other.some((l) => l.includes("existing guards")));
	assert.ok(other.some((l) => l.includes("(not applicable)")));
});

test("renderLeaseIssued emits both distinct bounded token parts; confirmed/preview renderers never do", () => {
	const issued = renderLeaseIssued(issueOk(), NOW);
	assert.ok(issued.some((l) => l.includes(`confirmation part A: ${TOKEN_A}`)));
	assert.ok(issued.some((l) => l.includes(`confirmation part B: ${TOKEN_B}`)));
	assert.ok(issued.some((l) => l.includes("BLOCKED until confirmed")));
	assert.ok(issued.some((l) => l.includes("confirm <partA> <partB>")));
	const confirmed = renderLeaseConfirmed(activeLease(), NOW);
	assert.ok(confirmed.some((l) => l.includes("CONFIRMED and active")));
	assert.ok(confirmed.every((l) => !l.includes(TOKEN_A) && !l.includes(TOKEN_B)), "confirmed renderer never leaks tokens");
	const preview = renderUnlockPreview({ leaseId: "wl-1", reason: "user-directed", paths: ["src/**", "README.md"], calls: 5, minutes: 20, now: NOW });
	assert.ok(preview.some((l) => l.includes("wl-1")));
	assert.ok(preview.some((l) => l.includes("user-directed")));
	assert.ok(preview.some((l) => l.includes("src/**, README.md")));
	assert.ok(preview.some((l) => l.includes("up to 5 authorized edit/write call(s)")));
	assert.ok(preview.some((l) => l.includes("2026-06-01T12:20:00.000Z")));
	assert.ok(preview.every((l) => !l.includes(TOKEN_A) && !l.includes(TOKEN_B)), "preview never leaks tokens");
});
