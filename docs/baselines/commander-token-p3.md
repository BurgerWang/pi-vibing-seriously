# Commander Token Optimization — Slice B P3 Comparable-Milestone Benchmark Record

| Field | Value |
| --- | --- |
| Record | P3 comparable-milestone Commander request-count benchmark (machine-derived; six fresh sessions) |
| Plan | `docs/plans/commander-token-optimization.md` (durable contract; Slice B = P2 + P3; P3 exit condition in §6) |
| Recorded | 2026-08-05 |
| Evidence root | `.pi/workbench/runs/commander-token-p3-benchmark/` (project-relative durable workbench run evidence; gitignored; copied byte-for-byte from the former `/tmp/pi-p3-benchmark-evidence/` staging/execution location) |
| Machine-derived analysis artifact | `.pi/workbench/runs/commander-token-p3-benchmark/analysis.json` (schema_version 1); SHA-256 `5cd71bddb3132d7306868c5a5a18bd1aa1aaf4a4ce4a2fefb97ee924beddc221` |
| Persisted analyzer script | `.pi/workbench/runs/commander-token-p3-benchmark/analyze-p3-benchmark.py`; SHA-256 `42f3acc5a9388e683b77675705803b21e4f7c94ad62c890fb7d058e9758f6af6` |
| Frozen P3 rule | **PASS only if current total requests < pre total requests** |
| P3 request-savings verdict | **FAIL** (measured; not BLOCKED, not PASS) |
| Plan status at record time | P2 exit PASS; P3 measured exit FAIL; combined Slice B exit NOT PASS; P4 NOT_STARTED and dependency-blocked by failed P3; P5 blocked by P4; P7 PASS; P6 NOT_SCHEDULED; P8/P9/publication pending; overall final exit PENDING |

This record is the durable evidence for the P3 phase-exit decision of the
Commander Token Optimization plan. It is the machine-derived
comparable-milestone measurement the plan's P3 exit condition (§6) requires,
and it is **not** a worker-prose claim: every decision number below comes
from the machine-derived analysis artifact `analysis.json` (SHA-256 in the
table above), produced by the persisted analyzer script
`analyze-p3-benchmark.py` (SHA-256 in the table above) over the six
persisted Session JSONL files it names, all under the durable
project-relative evidence root
`.pi/workbench/runs/commander-token-p3-benchmark/`. All frozen method,
reconstruction, and verdict facts were fixed by Sol before this record was
written.

---

## 1. Scope and verdict

**Scope.** P3's phase exit condition is: *Commander request count per
comparable milestone measurably reduced vs. P0* (plan §6). The milestone
prompt (`milestone-prompt.txt`) is a fixed read-only repository evidence
milestone; the metric is the per-session `assistant_requests` count, i.e.
the comparable-milestone Commander request count.

**Verdict.** Under the frozen rule **PASS only if current total requests <
pre total requests**, the measurement yields:

- pre cohort total requests: **8** (runs `3, 2, 3`)
- current cohort total requests: **8** (runs `2, 3, 3`)
- `8 < 8` is **false** → **P3 request-savings verdict: FAIL**
- Request reduction ratio: **(8 − 8) / 8 = 0.0** (matches
  `request_reduction_ratio` in analysis.json)

**What the verdict means (unchanged plan status):** the P3 static batching
policy **implementation remains verified** (Slice B1/B2 implementation,
actual-diff review, and check/gates evidence in the plan §13 row 2 are
unchanged and remain PASS at the implementation level), but the **measured
P3 phase exit is FAIL** — not BLOCKED, not PASS. Consequently P2 remains
PASS, the combined Slice B (P2+P3) exit is **NOT PASS**, P4 remains
NOT_STARTED and dependency-blocked by failed P3, P5 remains blocked by P4,
P7 remains PASS, P6 remains NOT_SCHEDULED, P8/P9/publication remain pending,
and the overall final exit remains PENDING. This record claims none of those
statuses; it is the measurement input Sol maps to them.

