---
name: cli-product-development
description: "Explicit specialist for a user-facing CLI contract: flags, arguments, stdout/stderr, exit codes, help text, configuration, and process-level tests. Use in addition to the primary implementation workflow only when CLI behavior is in scope."
disable-model-invocation: true
---

# CLI Product Development

Goal: make the CLI boundary predictable without repeating the general
implementation workflow.

## Principles

1. **Interface contract** — define flags, arguments, defaults, and exit
   codes before implementing. Document them in `--help`.
2. **Stream discipline** — results/data go to stdout; diagnostics, progress,
   and errors go to stderr. Piping `tool | consumer` must not be polluted by
   log noise.
3. **Exit codes** — `0` success; non-zero failure; distinct codes for
   distinct failure classes (usage error, runtime failure) when the project
   convention allows. Report the code, don't just print.
4. **Errors with context** — every error message names the operation, the
   offending input, and (where useful) the remedy. No bare "failed".
5. **No silent failure** — an unhandled condition is an error with a message
   and non-zero exit, not a quietly empty result.
6. **Determinism** — same input, same output. No hidden dependence on cwd,
   locale, or environment unless documented.

## Conditional references

- Read [references/interface-checklist.md](references/interface-checklist.md)
  only when designing or changing the public interface.
- Read [references/cli-testing.md](references/cli-testing.md) only when the
  project lacks an established CLI test pattern.
