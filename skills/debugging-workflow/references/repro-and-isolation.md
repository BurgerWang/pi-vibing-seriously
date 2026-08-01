# Reproduction and isolation

## Reproduce first

- Run the exact failing command yourself and capture the complete output —
  start, error text, stack, exit code, end. Save it to a file if long.
- Note the environment: input data, working directory, versions, time of day
  if time-dependent.
- If the failure is intermittent, run it repeatedly and record the failure
  rate; an intermittent bug needs a different hunt than a deterministic one.

## Minimal reproduction

Reduce until you cannot remove anything without losing the failure:

1. Start from the failing case, not a toy example.
2. Remove parts (inputs, options, modules) one at a time; keep whatever still
   fails.
3. The minimal repro is the artifact you will test the fix against.

## Bisection

When the failure appeared after a change:

- Find the last known-good state (commit, config, data version).
- Binary search the range: test the midpoint, keep the failing half.
- For config/parameter failures, bisect over parameters instead of commits.
- Automated bisection (`git bisect`) is a tool; the same logic works by hand.

## When reproduction fails

- Report honestly: "could not reproduce" with the attempts made and the
  evidence gathered.
- Ask for the missing ingredient (exact input, error text, environment)
  instead of guessing a fix.
