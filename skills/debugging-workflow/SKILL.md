---
name: debugging-workflow
description: Debug a failure systematically — reproduce first, preserve the original error verbatim, isolate the cause, fix the root cause (not the symptom), then regression-verify. Use whenever code misbehaves, a test fails, or behavior changed unexpectedly.
---

# Debugging Workflow

1. **Reproduce** — get a reliable, minimal reproduction. Record the exact
   command and the FULL original error output verbatim before touching
   anything. Do not paraphrase the error.
2. **Preserve** — save the original error (log file or quoted block). The
   original is evidence; your memory of it is not.
3. **Isolate** — shrink the repro: which input, which call, which version
   changed it. Use bisection (binary search over changes) when the failure
   appeared after a change.
4. **Root cause** — identify the mechanism, not the surface symptom. State it
   as "X happens because Y"; verify by reading the code path.
5. **Fix the root cause** — change the mechanism. A fix that only masks the
   symptom (silences the error, special-cases one input) is not a fix.
6. **Regression verify** — rerun the original repro (must pass), run the
   related test set, then the full suite. Record commands and results.

## Rules

- Never "fix" by deleting or weakening the test/check that caught the bug.
- Never fix what you cannot reproduce; if you cannot reproduce, report that
  with the evidence you have.
- One fix per root cause; if two symptoms share a cause, fix the cause once.
- If the fix changes behavior beyond the bug, say so in the report.

## Details

- See [references/repro-and-isolation.md](references/repro-and-isolation.md)
  for reproduction techniques and bisection.
- See [references/root-cause-analysis.md](references/root-cause-analysis.md)
  for distinguishing root cause from symptom and common root-cause patterns.
- See [references/regression-checklist.md](references/regression-checklist.md)
  for verifying a fix without introducing regressions.
