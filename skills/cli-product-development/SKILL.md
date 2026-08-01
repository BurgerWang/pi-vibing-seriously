---
name: cli-product-development
description: Build command-line tools and scripts with product quality — predictable interface, disciplined stdout/stderr, exit codes, help text, config, and end-to-end tests. Use when creating or improving any CLI, script, or command-line product.
---

# CLI Product Development

Goal: a command-line tool that behaves predictably, fails informatively, and
is testable — not a script that happens to work once.

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

## Process

1. Contract: subcommands, flags, inputs, outputs, exit codes.
2. Implement the interface first (parse → run → render), then the logic.
3. Test end-to-end: invoke the built binary with arguments; assert stdout,
   stderr, and exit code separately.
4. Verify help text, error paths, and the documented examples.

## Details

- See [references/interface-checklist.md](references/interface-checklist.md)
  for flags, help, config, and stream discipline checklists.
- See [references/cli-testing.md](references/cli-testing.md) for
  end-to-end CLI test patterns.
- Use `skill:implementation-workflow` for the implementation steps and
  `skill:handoff-and-release` when shipping the tool.
