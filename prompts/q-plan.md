---
description: Turn a goal into a concise executable plan with dependency order, observable outcomes, and proportionate exit checks.
argument-hint: "<goal>"
---

# Plan

Goal: $ARGUMENTS

Plan only; do not modify files. Restate the observable outcome, split work
only at real dependency or risk boundaries, name affected areas, and give each
phase one proportionate exit check. Include assumptions, blockers, rollback
needs, and the final verification scope. Avoid per-file work packages,
duplicate acceptance tables, or a full-suite gate after every phase unless
the goal itself requires them.

Start with one bounded Plan Contract block:

- `plan_id`, `version`, `candidate`, `status`, and exactly one `next_action`;
- stable criterion objects with `id`, `gate_id`, `check_ids`, and
  `evidence_paths`; never invent a mapping;
- a durable plan path and observed SHA-256 when one already exists, otherwise
  `UNPERSISTED` (do not claim a hash for prose that was not saved and read).

Use only `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, or `EVIDENCED` for the
contract status. List criteria that cannot yet be mapped under a separate
`unmapped_criteria` blocker; `UNMAPPED` is not a Gate id and an unmapped or
unpersisted draft must not be supplied as `plan_ref`. Once the durable plan is
fully mapped, the exact reference may be attached to delegation so its bytes
and mappings are hash-bound. A plan, worker report, test summary, or completion
statement never grants Gate PASS. Final closure must name the current-tree Gate
selector and require fresh authority assessment; historical or truncated
status is `UNKNOWN/RERUN_REQUIRED`, not `never run` or current PASS.
