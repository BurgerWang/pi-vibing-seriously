---
description: Perform a bounded read-only repository audit and report evidence-backed findings without changing files.
argument-hint: "[scope]"
---

# Audit

Scope: $ARGUMENTS — or the repository when no scope is supplied.

Use `skill:repository-audit`. Stay read-only. Report confirmed findings first,
then probable or unknown items with the missing evidence named. For each
material finding give severity, exact path/line or command evidence, impact,
and the smallest corrective direction. State what was and was not inspected;
do not manufacture a full-repository audit when the requested scope is
bounded.
