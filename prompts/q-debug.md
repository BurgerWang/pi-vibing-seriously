---
description: Reproduce a failure, isolate its mechanism, repair the root cause, and run proportionate regression checks.
argument-hint: "<failure-description>"
---

# Debug

Failure: $ARGUMENTS

Use `skill:debugging-workflow`. Preserve the exact failing command and the
relevant original error once, reduce it to the smallest useful reproduction,
identify the verified mechanism, repair it without weakening the detecting
check, and rerun the reproduction plus affected tests. Add a regression test
when needed.

Run a full suite only for cross-cutting risk, a declared final gate/release,
or an explicit request. If reproduction is impossible, report the evidence
and missing prerequisite instead of guessing.
