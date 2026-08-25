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

- Use this as the single primary development skill. Add at most one domain
  specialist unless distinct task phases genuinely require more.
- Obey the active project's AGENTS and runtime write-authority contract. In a
  pi-dev-workbench product project, fixed Sol -> Luna delivery is mandatory;
  this skill neither duplicates nor weakens that authority.
- Use `skill:debugging-workflow` only after an actual failure and
  `skill:validation-ladder` only for a formal verdict, not routine feedback.
- In a pi-dev-workbench project, after semantic ACCEPT and the relevant final
  checks, `workbench_commit_reviewed` may create the review-bound local
  checkpoint without per-commit user confirmation. If it reports
  `CALL_WORKBENCH_COMMIT_REVIEWED_AGAIN`, continue until clean or until the tool
  fails closed; do not ask the user to stage an already reviewed backlog. It
  never authorizes push, publish, release, amend, worktree reset, clean, stash,
  or branch switching. Outside that dedicated capability, do not commit unless
  explicitly asked.

## Conditional references

- Read [references/contract-and-scope.md](references/contract-and-scope.md)
  only when scope or compatibility is unclear.
- Read [references/verification-evidence.md](references/verification-evidence.md)
  only when formal evidence must be recorded.
- Read [references/risk-reporting.md](references/risk-reporting.md) only for
  a non-trivial residual-risk report.
