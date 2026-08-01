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

## Details

- See [references/contract-and-scope.md](references/contract-and-scope.md)
  for turning requirements into acceptance criteria and mapping impact.
- See [references/verification-evidence.md](references/verification-evidence.md)
  for what counts as verification evidence and how to record it.
- See [references/risk-reporting.md](references/risk-reporting.md) for
  reporting remaining risk honestly.
- Use `skill:validation-ladder` when reporting verification verdicts.
