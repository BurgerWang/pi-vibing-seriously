---
description: Debug a failure — reproduce first, preserve the original error verbatim, fix the root cause, then regression-verify. Never fix what you cannot reproduce.
argument-hint: "<failure-description>"
---

# Debug

Failure: $ARGUMENTS

## Process

1. **Reproduce** — run the failing case yourself with the exact command.
   Save the FULL original error output verbatim before touching anything;
   do not paraphrase it.
2. **Preserve** — keep the original error as evidence (file or quoted
   block). Your memory of the error is not evidence.
3. **Isolate** — shrink to a minimal repro; bisect changes/config if the
   failure appeared after a change.
4. **Root cause** — identify the mechanism ("X happens because Y"),
   verified by reading the code path. A symptom patch (silencing the
   error, special-casing one input) is not a fix.
5. **Fix** — change the root cause. Do not delete or weaken the test/check
   that caught the bug.
6. **Regression verify** — rerun the original repro (must pass), the
   related tests, then the full suite. Add a regression test if none
   exists. Record commands and results.

## Constraints

- If you cannot reproduce, say so with the evidence you have — do not
  guess a fix.
- Report the fix and what behavior (if any) changed beyond the bug.

## Process

- Follow the skill:debugging-workflow end to end.
- Report verification verdicts in the skill:validation-ladder format.
