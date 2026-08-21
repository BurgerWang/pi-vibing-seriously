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

## Development-first execution

- Ordinary source, test, and documentation edits are direct in DEV after
  scope is understood. Delegation is optional; it is not required for a
  write or a defect repair.
- When delegation is useful, use one bounded call. Complete delivery is
  reviewed and closed automatically; explicit review/status is only for
  incomplete coverage, conflict, or recovery. A worker report is never
  acceptance.
- High-risk dependency, security, policy, deployment, migration, and Pi
  control paths require an explicit user-issued temporary write lease.
- Use focused tests during development. Run final gates once on a stable
  candidate when task or release risk requires them.

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
