---
description: Build or change functionality — contract first, real implementation, tests in sync, verification evidence. No stubs or TODOs masquerading as completion.
argument-hint: "<task>"
---

# Build

Task: $ARGUMENTS

## Process

1. **Contract** — restate the requirement as acceptance criteria; list
   affected files and tests.
2. **Impact scope** — what changes, what tests must run, what callers and
   docs are touched.
3. **Implement** — real, working code. No stubs, no TODO shells, no empty
   handlers pretending to be features.
4. **Test** — add/update tests for the changed behavior and run them. A
   change without a test that exercises it is incomplete.
5. **Verify** — run typecheck and the full test suite (declared recipes
   preferred); record exact commands and outputs.
6. **Report** — changed files, commands run, results, and remaining risks.

## Constraints

- Do not commit, push, or publish anything unless explicitly asked.
- A task is complete only when its tests pass and evidence is recorded —
  never claim a check passed that did not run.
- If the requirement is ambiguous, state the assumption you implemented.

## Process

- Follow the skill:implementation-workflow end to end.
- Report verification verdicts in the skill:validation-ladder format.
