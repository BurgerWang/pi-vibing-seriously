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

## Development-first execution

- Ordinary source, test, and documentation edits are direct in DEV after
  scope is understood. Delegation is optional; it is not required for a
  write or a defect repair, which may stay in the same coherent change.
- When delegation is useful, one bounded call is the normal path: a complete
  result is reviewed and closed automatically. Use explicit review/status
  only for incomplete coverage, conflict, or recovery. A worker report is
  never acceptance.
- High-risk dependency, security, policy, deployment, migration, and Pi
  control paths require an explicit user-issued temporary write lease.
- Keep development feedback to focused tests. Run final gates once on the
  stable candidate when task or release risk requires them.

## Related workflow

- Follow the skill:implementation-workflow end to end.
- Report verification verdicts in the skill:validation-ladder format.
