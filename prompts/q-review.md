---
description: Review a diff, commit, or the current implementation — logic, tests, compatibility, and omissions. Report findings; do not change code.
argument-hint: "[diff-or-commit-or-scope]"
---

# Review

Review only. Do NOT modify any file, stage changes, or run destructive
commands.

Scope: $ARGUMENTS — a diff, a commit (e.g. `HEAD~1..HEAD`), or the current
implementation if no scope is given.

## Focus areas

1. **Logic** — correctness of the changed code: boundary conditions, error
   paths, state handling, and whether the change does what its description
   claims.
2. **Tests** — does the change add/update tests for its behavior? Do the
   tests assert real behavior? Would they fail without the change?
3. **Compatibility** — dependencies, config schemas, public interfaces,
   serialized formats, and docs affected by the change.
4. **Omissions** — missing error handling, missing docs/changelog, dead
   code left behind, edge cases the change forgot.

## Deliverables

1. **Findings** — each with evidence: file path, line numbers, and the
   relevant code or output.
2. **Classification** — confirmed / probable / unknown, with the missing
   evidence named for anything not directly observed.
3. **Severity** — high / medium / low with a one-line justification.
4. **Suggested fixes** — in prose, never applied.
5. **Coverage** — what was reviewed and what was NOT_RUN.

## Constraints

- This is a review, not an implementation — no edits, no fixes applied.
- Do not approve or reject the change wholesale; report findings the
  author can act on.

## Process

- Use the skill:repository-audit classification and report format.
- Use the skill:validation-ladder verdicts for anything you verified.
