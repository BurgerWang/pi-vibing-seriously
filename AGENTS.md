# AGENTS — pi-dev-workbench generic profile

Guidance for AI agents working in this repository.

## Mode discipline

- The project runs under the workbench mode policy: AUDIT (read-only),
  DEV (implement), VERIFY (re-verify only).
- Project commands run through declared workbench recipes
  (`.pi/workbench/recipes.yaml`) — never improvise shell commands in VERIFY.

## Working style

1. **Orient first.** Before touching code, map the repository: entry points,
   dependencies, test runner, configuration, and git state. Record file paths
   as evidence.
2. **Contract before code.** Restate the task as acceptance criteria and list
   the files you will change before editing.
3. **Real implementation.** No stubs, no TODO shells, no placeholder commits.
   A change is not done until its tests pass.
4. **Tests travel with code.** Add or update tests for every behavior change
   and run them.
5. **Verify, then report.** Run the project's declared verification recipes
   (typecheck, tests, build). Report exact commands, results, and remaining
   risks. Never claim a check passed that did not run.
6. **Evidence over assertion.** Cite file paths, line numbers, and command
   output. If you cannot verify something, say so.

## Worker-first write authority

This project operates under the worker-first workflow contract:

1. **Sol owns the decision.** Sol owns requirements,
   cross-cutting architecture, scope, and acceptance criteria.
2. **Routine writes are worker-owned by default.** Concrete source, tests,
   docs, and config writes are routine worker slices: a fresh bounded worker
   implements them inside the approved contract; the worker owns routine
   local implementation decisions.
3. **High-risk decisions remain Sol-owned; the concrete writes are bounded
   worker slices.** Sol keeps the decision itself and delegates only bounded
   implementation scopes after the architecture is fixed.
4. **Defects go to a fresh worker.** A partial or defective slice is
   repaired by a new bounded delegation to a fresh worker, not by Sol
   directly repairing the files.
5. **The only exception is a user-issued temporary write lease.** Only an
   active human-issued lease (user-only slash commands) lets Sol write
   directly; it is bounded in calls, time, and project-relative paths.
6. **Worker reports are never acceptance.** A report records commands and
   observed results; it can never mark an acceptance criterion satisfied —
   only Sol maps evidence to criteria.
7. **Sol reviews the actual diff and runs the final gates.** Sol inspects
   the real diff (`workbench_review_worker_diff`) and runs the final
   verification recipes and gates before any verdict.

## Skills

- `skill:repository-orientation` — start of work in an unexplored repository
- `skill:implementation-workflow` — any implementation task
- `skill:debugging-workflow` — any failure or unexpected behavior
- `skill:validation-ladder` — any verification or review verdict
- `skill:repository-audit` — systematic read-only review of code or repository
- `skill:cli-product-development` — command-line tools and scripts
- `skill:handoff-and-release` — handoff notes, changelog, release prep

## Handoff

Before handing off work: summarize what changed, how to verify it, what was
deliberately not done, and known limitations.
