# Verdict evidence

## PASS

Evidence must let someone else repeat the check and get the same result:

- `npm test` → "12 tests passed, 0 failed" (verbatim output).
- A file's content after a change, with path and relevant excerpt.
- A workbench run record: `run_id`, recipe name, exit code.

## FAIL

- The exact error output that contradicts the claim.
- The test that fails, with its assertion output.
- The file content that contradicts the claimed state.

## BLOCKED

- The missing prerequisite named precisely: "no network access",
  "credential X not available", "recipe `data:fetch` not declared",
  "service not running".
- What the check WOULD be, so it can be run when unblocked.

## NOT_RUN

- The check name and why it was not run (out of scope, time, no instruction).
- NOT_RUN + "but I'm confident" is still NOT_RUN.

## Common mistakes

- Quoting your own previous summary as evidence — summaries are claims, the
  underlying output is evidence.
- Marking BLOCKED as FAIL — blocked means the check could not run, not that
  it failed.
- Marking NOT_RUN as PASS because "nothing seemed wrong" — absence of
  evidence is not evidence of absence.
