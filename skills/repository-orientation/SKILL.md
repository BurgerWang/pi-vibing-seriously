---
name: repository-orientation
description: Explicit orientation module for a genuinely unfamiliar repository. Map git state, entry points, dependencies, tests, configuration, and layout once; do not repeat it for an already-known area.
disable-model-invocation: true
---

# Repository Orientation

Goal: build the smallest factual map needed to begin work safely.

## Steps

1. **Git state** — branch, recent commits, dirty/untracked files.
2. **Entry points** — how the project is built and run (manifest files,
   main modules, scripts).
3. **Dependencies** — runtime and dev dependency groups; install/build
   commands.
4. **Tests** — test runner, how to run a single test, existing test layout.
5. **Configuration** — build config, linters, formatters, CI workflow files.
6. **Layout** — top-level directory structure and module boundaries.

## Rules

- Stop once the task-relevant map is sufficient; do not inventory the whole
  repository by default.
- Cite paths and summarize observed command results accurately.
- This is a read-only orientation: no edits, no mutation.
- Reuse current-session knowledge unless the repository state has changed.

## Conditional references

- Read [references/orientation-checklist.md](references/orientation-checklist.md)
  only when entry points or tooling remain unclear.
- Read [references/git-state.md](references/git-state.md) only for a mixed or
  risky worktree.
