# Pi development-throughput exit comparison v2

This is the post-remediation Stage 2 exit comparison against
`pi-development-throughput-v1.json`. It uses fresh synthetic Git repositories,
the current Workbench runtime, three ordinary one-file samples, one cross-file
sample, and one read-only status sample. It is development evidence only: it is
not a Gate, release, production, research-acceptance, or profitability
authority.

## Result

**Overall throughput verdict: PASS.** Ordinary DEV now edits canonical project
paths directly, while dependency, security/permission/policy,
deployment/migration, release, and `.pi` control paths still require an
explicit bounded user lease. Bash and foreign tools remain blocked, and
Candidate/Gate/receipt/repair contracts are unchanged.

| Metric | S2.0 baseline | Post-remediation observation | Target | Verdict |
| --- | ---: | ---: | ---: | --- |
| User-authored lifecycle directives | 3 | 0 | 0 | PASS |
| Ordinary first effective write | 9.919 s | 3.707 s median | at most 4.960 s | PASS |
| Ordinary authority-only persistence | 12 files / 24,022 B | 0 files / 0 B | at least 80% lower | PASS |
| Cross-file complete persistence | 21 files / 60,424 B | 1 file / 11,528 B | at most 4 files / 12,084 B | PASS |
| Read-only status receipt files | 2 | 0 | 0 | PASS |
| Unchanged Candidate duplicate full checks | not duplicated | 0 | 0 | PASS |
| Repeated worker orientation | worker process required | 0 worker calls / 0 worker tokens | at least 50% lower | PASS |
| `index.ts` physical lines | 6,263 | 1,994 | 1,500–2,000 | PASS |

The ordinary first-write samples were 3.707 s, 4.037 s, and 2.947 s.
Each made exactly one native `edit`, created no delegation, receipt, run, or
authority record, and changed only its synthetic target. Median first-write
fell 62.6% and median wall time fell 86.9%.

The first direct-write probe, before the exact-edit instruction was added,
still performed a read before edit and measured 5.658 s median (42.9% lower),
missing the frozen first-write target. Generated project instructions now say
that an exact ordinary path plus exact old/new text should receive one direct
edit attempt first; a mismatch falls back to inspection. The new three-sample
set is the post-remediation result above. This removes one redundant model
round trip without weakening path containment or high-risk authorization.

The cross-file sample changed exactly its two requested files. The only new
Workbench file was cache telemetry: 1 file / 11,528 B. Compared with 21 files /
60,424 B, this is a 95.2% file reduction and 80.9% byte reduction. The
read-only status sample likewise created no receipt, delegation, or business
delta; its fresh fixture created one 3,828 B cache telemetry file.

## Measurement boundary

- First-write time is the first target-file mtime minus the parent user-message
  timestamp in the saved Pi session.
- Complete persistence counts every new file and byte below
  `.pi/workbench`, excluding the pre-existing `project.yaml`.
- Authority-only persistence counts the immutable delegation tree. Direct
  ordinary edits created no such tree.
- Repeated-orientation evidence is structural: no worker process or delegation
  call existed, worker tokens were zero, and the exact-edit samples made no
  pre-edit read. Parent request-token aggregates are recorded in the machine
  report and are not presented as total-token savings.
- Raw sessions remain transient and are not committed. The machine report
  stores only SHA-256 identities, aggregate timings, counts, and tool names,
  without prompts, file contents, secrets, or user data.
- Provider latency is variable; the frozen first-write exit is evaluated on the
  specified three-sample median. The edit-first fast path applies only when
  path and old/new text are exact.

## Remaining boundary

The throughput exit passing does not make the whole execution plan complete.
Mace still has no Candidate because its complete validation run failed;
Onchain's Candidate-bound Gate failed for missing standard recipe evidence; and
Scalper's exact repair successor failed its contract check. No release, push,
publish, production, research-acceptance, or profitability authority was
granted.

Machine-readable evidence is in
`pi-development-throughput-exit-v1.json`.
