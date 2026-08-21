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
5. **Verify** — use focused checks while developing. Once the candidate is
   stable, run one final typecheck/test/build or gate set proportionate to
   the risk; record exact commands and outputs.
6. **Report** — changed files, commands run, results, and remaining risks.

## Constraints

- Do not commit, push, or publish anything unless explicitly asked.
- A task is complete only when its tests pass and evidence is recorded —
  never claim a check passed that did not run.
- If the requirement is ambiguous, state the assumption you implemented.

## Fixed Sol -> Luna execution

- Sol owns requirements, acceptance criteria, cross-cutting architecture,
  approved paths, review, and the final verdict. Routine source, test, and
  documentation writes in DEV belong to one bounded Luna delegation.
- Use one bounded delegation call for a coherent implementation slice. A complete
  result is reviewed and closed automatically. Use explicit review/status
  only for incomplete coverage, conflict, or recovery. A worker report is
  never acceptance.
- Sol may edit/write directly only through an active user-issued temporary
  lease bounded by paths, tools, calls, and time. This is an explicit
  exception, never the routine path, and never authorizes bash.
- Keep development feedback to focused tests. Run final gates once on the
  stable candidate when task or release risk requires them.

## Related workflow

- Follow the skill:implementation-workflow end to end.
- Report verification verdicts in the skill:validation-ladder format.