## 2. Frozen method and controls

- **Six fresh sessions**, run in the frozen **ABBAAB** order:
  `pre-1`, `current-1`, `current-2`, `pre-2`, `pre-3`, `current-3`.
- **Same milestone prompt** in every session
  (`.pi/workbench/runs/commander-token-p3-benchmark/milestone-prompt.txt`):
  one read-only
  repository evidence milestone; collect five specified facts; use only
  `read`, `grep`, `find`, or `ls`; end with exactly five numbered lines,
  each citing its evidence path; final answer within 10 lines.
- **Identical `prompt_sha256`** across all six sessions:
  `01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f` —
  the SHA-256 of the **extracted first user-message text** in each Session
  JSONL (as computed by the persisted analyzer), not a raw
  `milestone-prompt.txt` file-byte hash (§8 step 3).
- **Environment (identical, captured in `environment.txt`):** provider/model
  `openai-codex` / `gpt-5.6-sol`, thinking high, Pi 0.83.0, Node v26.4.0,
  npm 12.0.2.
- **Session hygiene:** fresh session directories (no carryover context),
  normal cache behavior, and **zero compactions** in all six sessions.
- **Metric:** `assistant_requests` per session (the comparable-milestone
  Commander request count).
- **Decision rule (frozen, unchangeable here):** PASS only if current total
  requests < pre total requests. Secondary metrics (tokens, tool
  calls/rounds, tool-result bytes, cost) are **descriptive only** and are
  never the P3 decision metric.

## 3. Snapshot identities (pre-P3 and current at execution)

The benchmark compares two frozen repository snapshots: the reconstructed
pre-P3 state (pre cohort) and the current state at execution (current
cohort). The snapshot treatment is the full difference between these two
frozen snapshots — it includes the Slice B changes **plus later P7 and
documentation changes**, and is not an isolated P3-only A/B (§7). The
per-snapshot whole-diff hashes below are each relative to the shared HEAD;
neither is a pre↔current delta, and the 11 pre-P3 changed paths are **not**
a Slice B treatment diff. These identity facts were frozen by Sol and are
recorded here verbatim.

### 3.1 Pre-P3 snapshot (reconstructed)

| Identity fact | Value |
| --- | --- |
| Reconstruction worktree | `/tmp/pi-p3-pre-rebuild` (per `environment.txt`, captured 2026-08-05T17:45:44+07:00) |
| Git HEAD (shared by both snapshots) | `aa2301763d953d28fa05e06a0080704f3cea20e5` |
| Whole-diff SHA-256 of that worktree relative to the shared HEAD | `1539a7a9c75803c4b99f11e30b507305b7eeab10aa004b247432ef5716bc63d5` |
| Changed paths in that whole diff | 11 |
| Historical full `check` on reconstructed pre-P3 state | PASS 879/879 (`tests 879 / pass 879 / fail 0`) |
| `environment.txt` SHA-256 | `f92261b944be71a14bdb3b2fc26bc791975d1f77469f6c38250c8624dfd8fe48` |
| `p3-pre-reconstruction-check.log` SHA-256 | `655181f20d2924c1b5fddd86b461cd9de1684dad0f73b5ef962b14bcb8ce582f` |

The pre whole-diff hash `1539a7a9…` and its 11 changed paths describe the
pre-P3 worktree's own dirty state relative to the shared HEAD — they are
**not** a pre↔current delta and **not** a Slice B treatment diff.

### 3.2 Current snapshot (at execution)

