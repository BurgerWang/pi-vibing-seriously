/**
 * Built-in workbench gate catalog — the default validation ladder.
 *
 * Base gates B0-B6 apply to every profile; quant gates Q0-Q5 only load for
 * quant-research profiles (see effectiveGates in gate-schema.ts). A project's
 * gates.yaml can replace non-reserved built-ins and add gates; the canonical
 * machine-backed B6 safety gate is reserved and cannot be replaced.
 *
 * Conventions used by the default checks (documented in README):
 *   - recipe names: check:format, check:lint, check:typecheck, check:static,
 *     test:unit, test:integration, data:fetch, backtest (per-profile
 *     alternatives backtest:selection / backtest:timing are accepted)
 *   - artifacts: research/contract.json (Q0 research contract),
 *     results/quant-result.json (quant output contract)
 *
 * The workbench never computes strategy metrics: quant checks validate the
 * declared output against quant-result.schema.json and assert the presence
 * and finiteness of the fields the strategy must report. Everything that
 * cannot be machine-verified (look-ahead audit, survivorship audit, ...) is
 * a manual evidence check — it can only PASS with explicit manual evidence
 * recorded as type "manual", never from model prose.
 */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { QUANT_PROFILES, type Gate } from "./gate-schema.ts";

const RESULT = "results/quant-result.json";
const CONTRACT = "research/contract.json";
const WB = CONFIG_DIR_NAME + "/workbench";

function check(
	id: string,
	title: string,
	kind: Gate["checks"][number]["kind"],
	extra: Partial<Gate["checks"][number]> = {},
	description = "",
): Gate["checks"][number] {
	return { id, title, description, required: true, blocking: true, kind, ...extra };
}

const B0_CHECKS = [
	check(
		"b0.1",
		"Workbench config valid",
		"config",
		{},
		"project root, profile, recipes.yaml, gates.yaml and profiles.yaml load without issues",
	),
	check(
		"b0.2",
		"Project entry point identifiable",
		"file",
		{ any_of: ["package.json", "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts"] },
		"a standard project or language-stack manifest exists at the project root",
	),
	check(
		"b0.3",
		"Dependency configuration present",
		"file",
		{ any_of: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "uv.lock", "requirements.txt", "go.mod", "Cargo.toml", "Gemfile"] },
		"dependency manifests or lockfiles exist",
	),
	check(
		"b0.4",
		"Required workbench files present",
		"file",
		// The workbench configuration always lives at the REPOSITORY root
		// (.pi/workbench), even for nested projects (project.yaml project_dir) —
		// so this check carries the INTERNAL catalog-only `file_root:
		// "repository"` metadata and a nested `.pi/workbench` can never satisfy
		// it. The metadata is set here in the built-in catalog only: parseCheck
		// never reads or returns it and gates.yaml rejects both `root` and
		// `file_root` as unknown fields. General project-file checks (b0.2/b0.3,
		// json/numeric/schema) keep resolving against the effective root.
		{ any_of: [`${WB}/project.yaml`, `${WB}/recipes.yaml`], file_root: "repository" },
		"the workbench configuration written by /q-init exists at the repository root",
	),
];

const B1_CHECKS = [
	check("b1.1", "Format check passes", "recipe", { recipes: ["check:format", "format"] }, "declared format recipe runs with the expected exit code"),
	check("b1.2", "Lint check passes", "recipe", { recipes: ["check:lint", "lint"] }, "declared lint recipe runs with the expected exit code"),
	check("b1.3", "Typecheck passes", "recipe", { recipes: ["check:typecheck", "typecheck"] }, "declared typecheck recipe runs with the expected exit code"),
	check("b1.4", "Static analysis passes", "recipe", { recipes: ["check:static", "static", "check:analysis", "analysis"] }, "declared static-analysis recipe runs with the expected exit code"),
];

