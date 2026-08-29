# AGENTS — pi-dev-workbench generic profile

## Operating contract

- AUDIT is read-only, DEV implements, and VERIFY re-checks a stable candidate.
- In VERIFY, run project commands only through declared workbench recipes.
- Implement complete behavior with tests; never claim a check that did not run.
- Use focused tests while iterating. Run final gates once on a stable candidate
  only when task or release risk requires them; no edit triggers an automatic
  full suite.
- For an ordinary replacement where the user supplies the exact path and exact
  old/new text, try one direct `edit` first. If it does not match, inspect and
  retry; do not pre-read only to rediscover the supplied text.

## Development-first execution

- Ordinary source, test, and documentation edits are direct in DEV after
  scope is understood. Delegation is optional; it is not required for a
  write or defect repair.
- When delegation is useful, use one bounded call. Complete delivery is
  reviewed and closed automatically; explicit review/status is only for
  incomplete coverage, conflict, or recovery. A worker report is never
  acceptance.
- Dependency, security/permission/policy, deployment/migration, release, and
  Pi control paths require an explicit user-issued temporary write lease.
  The lease is bounded by paths, tools, calls, and time and never authorizes
  bash.
- After semantic ACCEPT and the relevant final checks, Sol may use
  `workbench_git action=checkpoint` once to batch all compatible sealed
  reviewed paths while preserving unrelated dirty/staged work. Use
  `action=push` only after an explicit user publication request and bind the
  exact current HEAD. Force, ref deletion, and history rewriting are absent.

## Efficient skill routing

Use one primary skill and add at most one specialist when its subject is
actually in scope:

- `skill:implementation-workflow` — ordinary implementation
- `skill:debugging-workflow` — a reproduced failure
- `skill:repository-audit` — read-only audit or review
- `skill:validation-ladder` — formal acceptance, gate, or release verdict

Orientation, CLI, handoff, and research specialists are explicit on-demand
tools, not automatic prerequisites. Read their references only when the
current question needs the extra detail.

## Handoff

Briefly state what changed, what ran, what did not run, and remaining risk.
