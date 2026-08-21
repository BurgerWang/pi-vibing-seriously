---
name: debugging-workflow
description: Primary workflow for an observed failure or unexpected behavior. Reproduce, isolate, fix the root cause, add a regression, and verify the affected area without automatically running the full suite.
---

# Debugging Workflow

1. **Reproduce** — run the exact failing case before editing. Preserve the
   command and relevant unabridged error once; keep very large output in its
   log instead of copying it repeatedly into context.
2. **Isolate** — reduce the input or path until the responsible mechanism is
   clear. Bisect only when history is genuinely needed.
3. **Explain** — state the root cause as "X happens because Y" and verify the
   code path. Do not patch a surface symptom.
4. **Repair** — change the mechanism and add or update a regression that
   would fail without the fix.
5. **Verify proportionately** — rerun the original reproduction and affected
   tests. Add typecheck/build when the changed boundary needs it. Run the full
   suite only for cross-cutting risk, a formal gate, a release, or a user
   request.

## Rules

- Never "fix" by deleting or weakening the test/check that caught the bug.
- If the failure cannot be reproduced, continue with read-only diagnosis and
  report uncertainty; do not invent a repair.
- One fix per root cause; if two symptoms share a cause, fix the cause once.
- If the fix changes behavior beyond the bug, say so in the report.

## Conditional references

- Read [references/repro-and-isolation.md](references/repro-and-isolation.md)
  only for a non-obvious or intermittent reproduction.
- Read [references/root-cause-analysis.md](references/root-cause-analysis.md)
  only when competing root-cause hypotheses remain.
- Read [references/regression-checklist.md](references/regression-checklist.md)
  only when planning a broader regression boundary.