const B2_CHECKS = [
	check("b2.1", "Unit tests pass", "recipe", { recipes: ["test:unit", "unit", "test"] }, "declared unit-test recipe runs with the expected exit code"),
	check("b2.2", "Boundary conditions covered", "manual", { manual_prompt: "Evidence that boundary conditions (empty input, extremes, zero/negative values) are tested — e.g. test list or coverage report." }),
	check("b2.3", "Error paths covered", "manual", { manual_prompt: "Evidence that error paths are tested — failures return non-zero exit codes and are handled gracefully." }),
];

const B3_CHECKS = [
	check("b3.1", "Integration tests pass", "recipe", { recipes: ["test:integration", "integration", "test:e2e", "e2e"] }, "declared integration-test recipe runs with the expected exit code"),
	check("b3.2", "CLI/API entry and config loading smoke", "manual", { manual_prompt: "Smoke-test evidence that the CLI/API entry point works and configuration loads correctly." }),
	check("b3.3", "Data read/write path smoke", "manual", { manual_prompt: "Smoke-test evidence that the data read/write path works (for quant projects this is covered by the Q1 data:fetch recipe check)." }),
];

const B4_CHECKS = [
	check("b4.1", "CLI exit-code contract", "manual", { manual_prompt: "Evidence that the CLI contract holds: success exits 0, failures exit non-zero (test output or script run)." }),
	check("b4.2", "Structured vs human output consistent", "manual", { manual_prompt: "Evidence that JSON/CSV/schema output and human-readable output carry the same numbers." }),
	check("b4.3", "Artifact completeness", "manual", { manual_prompt: "Evidence that every declared artifact is produced by the pipeline (for quant projects the schema/artifact checks in Q gates cover this)." }),
];

const B5_CHECKS = [
	check("b5.1", "Reproducibility snapshot", "manual", { manual_prompt: "Evidence that config snapshot, run command, parameters and seed are recorded so the run can be reproduced." }),
	check("b5.2", "Git state and open issues documented", "manual", { manual_prompt: "Evidence that git state (commit, dirty files) and unresolved issues are documented in the handoff." }),
];

// ---------------------------------------------------------------------------
// B6 Development Safety (legacy machine kind `worker-first`) — machine-backed only.
//
// The eight checks evaluate the bounded WorkerFirstGateFacts object that the
// runtime injects into EVERY gate run (slash command AND model tool). No
// model prose, prompt text or manual evidence can satisfy them:
//   - missing facts        -> NOT_RUN (a required NOT_RUN never PASSes)
//   - runtime-blocked      -> BLOCKED (e.g. a pending/stale review blocks
//                             final verification)
//   - negative compliance  -> FAIL
// B6 has no prerequisites: it runs directly (selector "b6") without any
// manual B0-B5 evidence, and it is a universal base gate (base/all).
// ---------------------------------------------------------------------------

const B6_CHECKS = [
	check(
		"b6.1",
		"Worker-first Sol/Luna policy active",
		"worker-first",
		{ worker_first: "strict-policy-active" },
		"the session resolves to the fixed Sol/Luna worker-first-strict policy",
	),
	check(
		"b6.2",
		"No unauthorized commander writes (hard denial active)",
		"worker-first",
		{ worker_first: "no-unauthorized-commander-writes" },
		"zero unauthorized commander write attempts, or commander edit/write is hard-denied",
	),
	check(
		"b6.3",
		"No pending recovery review",
		"worker-first",
		{ worker_first: "no-pending-review" },
		"the latest delegation is not PENDING_REVIEW (review before the next delegation / VERIFY)",
	),
	check(
		"b6.4",
		"No stale recovery review",
		"worker-first",
		{ worker_first: "no-stale-review" },
		"the latest delegation is not STALE (no diff change since the reviewed hash)",
	),
	check(
		"b6.5",
		"Reviewed diff hash matches the current diff",
		"worker-first",
		{ worker_first: "reviewed-hash-matches-current" },
		"the latest reviewed diff hash equals the current diff hash",
	),
	check(
		"b6.6",
		"All worker paths within approved contracts",
		"worker-first",
		{ worker_first: "worker-paths-within-contracts" },
		"the latest valid PASS review found zero worker paths outside the parent-approved contracts (sequential review gating means earlier delegations could not be bypassed)",
	),
	check(
		"b6.7",
		"No active unexplained commander write lease",
		"worker-first",
		{ worker_first: "no-active-unexplained-lease" },
		"an active lease carries one of the fixed audited reasons; otherwise the lease is locked/terminal",
	),
	check(
		"b6.8",
		"Final verification initiated by the Sol commander",
		"worker-first",
		{ worker_first: "commander-initiated-final-verification" },
		"this gate run was initiated by the approved GPT-5.6 Sol commander (workers cannot run final gates)",
	),
];

