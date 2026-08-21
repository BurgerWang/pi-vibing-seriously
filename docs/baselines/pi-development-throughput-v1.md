# Pi development-throughput baseline v1

This is a lightweight Stage 2 baseline, not another governance subsystem. The
machine-readable values live in `pi-development-throughput-v1.json`; they reuse
existing real-Pi output, v2 transactions, Git facts and cache telemetry. No new
telemetry schema, event store or authority was introduced.

## What the baseline says

| Scenario | Explicit lifecycle choreography | First effective write | Total time | Durable governance output | Result |
|---|---:|---:|---:|---:|---|
| ordinary small change | 3 calls | 9.919 s | 28.233 s | at least 12 files / 24,022 B | reviewed PASS |
| cross-file feature | 3 calls | 9.587 s | 26.362 s | 21 files / 60,424 B | reviewed PASS |
| concurrent high-risk change | 2 calls | 9.008 s | 21.262 s | at least 11 files / 16,759 B | fail-closed conflict |
| read-only status | 1 call | n/a | 2.888 s | 2 new receipt files and 5,185 B total append/write | read succeeded |

The most important findings are product problems, not reporting problems:

1. A normal task still exposes `delegate -> review -> status` choreography.
2. A two-file change creates 21 governance files before counting the external
   Pi session file.
3. A read-only status query still creates a started/finalized receipt pair and
   appends cache telemetry.
4. `index.ts` is 6,263 lines and still owns too much lifecycle wiring.
5. The first cross-file attempt also exposed a real parallel-edit defect: the
   second edit poisoned the serial journal. The runtime now rejects only the
   parallel call, asks the worker to retry sequentially, and preserves the
   first operation. The fresh real-Pi replay completed both files and review.

## Measurement boundary

- Times start at the parent user message. First-write time ends at the first
  successful worker-path mtime. Total time ends at the final parent answer.
- Read bytes are only bytes explicitly counted or reconstructable from the v2
  journal, ChangeSet and relevance projection. Git subprocess internals are not
  guessed.
- Historical scenarios lack receipt/cache copies, so their persistence totals
  are deliberately labeled lower bounds. The current cross-file and read-only
  scenarios include those records.
- Prompts, file contents, secrets and user data are excluded. Only synthetic
  scenario labels, counts, timings, enums and hashes are recorded.
- Replays bind Node 26.7.0, Pi 0.84.2, the parent/worker model identities, HEAD,
  package lock, recipes and relevant runtime source hashes recorded in JSON.

## Exit comparisons

Stage 2 should reach these observable outcomes without building another
measurement platform:

- ordinary tasks require zero explicit workbench lifecycle directives;
- the same unchanged candidate is never fully validated twice;
- read-only workflows create zero receipt files;
- ordinary first-write delay is at most 4.960 s (50% below this baseline);
- cross-file governance persistence is at most 4 files and 12,084 B (80% below
  the current complete observation);
- repeated orientation bytes or tokens fall by at least 50%; and
- `index.ts` reaches 1,500-2,000 lines and contains wiring rather than business
  state machines.

If a future comparison cannot observe a metric from existing records, it must
use a documented direct proxy or leave it unavailable. It must not create a
new platform merely to make the chart complete.
