# Governance recovery and rollback

This is an operational recovery guide, not a normal development workflow.
Use it only after an interrupted/corrupt authority lifecycle or before rolling
back to code that understands only v1 records. The checks below are read-only:
they do not create evidence, rewrite history, quarantine files, or delete data.

## Diagnose first

Stop new delegation, recipe, and gate writes, then run the pre-deploy check
from the version currently installed:

```bash
npm run governance:rollback-check -- --project /absolute/project/root --json
```

Exit `0` means the bounded inventory contains only readable v1 delegation and
run records. Exit `1` means rollback to v1-only code is blocked. Exit `2` means
the command line was invalid. The report contains counts plus at most 32
project-local ids; it never includes record contents or absolute paths.

The blocker codes have deliberately narrow meanings:

- `V2_DELEGATION_AUTHORITY_PRESENT`: at least one delegation has a `v2`
  authority subtree. A v1-only reader would incorrectly see no delegation.
- `V2_RUN_AUTHORITY_PRESENT`: at least one run has a v2 manifest or commit /
  artifact marker. New manifests use top-level `schema_version: 2`, so a
  frozen v1 reader cannot mistake them for v1 SUCCESS.
- `UNCLASSIFIED_*_AUTHORITY`: a partial, corrupt, mixed, unsafe, or unknown
  record cannot be proved to be legacy v1.
- `INVENTORY_UNAVAILABLE` / `INVENTORY_LIMIT_EXCEEDED`: the bounded inventory
  could not complete. Absence of evidence is never treated as safe rollback.

For a live Pi session on the current version, run `/q-delegation-status`.
That command explicitly reconciles the session mirror from strict project v2
authority before reporting. A corrupt, unsupported, pending, or unavailable
v2 record never falls back to v1. Run and artifact details can be inspected
with the existing read tools; inspection itself must not write receipts or
change authority.

Current v2 records also carry `execution-owner.json` across PREPARED/RUNNING.
On restart, Pi automatically and atomically marks a provably dead transaction
`ABORTED` only when its write journal is absent before launch or exactly empty
OPEN revision 0 and the v2 directory contains no other execution artifacts.
For historical ownerless records, both transaction and journal mtimes plus the
transaction time must predate the current OS boot. Status then reports the
terminal abort and tells the caller to start a fresh delegation; review is not
required. Any write operation/meter, generation, review, lock, temporary file,
COMMITTING state, live/unknown owner, or invalid evidence keeps recovery
blocked for manual diagnosis.

## Explicit reconcile

Reconciliation never edits an immutable generation or historical run:

1. Keep the current v2-capable version installed and stop new writes.
2. Restart Pi so session state is reconstructed from project authority.
3. Run `/q-delegation-status`; require a fresh, non-INVALID result.
4. If the latest transaction is incomplete, repair the storage/availability
   cause, then repeat the status reconciliation. Do not fabricate a terminal
   marker or copy session state over project authority.
5. For a failed/partial run, rerun the declared recipe to create a new run id.
   Never patch the old manifest, artifact inventory, or commit marker.
6. Rerun the rollback check. A v1-only rollback remains blocked while any v2
   or unclassified authority exists. A rollback to an earlier v2-aware wiring
   version is allowed only if its strict readers accept the current formats.

There is intentionally no automatic migration, quarantine, cleanup, or
in-place upgrade command. Historical v1 remains read-only; v2 remains in
place even if its wiring is disabled.

## Stop conditions

Stop recovery and preserve the current files when any of these is true:

- the rollback report is not `safe_for_v1_rollback: true`;
- project authority is INVALID, has an unknown schema, or cannot be read;
- a run/delegation identity, commit inventory, review hash, or contract hash
  does not match;
- a transaction is `COMMITTING`, `RECOVERY_REQUIRED`, or otherwise lacks the
  exact terminal proof required by its state; a `PREPARED`/`RUNNING` record is
  also a stop unless current startup reconciliation has already proved the
  owner dead, proved the journal/inventory pristine, and durably changed it to
  `ABORTED`;
- the workspace changes during diagnosis/reconciliation;
- storage is full, unavailable, unexpectedly symlinked, or exceeds a bounded
  inventory/record limit;
- the proposed action would delete, rename, or rewrite historical authority.

After a stop, copy the affected project directory for offline investigation
if required, without altering the original. Resume only after the cause is
understood and the same read-only checks complete cleanly.