| Identity fact | Value |
| --- | --- |
| Worktree | `/home/hanbaoji/Projects/pi-vibing-seriously` |
| Git HEAD (same as the pre-P3 snapshot) | `aa2301763d953d28fa05e06a0080704f3cea20e5` |
| Reviewed whole-diff SHA-256 relative to HEAD | `a7c010c07ed012212b588c9e0d1feaba4b521424e59b9939b10beb57174aae1d` |
| Changed paths in that whole diff | 26 |
| Review delegation / outcome | `20260805-170801-8wk1`; review PASS/complete at `2026-08-05T10:10:34.054Z` |
| Snapshot currency | the six benchmark sessions ran after this review while this hash remained current |

The reconstruction check log and environment capture persist at
`.pi/workbench/runs/commander-token-p3-benchmark/p3-pre-reconstruction-check.log`
and `.pi/workbench/runs/commander-token-p3-benchmark/environment.txt`.

## 4. Per-run machine facts (all six runs; nothing excluded)

Runs are listed grouped by cohort, with the frozen ABBAAB execution order
noted in §2. All numbers are the exact values in `analysis.json`.

### 4.1 Requests, activity, and cost

| Run | Cohort | Requests | Tool rounds | Tool calls | Tool-result bytes | Compactions | Cost (USD) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pre-1 | pre | 3 | 2 | 6 | 46,425 | 0 | 0.143791 |
| pre-2 | pre | 2 | 1 | 5 | 5,584 | 0 | 0.066589 |
| pre-3 | pre | 3 | 2 | 6 | 47,090 | 0 | 0.148316 |
| current-1 | current | 2 | 1 | 5 | 45,493 | 0 | 0.112389 |
| current-2 | current | 3 | 2 | 6 | 46,425 | 0 | 0.12233 |
| current-3 | current | 3 | 2 | 10 | 64,666 | 0 | 0.179509 |

### 4.2 Token usage components (descriptive, not the P3 decision metric)

| Run | Input | Output | CacheRead | CacheWrite | Total tokens |
| --- | --- | --- | --- | --- | --- |
| pre-1 | 22,533 | 773 | 15,872 | 0 | 39,178 |
| pre-2 | 8,285 | 762 | 4,608 | 0 | 13,655 |
| pre-3 | 22,886 | 865 | 15,872 | 0 | 39,623 |
| current-1 | 17,283 | 789 | 4,608 | 0 | 22,680 |
| current-2 | 18,140 | 713 | 20,480 | 0 | 39,333 |
| current-3 | 27,557 | 1,058 | 19,968 | 0 | 48,583 |

Gross identity holds per run: total = input + output + cacheRead + cacheWrite.

### 4.3 Hashes and persisted paths (session / stdout)

| Run | Prompt SHA-256 (extracted first user-message text) | Session SHA-256 | stdout SHA-256 |
| --- | --- | --- | --- |
| pre-1 | `01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f` | `08b7467e3945b913d8a7e5f81cb890cc057078ed6b50973f7d4dff4c3f5744ec` | `9976da8ae0cff7af927d910d91da3aafd2fdefef63ffa13954391e7a16744ee1` |
| pre-2 | `01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f` | `a245d51db3a030f69028af82d80ffdfb3870c9ef68c099d43b3d7df2c331a899` | `64a8e409152e35f3ba1a1f25295b50e477cf9bae1039607c9843d0d95ab60c5c` |
| pre-3 | `01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f` | `93aad011fbccd7b60b380f4825c3b4d9ebb753c1fe91da424a17b412b5cd677b` | `72330bdbb9eca35323153e69ea7c692cd503b87bb430f0a892dad3edc5a72d95` |
| current-1 | `01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f` | `a337b1b3b39ed4a95de20da931bd3b19c62aafde9222e8e9254a086aaebf7ae2` | `f45ec8e4f3a78d69b3c23335c44547aea881c4903a1b5bf24f92e215fb1c1b0d` |
| current-2 | `01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f` | `0664d81dec5ff72721cacfdb89c535cf8aaf9a4f4ce0415f9711d57def80399c` | `cba6ce748a0488d19c87c3fee5a8b2012d3d422ce4c1e1480236e61815a9350b` |
| current-3 | `01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f` | `eef8c1f1608bfadc700e359cf2c114cbdaed5e78fbdc703197fd5cf00f1c01ff` | `2c1beb1e84fe97e734525dd3edd29066c29c1b4de8526de4d82d780219e1ee64` |

