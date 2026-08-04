---
name: implementation-workflow
description: End-to-end implementation workflow — requirement contract, impact scope, real implementation, tests, verification evidence, and remaining risk. Use whenever building or changing functionality.
---

# Implementation Workflow

1. **Contract** — restate the requirement as acceptance criteria. Confirm
   scope before coding. If the requirement is ambiguous, state the assumption
   you implemented.
2. **Impact scope** — identify files to change and tests to run. Check for
   callers, config, and docs that the change touches.
3. **Implement** — real code only. No stubs, no TODO shells, no empty
   handlers pretending to be features.
4. **Test** — add or update tests for the changed behavior; run them.
5. **Verify** — run typecheck and the full test suite; record exact commands
   and outputs.
6. **Evidence** — report changed files, commands run, and results.
7. **Risk** — list remaining risks; never claim completion of checks that did
   not run.

## Rules

- A task is not done until its tests pass and the verification evidence is
  written down.
- Prefer the project's declared recipes (`.pi/workbench/recipes.yaml`) for
  build/test/verify commands.
- If a requirement turns out to be ambiguous, state the assumption you
  implemented.
- Do not commit, push, or publish unless explicitly asked.

## Worker-first write authority

Implementation work in this project follows the worker-first workflow
contract:

1. **Sol owns the decision.** Sol owns requirements,
   cross-cutting architecture, scope, and acceptance criteria.
2. **Routine writes are worker-owned by default.** Concrete source, tests,
   docs, and config writes are routine worker slices: a fresh bounded worker
   implements them inside the approved contract; the worker owns routine
   local implementation decisions.
3. **High-risk decisions remain Sol-owned; the concrete writes are bounded
   worker slices.** Sol keeps the decision itself and delegates only bounded
   implementation scopes after the architecture is fixed.
4. **Defects go to a fresh worker.** A partial or defective slice is
   repaired by a new bounded delegation to a fresh worker, not by Sol
   directly repairing the files.
5. **The only exception is a user-issued temporary write lease.** Only an
   active human-issued lease (user-only slash commands) lets Sol write
   directly; it is bounded in calls, time, and project-relative paths.
6. **Worker reports are never acceptance.** A report records commands and
   observed results; it can never mark an acceptance criterion satisfied —
   only Sol maps evidence to criteria.
7. **Sol reviews the actual diff and runs the final gates.** Sol inspects
   the real diff (`workbench_review_worker_diff`) and runs the final
   verification recipes and gates before any verdict.

## Details

- See [references/contract-and-scope.md](references/contract-and-scope.md)
  for turning requirements into acceptance criteria and mapping impact.
- See [references/verification-evidence.md](references/verification-evidence.md)
  for what counts as verification evidence and how to record it.
- See [references/risk-reporting.md](references/risk-reporting.md) for
  reporting remaining risk honestly.
- Use `skill:validation-ladder` when reporting verification verdicts.
