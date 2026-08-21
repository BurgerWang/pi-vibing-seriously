# AGENTS — pi-dev-workbench generic profile

## Operating contract

- AUDIT is read-only, DEV implements, and VERIFY re-checks a stable candidate.
- In VERIFY, run project commands only through declared workbench recipes.
- Implement complete behavior with tests; never claim a check that did not run.
- Use focused tests while iterating. Run final gates once on a stable candidate
  only when task or release risk requires them; no edit triggers an automatic
  full suite.

## Fixed Sol -> Luna execution

- Sol owns requirements, acceptance criteria, cross-cutting architecture,
  approved paths, review, and the final verdict. Routine source, test, and
  documentation writes in DEV belong to one bounded Luna delegation.
- Use one bounded delegation call for a coherent implementation slice.
  Complete delivery is reviewed and closed automatically; explicit
  review/status is only for incomplete coverage, conflict, or recovery. A
  worker report is never acceptance.
- Sol may edit/write directly only through an active user-issued temporary
  lease bounded by paths, tools, calls, and time. It is an exceptional path
  and never authorizes bash.

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