const Q0_CHECKS = [
	check("q0.1", "Strategy type declared", "json", { json_file: CONTRACT, json_path: "strategy_type" }, "research contract declares the strategy type"),
	check("q0.2", "Universe declared", "json", { json_file: CONTRACT, json_path: "universe" }, "research contract declares the universe"),
	check("q0.3", "Frequency declared", "json", { json_file: CONTRACT, json_path: "frequency" }, "research contract declares the time frequency"),
	check("q0.4", "Benchmark declared", "json", { json_file: CONTRACT, json_path: "benchmark" }, "research contract declares the benchmark"),
	check("q0.5", "Signal and execution assumptions declared", "json", { json_file: CONTRACT, json_path: "signal" }, "research contract declares signal generation and execution assumptions"),
	check("q0.6", "Acceptance criteria declared", "json", { json_file: CONTRACT, json_path: "acceptance" }, "research contract declares acceptance criteria"),
];

const Q1_CHECKS = [
	check("q1.1", "Data pipeline runs", "recipe", { recipes: ["data:fetch", "fetch-data", "fetch"] }, "declared data recipe runs with the expected exit code"),
	check("q1.2", "Time coverage, missing/duplicate records, timezone", "manual", { manual_prompt: "Evidence that time coverage is verified, missing/duplicate records are handled, and timestamps/timezones are aligned." }),
	check("q1.3", "Adjustments and corporate actions", "manual", { manual_prompt: "Evidence that split/dividend adjustments and corporate actions are handled correctly." }),
	check("q1.4", "Delisting, point-in-time, survivorship", "manual", { manual_prompt: "Evidence that delisted names are included, data is point-in-time, and survivorship bias is controlled." }),
];

const Q2_CHECKS = [
	check("q2.1", "Backtest runs", "recipe", { recipes: ["backtest", "backtest:selection", "backtest:timing"] }, "declared backtest recipe runs with the expected exit code"),
	check("q2.2", "Output conforms to quant-result contract", "schema", { json_file: RESULT, schema_name: "quant-result" }, "results/quant-result.json validates against quant-result.schema.json"),
	check("q2.3", "Signal/execution timing declared", "json", { json_file: RESULT, json_path: "semantics.signal_execution_delay" }, "the artifact declares signal generation vs execution timing"),
	check("q2.4", "No look-ahead audit", "manual", { manual_prompt: "Evidence of a code/timestamp audit that no future information is used (signal uses only point-in-time data)." }),
	check("q2.5", "Rebalance semantics, cash and positions", "manual", { manual_prompt: "Evidence that rebalance semantics and cash/position accounting are verified." }),
	check("q2.6", "Costs and benchmark alignment", "manual", { manual_prompt: "Evidence that fees/slippage are modeled and the benchmark is aligned with the strategy return computation." }),
];

const Q3_CHECKS = [
	check("q3.1", "Split method declared", "json", { json_file: RESULT, json_path: "split.method" }, "results/quant-result.json declares split.method (walk-forward / train-validation-test / time-series)"),
	check("q3.2", "Multiple folds recorded", "numeric", { json_file: RESULT, json_path: "folds.length", numeric_min: 2 }, "at least two folds are recorded (full trial reporting)"),
	check("q3.3", "Seed, baseline and search space", "manual", { manual_prompt: "Evidence that seeds, the baseline comparison and the parameter search space are recorded." }),
	check("q3.4", "Full trial reporting", "manual", { manual_prompt: "Evidence that ALL trials are reported — failed trials are never deleted and results are never best-trial-only." }),
];

