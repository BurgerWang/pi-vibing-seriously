# Commander Native Tool Optimization — NRO Final Benchmark and Verdict Record (N4)

| Field | Value |
| --- | --- |
| Record | NRO-N4 final benchmark + Commander verdict (immutable NRO FINAL result record; written by the N5 worker documentation-recording slice) |
| Plan | `docs/plans/commander-native-tool-optimization.md` (durable contract; NRO protocol in §10, adoption criteria in §11, slices in §12) |
| Protocol | `docs/baselines/commander-native-tool-benchmark-protocol.md` (frozen method; this record is its executed N4 result) |
| Effort | **NRO — "Native read/grep/find Override"** — an independent NRO effort, **not** P9/P3 and not a phase of the Commander Token Optimization plan; it reuses no P9/P3 artifact, manifest, session, constant, or denominator |
| Recorded | 2026-08-07 (N4 collection, prepare, analyzer, and verdict date) |
| Collection run | `20260807-090523-7lpr` — recipe `commander-native-tool-final-collect`, exit 0; collector summary `status=complete valid=40 attempts=40` |
| Prepare run | `20260807-095318-gxbb` — recipe `commander-native-tool-benchmark-prepare`, exit 0; evidence committed (fixture + 4 frozen inputs + 40 sessions + 0 attempts, byte-exact copies) |
| Analyzer run | `20260807-095326-way4` — recipe `commander-native-tool-benchmark`, exit 0; full JSON report at `.pi/workbench/runs/20260807-095326-way4/stdout.log` |
| Manifest | `.pi/workbench/runs/commander-native-tool-benchmark-manifest.json` (schema_version 1, phase `final`, 40 sessions, 0 attempts) |
| Evidence root | `.pi/workbench/runs/commander-native-tool-benchmark/` (gitignored; fixture + frozen inputs + byte-exact session copies + `collection-deviations.json`) |
| Sol verdict | **FAIL / DO NOT ADOPT** under plan §11.1, despite all four §11.2 thresholds reporting ACHIEVED (see §7; §11.2 thresholds are adoption criteria, not release gates, and cannot override §11.1) |
| Status | **NOT ADOPTED** — N2b and N3 remain NOT_RUN; post-N5 Commander no-cache `check` and b0–b6 gates were **pending at record-write time** (see §9) |

This record is the immutable NRO FINAL result record for the N4 measurement.
Every numeric value in §§2–6 is the machine-derived analyzer JSON of run
`20260807-095326-way4` over the strict manifest and its declared session
files (and the persisted collection/prepare run records), with no rounding
that changes meaning. Facts are labeled by source throughout: **machine
facts** (persisted analyzer/collector/prepare output), **Commander manual
audit** (raw-file audit performed by Sol at N4), and the **Commander
verdict**. This is evidence recording, not worker acceptance: worker prose
here is not acceptance evidence, no final gate was run by a worker, and
nothing in this document claims a PASS.

---

## 1. Scope and verdict

**Scope.** N4 measured the NRO treatment (the N1 `read` preview override and
the N2 `grep` count mode, on the same current runtime source) against the
final control arm (the same runtime through the dedicated final-control
adapter, with the Pi built-in `read`/`grep`/`find` in effect) on the frozen
20+20 ABBA×10 final validation cohort, ran the offline `prepare` and
analyzer, audited correctness and pagination/misuse against the frozen
rubric, and issued the Sol verdict against plan §11.

**Verdict (Sol-owned, recorded here):**

- **FAIL / DO NOT ADOPT** under plan §11.1, even though all four §11.2
  efficiency thresholds report **ACHIEVED** (§5). The two release blockers
  (§7) are: (1) the treatment-arm correctness rubric is not 20/20 —
  `treatment-07` failed the frozen exact `unicode` regex check; and (2) the
  analyzer-verified no-hidden-truncation/misuse condition is not clean —
  `treatment-18` and `treatment-19` carry frozen machine misuse signs
  (unpaginated obligation reads) under protocol §8.5 FIFO attribution.
- §11.2 thresholds are **adoption criteria, not release gates** (protocol
  §13); their ACHIEVED statuses do not override the §11.1 verdict.
- **No post-hoc protocol change was made or is permitted**: no
  recollection, no denominator/run dropping, no threshold/statistic
  change, no waiver of the frozen rubric. The aspirational milestones
  (§5.1) are reported separately and are not NRO release gates.
- **No commit/publish/tag/release action occurred.** N2b (staged `grep
  output: "files"`) and N3 (find count/max_depth) remain **NOT_RUN**.

---

## 2. Collection integrity (machine facts)

