# Contract and impact scope

## Turning a requirement into acceptance criteria

- Split the requirement into testable statements: "when X, the system does Y"
  with observable outcomes.
- For each criterion, name the artifact that proves it (a test, a command
  output, a file).
- Explicitly list what is NOT in scope; an uncontracted boundary is a
  future bug.
- If the requirement conflicts with existing behavior, decide which wins and
  say so before coding.

## Mapping impact

Before editing, answer:

- Which files change? (source, tests, config, docs)
- Which existing tests could break? Run the smallest useful baseline only
  when reproducing a failure or measuring an optimization, then rerun the
  affected checks after the change.
- Who calls the changed functions? Grep for callers and imports.
- Does the change affect serialized formats, config schemas, or public
  interfaces? Note compatibility impact.
- Does the change need docs (README, help text, changelog)?

## Scope discipline

- If the change grows beyond the contract mid-implementation, stop and
  renegotiate the contract instead of silently expanding.
- Keep unrelated refactors out of the same change; they obscure review and
  bisection.
