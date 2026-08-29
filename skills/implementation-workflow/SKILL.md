---
name: implementation-workflow
description: Primary workflow for building or changing functionality. Use for implementation tasks that need a scoped contract, real code, focused tests, proportionate final verification, and a concise risk report.
---

# Implementation Workflow

1. **Contract** — state observable acceptance conditions and the smallest
   coherent scope. Record assumptions only when ambiguity affects behavior.
2. **Inspect** — find the relevant callers, tests, configuration, and public
   contracts. Do not perform a repository-wide orientation for a known area.
3. **Implement** — write complete code and update the tests that exercise the
   changed behavior. Do not leave stubs or placeholder completion claims.
4. **Iterate narrowly** — run the smallest useful reproduction and affected
   tests while the candidate is changing.
5. **Verify once stable** — run one final check set proportionate to risk.
   Use the full suite only for cross-cutting changes, formal gates, releases,
   or an explicit user request.
6. **Report briefly** — name changed files, checks that ran, and remaining
   risk. Never claim an unrun check passed.

## Coordination

- Use this as the primary development skill. Add at most one domain
  specialist unless distinct phases require more.
- Obey the active project's AGENTS and runtime write-authority contract. In a
  pi-dev-workbench product project, ordinary development is direct in DEV,
  protected high-risk paths retain explicit authority, and delegation is an
  optional bounded execution path; this skill neither duplicates nor weakens
  that authority.
- Use `skill:debugging-workflow` only after an actual failure and
  `skill:validation-ladder` only for a formal verdict, not routine feedback.
- In a pi-dev-workbench project, after semantic ACCEPT and the relevant final
  checks, `workbench_git action=checkpoint` may batch every compatible sealed
  reviewed slice without per-commit user confirmation or manual staging. Do
  not loop on unrelated remaining changes. Use `action=push` only after the
  user explicitly requests publication and bind the exact current HEAD. It
  never authorizes force, ref deletion, release, amend, worktree reset, clean,
  stash, branch switching, Gate, Formal, or production authority.

## Conditional references

- Read [references/contract-and-scope.md](references/contract-and-scope.md)
  only when scope or compatibility is unclear.
- Read [references/verification-evidence.md](references/verification-evidence.md)
  only when formal evidence must be recorded.
- Read [references/risk-reporting.md](references/risk-reporting.md) only for
  a non-trivial residual-risk report.