Persisted paths (the durable project-relative copies of the files
`analysis.json` names; `analysis.json` itself preserves the original
`/tmp/pi-p3-benchmark-evidence/…` path strings from execution):

- Sessions:
  `.pi/workbench/runs/commander-token-p3-benchmark/sessions/<label>/<timestamp>_<uuid>.jsonl`
  for each label —
  `pre-1/2026-08-05T10-54-10-323Z_019fd18f-3193-739d-97ca-4d1b28fd4310.jsonl`,
  `pre-2/2026-08-05T10-56-52-803Z_019fd191-ac43-76fd-962f-9d77cb9d8e42.jsonl`,
  `pre-3/2026-08-05T10-57-23-421Z_019fd192-23dd-7ce3-b719-4b92182f9bf5.jsonl`,
  `current-1/2026-08-05T10-54-57-321Z_019fd18f-e929-7ae7-af88-2d421fb06f5b.jsonl`,
  `current-2/2026-08-05T10-56-15-295Z_019fd191-19bf-7ac8-a552-47c18d0a31e8.jsonl`,
  `current-3/2026-08-05T10-58-07-885Z_019fd192-d18d-724d-ba83-d2144d4cc6b2.jsonl`.
- stdout: `.pi/workbench/runs/commander-token-p3-benchmark/<label>.stdout`
  for each label (`pre-1.stdout` … `pre-3.stdout`, `current-1.stdout` …
  `current-3.stdout`).

## 5. Cohort summary and exact verdict arithmetic

### 5.1 Request cohorts (the P3 decision metric)

| Cohort | Runs | Requests per run | Total | Mean | Median | Min | Max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pre | pre-1, pre-2, pre-3 | 3, 2, 3 | **8** | 2.6666666666666665 | 3 | 2 | 3 |
| current | current-1, current-2, current-3 | 2, 3, 3 | **8** | 2.6666666666666665 | 3 | 2 | 3 |

These are the exact `groups` values in `analysis.json`.

### 5.2 Verdict arithmetic (exact)

```
pre_total     = 3 + 2 + 3 = 8
current_total = 2 + 3 + 3 = 8
rule: PASS only if current_total < pre_total
      8 < 8  →  false  →  FAIL
reduction ratio = (pre_total − current_total) / pre_total = (8 − 8) / 8 = 0.0
```

The ratio 0.0 matches `request_reduction_ratio` and the verdict FAIL matches
`p3_request_verdict` in `analysis.json`.

### 5.3 Secondary descriptive cohort facts (NOT the P3 decision metric)

| Quantity (cohort sums) | pre | current |
| --- | --- | --- |
| Tool calls | 17 | 21 |
| Tool rounds | 5 | 5 |
| Total tokens | 92,456 | 110,596 |
| Tool-result text bytes | 99,099 | 156,584 |
| Cost (USD) | 0.358696 | 0.414228 |

These are reported for completeness and are **descriptive only**; they do
not enter the P3 verdict and no savings or regression claim is made from
them.

## 6. Correctness check

- **Output contract:** all six runs exited 0 and all six final outputs
  satisfy the five-fact/exactly-five-numbered-lines contract — each stdout
  file contains exactly five numbered lines, one fact per line, each citing
  its evidence path. The five fact values are consistent across all six
  runs (package `pi-dev-workbench` v0.9.0 with sorted scripts
  `cache:doctor, cache:report, check, test, typecheck`; first H1
  `Controlled Worker Delegation` with 17 H2 headings; the seven
  `extensions/workbench-runtime/cache` files
  `cache-doctor.ts, cache-report.ts, cache-store.ts, cache-telemetry.ts,
  cache-types.ts, canonical-hash.ts, prompt-fingerprint.ts`; literal
  `WORKER_SPEND_PROFILE_ENV` count 2; gate IDs `b1, b2, b3`).