Facts from the persisted collector run record (`20260807-090523-7lpr`,
exit 0) and the strict collection record
(`.pi/workbench/runs/commander-native-tool-final-collection/collection-record.json`):

- **Collector summary:** `status=complete valid=40 attempts=40` — exactly
  **40 paid provider/model processes** were started and **every one** was a
  valid final session; there were **0 invalid attempts** (no attempt
  entries exist in the strict record: 40 `kind: "session"` entries, 0
  `kind: "attempt"` entries, `phase: "final"`, `schema_version` 1).
- **Cohort:** fixed **ABBA×10** interleave over positions 1..40 — 20
  control + 20 treatment sessions (`control-01..control-20`,
  `treatment-01..treatment-20`); 40 source JSONLs
  (`sources/raw-01-control.jsonl` .. `raw-40-control.jsonl`), no dropped
  runs, all attempts retained (none existed to retain beyond the 40
  sessions).
- **Prepare commit (`20260807-095318-gxbb`, exit 0):** evidence committed
  byte-exact under `.pi/workbench/runs/commander-native-tool-benchmark/`
  (fixture + the four frozen inputs + 40 sessions + 0 attempts), strict
  manifest at
  `.pi/workbench/runs/commander-native-tool-benchmark-manifest.json`
  (schema 1, phase `final`, 40 sessions, 0 attempts; paths relative to the
  runs root).
- **Manifest phase final, schema 1, all four frozen pins match** (prepare
  and analyzer both enforced): `milestone_prompt_sha256`
  `1af10ebb…608a40`, `fixture.manifest_sha256` `062b3c92…c216b6`
  (fixture re-verified by the analyzer: 11 files, 133,440 bytes),
  `rubric_sha256` `dccfd406…ab74ed` (6 checks), `non_treatment_sha256`
  `7cbb5452…d28738`; every session `promptMatches: true` and
  `sessionSha256` matches its declared `expected_session_sha256`.
- **Environment (manifest, pinned):** `openai-codex/gpt-5.6-sol`, thinking
  `high`, Pi `0.83.0`, Node `v26.4.0`; every final session recorded
  `modelKeys: ["openai-codex/gpt-5.6-sol"]` and `thinkingLevel: "high"`.
- **Terminal facts:** all 40 runs `terminalStop: true`, `aborted: false`,
  `errored: false`, `compactionCount: 0` — **zero compactions across the
  cohort**; analyzer `attempts: []` (0 invalid-attempt entries).

---

## 3. Arm metrics (machine facts, analyzer JSON)

Exact values from `.pi/workbench/runs/20260807-095326-way4/stdout.log`
(`arms` block). Medians are the frozen middle-two means (n = 20 per arm);
gross p90 is the nearest-rank 18th smallest of 20 (protocol §10); gross =
input + output + cacheRead + cacheWrite.

| Metric | Control (n = 20) | Treatment (n = 20) |
| --- | --- | --- |
| Requests median | 11.5 | 7 |
| Gross tokens median | 188071 | 46172 |
| Successful inline bytes median | 187301 | 23320 |
| Gross p90 | 265735 | 55342 |
| Totals — cost (descriptive) | 8.300151 | 2.558283 |
| Totals — requests | 238 | 155 |
| Totals — gross tokens | 4082133 | 947631 |
| Totals — successful inline bytes | 3927344 | 466404 |

---

## 4. The four frozen §11.2 analyzer verdicts (machine facts)

All four verdicts are **ACHIEVED** in the persisted analyzer JSON, with the
exact frozen arithmetic and display ratios (no rounding that changes
meaning):

| # | Id | Threshold | Ratio (display) | Status |
| --- | --- | --- | --- | --- |
| 1 | `bytes_median_reduction` | successful inline bytes median reduction ≥ 50% | `0.8754945248557136` = 87.54945248557136% (treatment median 23320 vs control median 187301) | **ACHIEVED** |
| 2 | `gross_median_reduction` | commander gross tokens median reduction ≥ 20% | `0.7544969718882762` = 75.44969718882762% (treatment median 46172 vs control median 188071) | **ACHIEVED** |
| 3 | `requests_median_non_increase` | treatment requests median ≤ control (non-increase) | `0.391304347826087` = 39.1304347826087% reduction (treatment median 7 vs control median 11.5) | **ACHIEVED** |
| 4 | `gross_p90_regression` | treatment gross p90 ≤ 1.05 × control p90 (tail guard) | `0.20826010875496265` treatment/control ratio (55342 / 265735) | **ACHIEVED** |

