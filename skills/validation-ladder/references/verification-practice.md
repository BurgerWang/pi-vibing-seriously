# Verification practice

## Verifying completed work

1. List the claims to verify (from the work report or the task).
2. Map each claim to a concrete check: a declared recipe, a read-only
   command, or a file inspection.
3. Run each check; record the verdict + evidence per claim.
4. When a check needs a mutating step (e.g. a build that writes artifacts),
   use the declared recipe rather than improvising — and in VERIFY mode that
   is the only option.

## Using the workbench

- Prefer `workbench_run_recipe` / `/q-run` for project commands; they leave
  run records you can cite as evidence.
- `workbench_read_run` gives you bounded logs to confirm what a recipe
  actually did.
- `workbench_project_inspect` shows the declared recipes — if a needed check
  has no recipe, mark the check BLOCKED (missing declaration) rather than
  improvising a shell command in VERIFY mode.

## Final report

```text
Claims verified : <list with verdict per claim>
Evidence        : <commands + outputs, or file paths + excerpts>
Blocked         : <prerequisites that would unblock>
Not run         : <checks deliberately skipped>
```
