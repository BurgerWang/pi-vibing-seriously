---
name: repository-orientation
description: Orient in a repository before touching code — identify language, entry points, dependencies, tests, configuration, and git state, with file paths as evidence. Use at the start of work in a project you have not explored in this session.
---

# Repository Orientation

Goal: build a factual map of the repo, backed by observed evidence, before
making changes. Never claim a fact you have not observed directly; if
something cannot be determined, say so instead of guessing.

## Steps

1. **Git state** — branch, recent commits, dirty/untracked files.
2. **Entry points** — how the project is built and run (manifest files,
   main modules, scripts).
3. **Dependencies** — runtime and dev dependency groups; install/build
   commands.
4. **Tests** — test runner, how to run a single test, existing test layout.
5. **Configuration** — build config, linters, formatters, CI workflow files.
6. **Layout** — top-level directory structure and module boundaries.

## Output

A short bullet report with explicit file paths: one line per fact, each
citing the file or command it came from. End with an explicit "not
determined" list for anything you could not verify.

## Evidence rules

- Cite file paths and exact command output; do not paraphrase results.
- Prefer the project's own declared recipes for build/test commands
  (`.pi/workbench/recipes.yaml`) when present.
- This is a read-only orientation: no edits, no mutation.

## Details

- See [references/orientation-checklist.md](references/orientation-checklist.md)
  for the per-ecosystem checklist (manifests, runners, config files).
- See [references/git-state.md](references/git-state.md) for the git
  investigation steps and how to report dirty state safely.