### 4.1 Aspirational milestones (reported separately — not release gates)

The Commander Token Optimization plan's aspirational targets (its §10.2:
**80%** bytes / **40%** gross / **25%** requests) are **arithmetically met**
by the measured ratios above (87.55% ≥ 80%, 75.45% ≥ 40%, 39.13% ≥ 25%).
These milestones are **not NRO release gates**: the plan's §11.2 note and
the protocol's §10 keep them aspirational, reported separately as
measured-or-not, and they do not change the §11.1 verdict.

---

## 5. Correctness (frozen rubric, machine facts + Commander audit)

Rubric: 6 frozen machine-checkable checks (`build`, `unicode`, `token`,
`needle_occurrences`, `needle_lines`, `needle_files`) over the final
assistant message text; a run passes only when every pattern matches
(protocol §6.2).

- **Control arm: 15/20 overall passes.** Failing runs: `control-07`,
  `control-09`, `control-11`, `control-14`, `control-18`. Control failures
  are **descriptive**: they are not release-blocking for the treatment-arm
  criterion, but are recorded as machine facts.
- **Treatment arm: 19/20 overall passes.** The single treatment failure is
  **`treatment-07`** (source `raw-14-treatment.jsonl`): its final text
  contains the correct values in comma-separated form **without spaces**,
  so the frozen exact `unicode` regex does not match; all other checks
  pass. This **still fails the exact frozen rubric and cannot be waived
  post hoc** — the rubric is frozen (protocol §3.3) and a waiver would be a
  post-hoc protocol change. Treatment-arm rubric correctness is
  **release-blocking** (plan §11.1 criterion 1).

---

## 6. Pagination / no-hidden-truncation condition (frozen machine facts + Commander raw audit)

### 6.1 Frozen analyzer pagination facts (machine facts)

Under protocol §8.5 FIFO attribution, the analyzer derives pagination and
misuse signs per run. Two treatment runs carry the machine misuse sign
(`obligations > 0` and `obligationsPaginated < obligations`):

| Run | Preview results | Continuation reads | Obligations | Obligations paginated | Reached complete | Misuse (machine) |
| --- | --- | --- | --- | --- | --- | --- |
| `treatment-18` | 1 | 0 | 1 | 0 | 0 | **true** |
| `treatment-19` | 1 | 0 | 1 | 0 | 0 | **true** |

These frozen machine facts stand as recorded. **They are not modified,
overridden, or re-interpreted in this record.** The no-hidden-truncation /
misuse condition (plan §11.1 criterion 3, analyzer-verified) is therefore
**not clean** as measured.

### 6.2 Commander raw audit (manual facts)

