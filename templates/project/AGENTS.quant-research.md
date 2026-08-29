# AGENTS — pi-dev-workbench quant-research profile

## Scope and modes

- This project covers mid/low-frequency research, data preparation,
  backtests, out-of-sample validation, and reporting.
- AUDIT is read-only, DEV implements, and VERIFY uses declared recipes to
  re-check a stable candidate.
- The workbench validates project outputs; it does not compute strategy
  metrics.
- For an ordinary replacement where the user supplies the exact path and exact
  old/new text, try one direct `edit` first. If it does not match, inspect and
  retry; do not pre-read only to rediscover the supplied text.

## Research contract

Before code or experiments, define the hypothesis, point-in-time universe,
period/frequency, benchmark, data availability, signal versus execution time,
costs, segmentation, and adoption rule. Preserve all trials, require
out-of-sample or walk-forward evidence, and report limitations.

The project writes `research/contract.json` for the research contract and
`results/quant-result.json` for the declared result. Base gates `b0`–`b6` and
research gates `q0`–`q5` return only PASS / FAIL / BLOCKED / NOT_RUN. Required
NOT_RUN checks cannot pass; model prose cannot satisfy machine checks.

## Development-first execution

- Ordinary source, test, and documentation edits are direct in DEV after
  scope is understood. Delegation is optional; it is not required for a
  write or defect repair.
- When delegation is useful, use one bounded call. Complete delivery is
  reviewed and closed automatically; explicit review/status is only for
  incomplete coverage, conflict, or recovery. A worker report is never
  acceptance.
- Dependency, security/permission/policy, deployment/migration, release, and
  Pi control paths require an explicit user-issued temporary write lease.
  The lease is bounded by paths, tools, calls, and time and never authorizes
  bash.
- After semantic ACCEPT and the relevant final checks, Sol may use
  `workbench_git action=checkpoint` once to batch all compatible sealed
  reviewed paths while preserving unrelated dirty/staged work. Use
  `action=push` only after an explicit user publication request and bind the
  exact current HEAD. Force, ref deletion, and history rewriting are absent.
- Use focused tests while iterating. Run final gates once on a stable
  candidate when research or release risk requires them; do not run the full
  ladder after every edit.

## Efficient skill routing

- `skill:quant-research-design` is the research router; it loads only the
  specialist needed for the current phase.
- `skill:implementation-workflow` handles code changes.
- `skill:debugging-workflow`, `skill:repository-audit`, and
  `skill:validation-ladder` apply only when their named activity occurs.

Data, selection, timing, backtest, experiment, and reporting specialists are
explicit on-demand resources. Do not preload them together, and open detailed
references only when the current decision needs them.

## Handoff

Briefly state changes, reproducible recipes, unvalidated claims, and limits.
