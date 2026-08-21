# AGENTS — pi-dev-workbench repository workflow

Guidance for Codex and other development agents working in this repository.

## Hard product/development boundary

- `.pi/workbench` modes, recipes, delegation, ledgers, gates, receipts, and
  state files are Pi runtime/product behavior under test. They do not
  orchestrate Codex's own repository-development workflow.
- Do not use Pi workbench modes, recipes, delegation tools, ledgers, review
  state, or gates to manage Codex development unless the user explicitly
  requests a real Pi product feature or end-to-end test.
- Codex may inspect and edit in-scope repository files directly, using
  `apply_patch` for edits, and may run normal focused package/test commands.
- Subagents are optional. No write or defect requires a fresh worker,
  temporary write lease, workbench delegation, or workbench diff review.
- This exemption applies only to external repository-maintenance agents such
  as Codex. When this checkout is loaded as the Pi product, its generated
  project AGENTS files and runtime enforce the fixed Sol commander -> Luna
  worker delivery model; do not reinterpret that product behavior as
  optional because repository maintenance is direct.

## Normal development workflow

1. **Orient first.** Inspect relevant entry points, dependencies, tests,
   configuration, git state, and any applicable repository instructions.
2. **Set the contract.** State the intended behavior, acceptance conditions,
   and expected file scope before editing when the task is non-trivial.
3. **Implement completely.** Make the smallest coherent change that solves
   the task. Do not leave stubs, TODO shells, or placeholder implementations.
4. **Keep tests with behavior.** Add or update tests for behavior changes and
   run the affected focused checks during development.
5. **Verify proportionately.** Once the candidate is stable, run the relevant
   final typecheck, tests, build, or `check` command in proportion to risk.
   Report exactly what ran; never claim an unrun check passed.
6. **Use evidence honestly.** Review the actual diff and command output.
   Distinguish development feedback from formal Pi product-test authority.

## Repository safety and handoff

- Preserve unrelated dirty-worktree changes and avoid broad staging or
  cleanup that could overwrite user work.
- Do not commit, push, publish, release, or create a PR unless the user asks.
- Before handoff, summarize what changed, how it was verified, what was not
  done, and any remaining risk or limitation.
