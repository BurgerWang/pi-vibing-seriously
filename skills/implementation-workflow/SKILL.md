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
5. **Verify** — use focused checks while the candidate changes. Once stable,
   run one final typecheck/test/build or gate set proportionate to risk;
   record exact commands and outputs.
6. **Evidence** — report changed files, commands run, and results.
7. **Risk** — list remaining risks; never claim completion of checks that did
   not run.

## Rules

- A task is not done until its tests pass and the verification evidence is
  written down.
- Use the project's declared recipes (`.pi/workbench/recipes.yaml`) for
  project commands when the active Pi mode requires them.
- If a requirement turns out to be ambiguous, state the assumption you
  implemented.
- Do not commit, push, or publish unless explicitly asked.

## Fixed Sol -> Luna execution

- Sol owns requirements, acceptance criteria, cross-cutting architecture,
  approved paths, review, and the final verdict. Routine source, test, and
  documentation writes in DEV belong to one bounded Luna delegation.
- Use one bounded delegation call for a coherent implementation slice. Complete delivery is
  reviewed and closed automatically; explicit review/status is only for
  incomplete coverage, conflict, or recovery. A worker report is never
  acceptance.
- Sol may edit/write directly only through an active user-issued temporary
  lease bounded by paths, tools, calls, and time. This is an explicit
  exception, never the routine path, and never authorizes bash.
- Use focused tests during development. Run final gates once on a stable
  candidate when task or release risk requires them.

## Details

- See [references/contract-and-scope.md](references/contract-and-scope.md)
  for turning requirements into acceptance criteria and mapping impact.
- See [references/verification-evidence.md](references/verification-evidence.md)
  for what counts as verification evidence and how to record it.
- See [references/risk-reporting.md](references/risk-reporting.md) for
  reporting remaining risk honestly.
- Use `skill:validation-ladder` when reporting verification verdicts.
