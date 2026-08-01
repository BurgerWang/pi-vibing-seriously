# Verification evidence

## What counts as evidence

- Exact command + its output (pass or fail), not "it passed".
- File content after the change (relevant excerpts with paths).
- Test runner output with counts (e.g. "12 passed, 0 failed").
- Run records from the workbench (`workbench_read_run` / `/q-run-show`) when
  the project uses declared recipes.

## What does NOT count

- Your own summary of what you believe happened.
- "It worked in my head" reasoning, however confident.
- Output from a different command than the one claimed.
- A check that was planned but not executed.

## Recording

For each verification step, record:

```text
command : <exact command>
result  : <pass/fail + key output, or error text>
when    : <before/after which change>
```

Then state the verdict per the `skill:validation-ladder` format
(PASS / FAIL / BLOCKED / NOT_RUN) with the evidence inline.

## Common failure: verifying only the happy path

Run the negative cases too: the test that should fail before the fix, the
invalid input path, the missing-file path. Evidence of a fix includes showing
the failure existed before (repro) and is gone after.
