# Audit checklist

Work through the areas below in order. For each area record findings
(confirmed/probable/unknown) or mark the area NOT_RUN if you did not check it.

## 1. Build and run

- Does the project build with the commands its own docs declare?
- Are scripts reproducible (lockfiles, pinned tooling, no network-dependent
  steps hidden in build scripts)?
- Any build step that mutates source or skips checks?

## 2. Tests

- Do the tests exist for the behaviors the README claims?
- Run the suite if feasible (read-only execution): which tests fail?
- Are there skipped/disabled tests, and why?
- Do tests assert real behavior or only implementation details (mocking
  everything, asserting mocks were called)?

## 3. Configuration and environment

- Hardcoded values that should be configuration, and configuration that is
  never read (dead config).
- Secrets or credentials in source, docs, or history.
- Environment-dependent behavior that is not documented.

## 4. Dependencies

- Unused dependencies (import nothing) and undeclared dependencies (used but
  not listed).
- Version constraints that are too loose for the project's context.
- Dependency hygiene: duplicate versions, deprecated packages.

## 5. Error handling

- Failure paths that swallow errors silently (`except: pass`, empty catch,
  ignored return codes).
- Missing failure handling: what happens when a file is missing, a service is
  down, or input is malformed?
- Errors that leak internal details (stack traces to users, paths, secrets).

## 6. Dead code and drift

- Code that nothing references (exports, branches, parameters).
- TODO/FIXME markers — count them, and classify which are stale.
- Documentation that contradicts the code (the code is the source of truth).

## 7. Logic

- Off-by-one, boundary conditions, time/date handling, integer overflow,
  floating-point comparisons.
- Concurrency: shared state, races, non-atomic check-then-act.
- Security-relevant smells: unvalidated input, path traversal, command
  injection, unsafe deserialization.