const Q4_CHECKS = [
	check("q4.1", "Out-of-sample range declared", "json", { json_file: RESULT, json_path: "split.test" }, "results/quant-result.json declares the out-of-sample test range"),
	check("q4.2", "Multi-fold out-of-sample", "numeric", { json_file: RESULT, json_path: "folds.length", numeric_min: 2 }, "multiple folds cover out-of-sample evaluation (override for single-split designs)"),
	check("q4.3", "Parameter stability", "manual", { manual_prompt: "Evidence that neighboring parameter values give similar results (stability, not a single lucky point)." }),
	check("q4.4", "Market-stage coverage", "manual", { manual_prompt: "Evidence that results are reported across different market stages/regimes." }),
	check("q4.5", "Cost sensitivity", "manual", { manual_prompt: "Evidence that results are robust to cost assumptions (sensitivity analysis)." }),
	check("q4.6", "Failed folds reported", "manual", { manual_prompt: "Evidence that failed folds and out-of-sample underperformance are reported, not hidden." }),
	check("q4.7", "Time-ordered research evidence", "schema", { json_file: RESULT, schema_name: "quant-research" }, "machine validation proves chronological train/validation/test folds, declared gap/embargo applicability, retained failures, and parameter-stability evidence references"),
];

const Q5_CHECKS = [
	check("q5.1", "Return reported", "numeric", { json_file: RESULT, json_path: "metrics.return" }, "metrics.return is a finite number"),
	check("q5.2", "Volatility reported", "numeric", { json_file: RESULT, json_path: "metrics.volatility" }, "metrics.volatility is a finite number"),
	check("q5.3", "Drawdown reported", "numeric", { json_file: RESULT, json_path: "metrics.drawdown" }, "metrics.drawdown is a finite number"),
	check(
		"q5.4",
		"Risk-adjusted metric reported",
		"json",
		{ json_file: RESULT, json_any_of_paths: ["metrics.sharpe", "metrics.sortino", "metrics.calmar", "metrics.information_ratio"] },
		"at least one of sharpe/sortino/calmar/information_ratio is reported",
	),
	check("q5.5", "Turnover reported", "numeric", { json_file: RESULT, json_path: "metrics.turnover" }, "metrics.turnover is a finite number"),
	check("q5.6", "Exposure reported", "numeric", { json_file: RESULT, json_path: "metrics.exposure" }, "metrics.exposure is a finite number"),
	check("q5.7", "Benchmark delta reported", "json", { json_file: RESULT, json_path: "metrics.benchmark_delta" }, "metrics.benchmark_delta is present"),
	check("q5.8", "Reporting completeness", "manual", { manual_prompt: "Evidence that pre/post-cost comparison, limitations and conclusion confidence level are stated." }),
];

function gate(
	id: string,
	title: string,
	description: string,
	prerequisites: string[],
	checks: Gate["checks"],
	acceptance: string,
	extra: Partial<Gate> = {},
): Gate {
	return {
		id,
		title,
		description,
		profiles: [],
		prerequisites,
		required: true,
		blocking: true,
		evidence: [],
		acceptance,
		checks,
		source: "catalog",
		...extra,
	};
}