- **Prompt control:** identical `prompt_sha256` (the SHA-256 of the
  extracted first user-message text in each Session JSONL, §8 step 3)
  across all six sessions (§4.3); identical provider/model and thinking
  setting (§2).
- **Session hygiene:** zero compactions in all six sessions; fresh session
  directories; normal cache behavior.
- **Machine derivation:** `analysis.json` is the machine-derived analysis
  artifact, produced by the persisted analyzer script
  `analyze-p3-benchmark.py` (SHA-256
  `42f3acc5a9388e683b77675705803b21e4f7c94ad62c890fb7d058e9758f6af6`) over
  the six Session JSONL files it names; the analysis artifact SHA-256 is
  `5cd71bddb3132d7306868c5a5a18bd1aa1aaf4a4ce4a2fefb97ee924beddc221`.
- **Reconstruction integrity:** `environment.txt` SHA-256
  `f92261b944be71a14bdb3b2fc26bc791975d1f77469f6c38250c8624dfd8fe48` and
  `p3-pre-reconstruction-check.log` SHA-256
  `655181f20d2924c1b5fddd86b461cd9de1684dad0f73b5ef962b14bcb8ce582f`; the
  check log ends `tests 879 / pass 879 / fail 0`.
- **Arithmetic:** per-run gross token identity (input + output + cacheRead +
  cacheWrite = total) holds for all six runs; cohort totals/means/medians
  and the 0.0 ratio reproduce exactly (§5).

## 7. Limitations

- **Stochastic model behavior:** the same milestone prompt can yield
  different request counts across sessions; a single milestone prompt per
  session is a narrow sample of Commander behavior.
- **Small cohorts:** n = 3 per arm; the verdict arithmetic is exact, but the
  sample has no statistical power and the result does not generalize.
- **Snapshot-level treatment with confounds:** the treatment is the full
  difference between the two frozen repository snapshots (§3): the
  reconstructed pre-P3 state (11 changed paths relative to the shared HEAD)
  vs. the current state (26 changed paths relative to the same HEAD). It
  includes the Slice B changes **plus later P7 and documentation changes**,
  so it is **not** an isolated P3-only A/B; the benchmark does not causally
  attribute the measured outcome to any specific change, not even to Slice
  B as a whole.
- **current-3 retained:** current-3's observed extra reads/tool calls (10
  tool calls, 64,666 tool-result bytes) are **retained rather than
  excluded**; no run is cherry-picked out, so the record reports the
  realized distribution, not a best case.
- **Secondary metrics are descriptive:** tokens, tool calls/rounds,
  tool-result bytes, and cost are reported for completeness only and are
  not the P3 decision metric.
- **Environment-specific:** measurements were taken on Pi 0.83.0 / Node
  v26.4.0 / npm 12.0.2; re-measurement on different versions is not
  directly comparable.

## 8. Re-derivation instructions

The durable external artifacts under
`.pi/workbench/runs/commander-token-p3-benchmark/` are the source of truth;
this record must reproduce from them:

1. **Read the machine record:** open `analysis.json`; verify
   `p3_rule` ("PASS only if current total requests < pre total requests"),
   `request_reduction_ratio` (0.0), `p3_request_verdict` ("FAIL"), and the
   `groups` aggregates. `sha256sum analysis.json` must equal
   `5cd71bddb3132d7306868c5a5a18bd1aa1aaf4a4ce4a2fefb97ee924beddc221` and
   `sha256sum analyze-p3-benchmark.py` must equal
   `42f3acc5a9388e683b77675705803b21e4f7c94ad62c890fb7d058e9758f6af6`.
