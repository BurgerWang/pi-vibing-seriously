# Root cause analysis

## Symptom vs root cause

| Symptom | Root cause |
| ------- | ---------- |
| "the program crashes on empty input" | "the parser assumes at least one row and indexes [0]" |
| "the API returns 500 sometimes" | "the cache write is not atomic; two requests race" |
| "tests pass locally, fail in CI" | "CI runs with a different locale/timezone/locale ordering" |

A root cause statement is testable: "if I change Y, the symptom disappears
and no other behavior changes". If you cannot write that sentence, you have
not found the root cause yet.

## Common root-cause patterns

- **Ordering assumptions** — iteration order, sort stability, timezone
  handling, locale-dependent formatting.
- **State leaks** — shared mutable state across calls, cached values never
  invalidated, global counters.
- **Boundary conditions** — empty, single-element, maximum, and off-by-one
  inputs.
- **Resource handling** — unclosed handles, unbounded growth, use-after-free
  patterns in any language.
- **Error swallowing** — the failing path is caught and ignored, so the
  program continues in a corrupted state.
- **Data assumptions** — code that assumes a format/scale/schema the actual
  data does not have.

## Validation of the fix

- Before fixing, write (or run) a test that fails with the current code and
  passes with the fix — that test is the regression guard.
- Verify the fix against the minimal repro and the original full repro.