Commander's raw-file audit at N4 found that both `treatment-18` and
`treatment-19` **actually issued explicit `offset`/`limit` continuation
reads** and obtained `delta-77` — i.e., the pagination was performed, but
the frozen FIFO attribution does not see it. **Cause (Commander's finding):
intermediate provider-error assistant tool calls without `toolResults`
remain in the frozen FIFO call queue and shift the call/result
attribution.** This is a frozen-protocol/analyzer limitation discovered
**after** collection; per the frozen protocol it cannot be fixed or
overridden for this measurement.

Across all 20 treatment raw files, Commander's grep audit found: explicit
large-log `offset` continuations in **all 20 files (42 calls total)**,
`token: delta-77` in **all 20 files (22 occurrences including retries)**,
and **zero edit/write tool calls**. No manual unsupported
quoting/editing-beyond-preview sign was confirmed; no editing task existed
in the milestone task.

**Status of these manual facts:** they are recorded as Commander manual
audit facts for the record. They **do not cure** the exact-rubric failure
(§5) and they **do not cure** the frozen machine misuse signs or the
release criterion: the frozen analyzer result is the measured result, and
no post-hoc override is permitted.

---

## 7. Commander verdict (Sol-owned, recorded here)

**FAIL / DO NOT ADOPT** under plan §11.1, despite all four §11.2
thresholds being ACHIEVED. Release blockers:

1. **Treatment correctness rubric is not 20/20** (plan §11.1 criterion 1):
   `treatment-07` failed the frozen exact `unicode` regex check (correct
   values, comma-separated without spaces); the exact frozen rubric cannot
   be waived post hoc.
2. **Analyzer-verified no-hidden-truncation/misuse condition is not clean**
   (plan §11.1 criterion 3): `treatment-18` and `treatment-19` carry frozen
   machine misuse signs (`obligations=1`, `obligationsPaginated=0`,
   `continuationReads=0`) under protocol §8.5 FIFO attribution. The
   Commander raw audit's continuation findings (§6.2) are recorded but do
   not override the frozen machine result.

Thresholds are adoption criteria, not release gates (protocol §13); the
four ACHIEVED §11.2 statuses cannot override §11.1. **No recollection,
denominator/run dropping, threshold/statistic change, or post-hoc protocol
change is permitted** (plan §11; protocol §3.3). Completing adoption would
require a new protocol revision approved before any new collection.

**Not done:** N2b and N3 remain **NOT_RUN**; no commit/publish/tag/release
was performed.

---

## 8. Limitations (must be read with this result)

Frozen protocol §13 limitations, as they apply here:

- **No causal claim.** The analyzer reports machine facts and pinned
  arithmetic; the threshold ratios are arithmetic facts on the declared
  bases, not proof that the overrides caused them.
- **Small cohort.** n = 20 per arm; medians and p90 only. **No statistical
  significance is claimed** and none can be derived from this record.
- **Environment-specific.** Results apply to the pinned Pi 0.83.0 / Node
  v26.4.0 / `openai-codex/gpt-5.6-sol` / thinking `high` environment only.
- **Fresh-session attestation.** "Fresh sessions only" is attested by the
  collection record and raw-byte hashes; the analyzer cannot independently
  detect a resumed session from the JSONL alone.
- **Stochastic provider errors.** Provider-error assistant tool calls
  without `toolResults` occurred during collection; they are retained in
  the raw sessions and are the cause of the FIFO-attribution limitation
  (§6.2).
- **FIFO-attribution limitation.** The frozen §8.5 FIFO call/result
  attribution can mis-attribute pagination when intermediate
  provider-error calls without `toolResults` remain in the queue; this is
  a frozen-protocol/analyzer limitation discovered after collection and is
  not overridden here.
- **Manual facts are not machine facts.** Commander's raw audit (§6.2) is
  manual evidence recorded for context; it does not alter the frozen
  analyzer output.

---

## 9. Reproducibility and verification status

### 9.1 Evidence paths

- Collection record:
  `.pi/workbench/runs/commander-native-tool-final-collection/collection-record.json`
  (40 session entries, 0 attempt entries) and its 40 raw sources under
  `.pi/workbench/runs/commander-native-tool-final-collection/sources/`.
- Prepare run record: `.pi/workbench/runs/20260807-095318-gxbb/` (exit 0);
  committed evidence under `.pi/workbench/runs/commander-native-tool-benchmark/`
  and the strict manifest
  `.pi/workbench/runs/commander-native-tool-benchmark-manifest.json`.
- Analyzer run record: `.pi/workbench/runs/20260807-095326-way4/` (exit 0);
  full deterministic JSON report at
  `.pi/workbench/runs/20260807-095326-way4/stdout.log`.

### 9.2 Exact controlled recipes

- **Collection** — recipe `commander-native-tool-final-collect` (DEV-only,
  uncached, **performs PAID provider/model calls**; requires a separate
  explicit user authorization before any run; **not to be rerun without
  fresh authorization**). It already ran once: `20260807-090523-7lpr`,
  exit 0, `status=complete valid=40 attempts=40`.
- **Prepare (offline)** — recipe `commander-native-tool-benchmark-prepare`
  (uncached; refuses existing outputs): ran as `20260807-095318-gxbb`,
  exit 0.
- **Analyzer (offline, read-only)** — recipe `commander-native-tool-benchmark`
  (uncached): ran as `20260807-095326-way4`, exit 0.
- **Later verification** — Commander-owned no-cache `check` and the b0–b6
  gates, run **after** actual-diff review of this N5 record. **At
  record-write time these runs are pending**: no run IDs exist yet and no
  PASS is claimed or fabricated here. The final verification recipe runs
  and gates remain commander-owned (plan §12) and are never run by a
  worker.

---

## 10. Explicit non-claims

This record:

- records the NRO-N4 measurement and verdict; it is **not** P9/P3 evidence
  and does not alter, weaken, or reinterpret the frozen P9 verdict, the
  P3 0.0 request FAIL, or any P9/P3 artifact;
- makes **no token-savings claim beyond the recorded arithmetic facts** and
  no causal claim;
- does not claim the four §11.2 ACHIEVED statuses are release gates;
- does not waive the frozen rubric or override the frozen analyzer result
  (including the `treatment-18`/`treatment-19` machine misuse signs);
- makes no claim that the pending Commander no-cache `check` / b0–b6 gates
  passed — they are pending at record-write time;
- contains no message bodies, tool arguments, thinking text, secrets, or
  absolute input paths (privacy boundary per protocol §9.4).