2. **Recompute the cohorts** from the per-run `assistant_requests` values:
   pre `[3, 2, 3]` → total 8, mean 2.6666666666666665, median 3, min 2,
   max 3; current `[2, 3, 3]` → total 8, mean 2.6666666666666665, median 3,
   min 2, max 3; ratio `(8 − 8) / 8 = 0.0`.
3. **Verify hashes:** `sha256sum` the six stdout files and the six Session
   JSONL files, resolving the `/tmp/pi-p3-benchmark-evidence/…` path
   strings named by `analysis.json` to their persisted project-relative
   copies under `.pi/workbench/runs/commander-token-p3-benchmark/`, and
   compare against §4.3; `sha256sum environment.txt` and
   `p3-pre-reconstruction-check.log` and compare against §3. **Prompt
   hash:** `prompt_sha256` is **not** the raw `milestone-prompt.txt`
   file-byte hash; it is the SHA-256 of the extracted first user-message
   text in each Session JSONL (the concatenated text parts of the first
   user message, as computed by the persisted analyzer). Re-derive it with
   the persisted analyzer/session data (step 7); do not equate it to a
   `sha256sum milestone-prompt.txt` result unless separately measured.
4. **Verify the output contract:** each stdout file must contain exactly
   five numbered lines, one fact per line, each citing its evidence path
   (observed: satisfied for all six).
5. **Verify reconstruction:** confirm the reconstructed pre-P3 state
   (`environment.txt`: HEAD `aa2301763d95…`, reconstruction root
   `/tmp/pi-p3-pre-rebuild`) passes the historical full `check` 879/879 as
   recorded in `p3-pre-reconstruction-check.log`.
6. **Apply the frozen rule** to the recomputed totals; the verdict must
   reproduce FAIL (8 < 8 is false).
7. **Analyzer reproduction:** the persisted analyzer script
   `analyze-p3-benchmark.py` (SHA-256
   `42f3acc5a9388e683b77675705803b21e4f7c94ad62c890fb7d058e9758f6af6`)
   hardcodes the original `/tmp/pi-p3-benchmark-evidence` staging root. To
   re-run it after the staging location is gone: copy the durable evidence
   directory byte-for-byte back to that exact `/tmp/pi-p3-benchmark-evidence`
   location, run the unmodified script over the same six Session JSONLs,
   and compare the generated `analysis.json` SHA-256 to
   `5cd71bddb3132d7306868c5a5a18bd1aa1aaf4a4ce4a2fefb97ee924beddc221`. Do
   not modify the frozen analyzer.

## 9. Explicit non-claims

- **No §10.2 ≥25% commander-calls target claim:** the measured reduction is
  0.0; the plan's aspirational targets are measured-or-not at P9 only, and
  this record claims none of them.
- **No total-token savings claim:** token totals are descriptive only
  (pre 92,456 vs current 110,596); no savings or regression claim is made
  from them, and they are not the P3 decision metric.
- **No causality claim:** the treatment is the full snapshot difference
  (§3, §7) — Slice B changes plus later P7 and documentation changes — and
  this benchmark does not causally attribute the measured outcome to any
  specific change, not even to Slice B as a whole.
- **No milestone-prompt file-byte hash claim:** `prompt_sha256` hashes the
  extracted first user-message text in each Session JSONL; it was not
  measured against the raw `milestone-prompt.txt` file bytes, and this
  record does not equate the two.
- **No P3 PASS and no Slice B exit claim:** the P3 request-savings verdict
  is FAIL; combined Slice B (P2+P3) is not PASS. The verified static
  batching *implementation* is distinct from the failed measured *phase
  exit*; the former does not imply the latter.
- **No overall optimization/release success claim:** the overall final exit
  remains PENDING; P8, P9, and publication remain pending.
- **No run selection:** all six runs are reported; no run is chosen as
  "best" and none is excluded.
- **No redefinition of the frozen rule:** the PASS-only-if-strictly-less
  rule is applied as frozen; this record does not soften or reinterpret it.