export const BASE_GATES: readonly Gate[] = [
	gate(
		"b0",
		"Project Readiness",
		"Project root and entry point are identifiable, dependency configuration exists, required files exist, and recipe configuration is valid.",
		[],
		B0_CHECKS,
		"The project is initialized: workbench config valid, entry point and dependencies identifiable, required files present.",
	),
	gate(
		"b1",
		"Static Quality",
		"Format, lint, typecheck and static analysis all pass on declared recipes.",
		["b0"],
		B1_CHECKS,
		"All static-quality recipes (format, lint, typecheck, static analysis) run with the expected exit codes.",
	),
	gate(
		"b2",
		"Unit Correctness",
		"Unit tests pass; boundary conditions and error paths are covered.",
		["b1"],
		B2_CHECKS,
		"Unit-test recipe passes and boundary/error-path coverage is evidenced.",
	),
	gate(
		"b3",
		"Integration Correctness",
		"Integration tests pass; CLI/API entry, config loading and the data read/write path work.",
		["b2"],
		B3_CHECKS,
		"Integration-test recipe passes and entry/config/data-path smoke evidence is provided.",
	),
	gate(
		"b4",
		"Output Contract",
		"Structured output (JSON/CSV/schema), CLI exit codes, artifact completeness, and human-vs-structured consistency.",
		["b3"],
		B4_CHECKS,
		"Output contract audits pass: exit codes, structured output consistency, artifact completeness.",
	),
	gate(
		"b5",
		"Reproducibility and Handoff",
		"Config snapshot, git state, seed, run command, documentation and open issues are recorded.",
		["b4"],
		B5_CHECKS,
		"Reproducibility snapshot and handoff documentation are complete.",
	),
	gate(
		"b6",
		"Development Safety",
		"Machine-backed development safety: fixed Sol/Luna policy active, commander writes locked or explicitly leased, no pending or stale recovery review, reviewed binding is current, delegated paths stay within contract, no unexplained temporary lease is active, and final verification is commander-initiated. Facts are injected by the runtime; model prose can never satisfy these checks.",
		[],
		B6_CHECKS,
		"Development safety holds: routine writes are worker-owned, any commander write is explicitly leased, delegation recovery state is clean, reviewed binding is current, delegated paths stay within contracts, no unexplained active lease exists, and final verification is Sol-initiated.",
	),
];

export const QUANT_GATES: readonly Gate[] = [
	gate(
		"q0",
		"Research Contract",
		"Strategy type, universe, time frequency, benchmark, signal/execution assumptions and acceptance criteria are declared.",
		["b5"],
		Q0_CHECKS,
		"research/contract.json declares strategy type, universe, frequency, benchmark, signal/execution assumptions and acceptance criteria.",
		{ evidence: [CONTRACT], profiles: [...QUANT_PROFILES] },
	),
	gate(
		"q1",
		"Market Data Integrity",
		"Time coverage, missing/duplicate records, timezone, adjustments, corporate actions, delisting, point-in-time and survivorship bias.",
		["q0"],
		Q1_CHECKS,
		"The data pipeline runs and the integrity audits (coverage, adjustments, delisting, point-in-time, survivorship) are evidenced.",
	),
	gate(
		"q2",
		"Backtest Semantics",
		"No future functions, signal/execution timing consistency, rebalance semantics, cash and positions, costs and benchmark alignment.",
		["q1"],
		Q2_CHECKS,
		"The backtest runs, output conforms to the quant-result contract, timing is declared, and the semantic audits are evidenced.",
		{ evidence: [RESULT] },
	),
	gate(
		"q3",
		"Experiment Integrity",
		"Train/validation/test or walk-forward split, search space, seed, baseline and full trial records (never best-only).",
		["q2"],
		Q3_CHECKS,
		"The split method is declared, multiple folds are recorded, and seed/baseline/search-space/full-reporting audits are evidenced.",
		{ evidence: [RESULT] },
	),
	gate(
		"q4",
		"Out-of-Sample Robustness",
		"Out-of-sample evaluation, parameter stability, market-stage coverage, cost sensitivity, multiple folds, failed folds not hidden.",
		["q3"],
		Q4_CHECKS,
		"Out-of-sample range and multi-fold evaluation are recorded and robustness audits are evidenced.",
		{ evidence: [RESULT] },
	),
	gate(
		"q5",
		"Strategy Reporting",
		"Return, volatility, drawdown, risk-adjusted metric, turnover, exposure, benchmark delta, pre/post cost, limitations and conclusion confidence.",
		["q4"],
		Q5_CHECKS,
		"All required metrics are reported as finite numbers and the reporting audit is evidenced.",
		{ evidence: [RESULT] },
	),
];

export const GATE_CATALOG: readonly Gate[] = [...BASE_GATES, ...QUANT_GATES];
