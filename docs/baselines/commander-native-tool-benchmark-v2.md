# Commander Native Tool Optimization — NRO Protocol-v2 FINAL Benchmark and Verdict Record

| Field | Value |
| --- | --- |
| Record | NRO protocol-v2 FINAL benchmark + Commander verdict (immutable v2 FINAL result record; written by the N5-style documentation-recording slice) |
| Plan | `docs/plans/commander-native-tool-optimization.md` (durable contract; NRO protocol in §10, adoption criteria in §11, slices in §12) |
| Protocol | `docs/baselines/commander-native-tool-benchmark-protocol-v2.md` (frozen v2 contract; this record is its executed FINAL result) |
| Effort | **NRO — "Native read/grep/find Override"** — an independent NRO effort, **not** P9/P3 and not a phase of the Commander Token Optimization plan; it reuses no P9/P3 artifact, manifest, session, constant, or denominator |
| Recorded | 2026-08-07 (v2 collection, prepare, analyzer, and verdict date) |
| Reviewed implementation delegation | `20260807-222425-c0en` — review verdict **PASS**, bound diff hash `588e68ac4911323fdc0b1b7657b651ae7d25a2dad292b9c686581af1042c7b27`, mismatch false, drift `[]`, violations `[]` (record: `.pi/workbench/delegations/20260807-222425-c0en/review.json`) |
| Pre-collection implementation verification | typecheck `20260807-223822-gbwi` (exit 0); unit-test `20260807-223830-cj4l` (exit 0, **1670/1670**); full check `20260807-224049-qoyf` (exit 0); gates b0–b6 all PASS `20260807-224401-r7f0` (exit 0) |
| Collection run | `20260807-224411-4158` — recipe `commander-native-tool-v2-final-collect`, exit 0; collector summary `status=complete valid=40 attempts=40` |
| Prepare run | `20260807-232116-6utj` — recipe `commander-native-tool-benchmark-v2-prepare`, exit 0; evidence committed (fixture + 4 frozen inputs + 40 sessions + 0 attempts, byte-exact copies) |
| Analyzer run | `20260807-232119-rdjv` — recipe `commander-native-tool-benchmark-v2`, exit 0; full JSON report at `.pi/workbench/runs/20260807-232119-rdjv/stdout.log` |
| Manifest | `.pi/workbench/runs/commander-native-tool-benchmark-v2-manifest.json` (schema_version 2, protocol_version 2, phase `final`, 40 sessions, 0 attempts) |
| Evidence root | `.pi/workbench/runs/commander-native-tool-benchmark-v2/` (gitignored; fixture + frozen inputs + byte-exact session copies + `collection-deviations.json`) |
| Collection record | `.pi/workbench/runs/commander-native-tool-v2-final-collection/collection-record.json` (schema 2, protocol 2, phase `final`, 40 session entries, 0 attempt entries) + 40 raw sources under its `sources/` |
| Sol verdict | **PASS / ADOPT the currently implemented N1 read-preview and N2 grep-count overrides under frozen protocol v2** — all release blockers and all four adoption thresholds are satisfied by the persisted v2 evidence; **N2b and N3 remain NOT_RUN**; v1 remains immutable **FAIL / DO NOT ADOPT** and is never reinterpreted; no causal or significance claim; no commit/publish/tag/release |
| Status | **ADOPTED** (subject to the strict qualifications in §1). Post-document Commander no-cache `check` and b0–b6 gates were **pending at record-write time** and must pass before final handoff closure (see §9); the already-passed pre-collection implementation check/gates are cited separately (§2, §7) |

This record is the immutable NRO protocol-v2 FINAL result record for the
completed v2 measurement. Every numeric value in §§2–6 is the
machine-derived analyzer JSON of run `20260807-232119-rdjv` over the
strict v2 manifest and its declared session files (and the persisted
collection/prepare run records), with no rounding that changes meaning.
Facts are labeled by source throughout: **machine facts** (persisted
analyzer/collector/prepare output), **Commander manual audit** (raw-file
audit performed by Sol), and the **Commander verdict**. This is evidence
recording, not worker acceptance: worker prose here is not acceptance
evidence, no final gate was run by a worker, and nothing in this document
claims a PASS for runs that did not run.

---

## 1. Scope and verdict

**Scope.** Protocol v2 measured the NRO treatment (the N1 `read` preview
override and the N2 `grep` count mode, on the current runtime source)
against the control arm (the same current runtime source through the
dedicated final-control adapter, with the Pi built-in `read`/`grep`/
`find` in effect) on the frozen 20+20 ABBA×10 final validation cohort,
ran the offline `prepare` and analyzer, audited correctness and
pagination/misuse against the frozen v2 rubric, and issued the Sol
verdict against protocol-v2 §8.

**Verdict (Sol-owned, recorded here):**

- **PASS / ADOPT the currently implemented N1 read-preview and N2
  grep-count overrides under frozen protocol v2.**
- **Strict qualifications:**
  - All release blockers (protocol-v2 §8: correctness 20/20 treatment,
    security/mode semantics unchanged, no hidden truncation with a
    clean analyzer-verified misuse condition, zero edit/write tool
    calls, commander-owned check/gates on the final diff) and all four
    §8 adoption thresholds are **satisfied by the persisted v2
    evidence** (§4–§7).
  - **N2b (staged `grep output: "files"`) and N3 (`find`
    count/max_depth) remain NOT_RUN** — the adopted overrides are the
    currently implemented N1 and N2 only.
  - **v1 remains immutable FAIL / DO NOT ADOPT** (its own immutable
    record `docs/baselines/commander-native-tool-benchmark.md`) and is
    **never reinterpreted, re-litigated, or promoted** by this v2
    result; v1 evidence was never an input to v2 analysis.
  - **No causal or significance claim** is made; the threshold ratios
    are arithmetic facts on the declared bases (§8).
  - **No commit/publish/tag/release action occurred.**
  - **Post-document Commander no-cache `check` and b0–b6 gates were
    pending at record-write time** and must pass before final handoff
    closure (§9). The already-passed **pre-collection** implementation
    check and b0–b6 gates (`20260807-224049-qoyf`,
    `20260807-224401-r7f0`) are cited separately (§2, §7) and are not a
    substitute for the post-document runs.
- The four §8 thresholds are **adoption criteria, not release gates**
  (protocol-v2 §8); here they report **ACHIEVED** and, with all release
  blockers satisfied, support the adoption verdict.
- **No post-hoc protocol change was made or is permitted**: no
  recollection, no denominator/run dropping, no threshold/statistic
  change, no waiver of the frozen rubric. The aspirational milestones
  (§4.1) are reported separately and are not v2 release gates.

---

## 2. Collection integrity (machine facts)

Facts from the persisted collector run record (`20260807-224411-4158`,
exit 0) and the strict collection record
(`.pi/workbench/runs/commander-native-tool-v2-final-collection/collection-record.json`):

- **Collector summary:** `status=complete valid=40 attempts=40` —
  exactly **40 paid provider/model processes** were successfully started
  and **every one** was a valid final session; there were **0 invalid
  attempts** (no attempt entries exist in the strict record: 40
  `kind: "session"` entries, 0 `kind: "attempt"` entries, `phase:
  "final"`, `schema_version` 2, `protocol_version` 2).
- **Cohort:** fixed **ABBA×10** interleave over positions 1..40 — 20
  control + 20 treatment sessions (`control-01..control-20`,
  `treatment-01..treatment-20`); 40 source JSONLs
  (`sources/raw-01-control.jsonl` .. `raw-40-control.jsonl`), no dropped
  runs, all attempts retained (none existed to retain beyond the 40
  sessions).
- **Prepare commit (`20260807-232116-6utj`, exit 0):** evidence
  committed byte-exact under `.pi/workbench/runs/commander-native-tool-benchmark-v2/`
  (fixture + the four frozen inputs + 40 sessions + 0 attempts), strict
  manifest at `.pi/workbench/runs/commander-native-tool-benchmark-v2-manifest.json`
  (schema 2, protocol 2, phase `final`, 40 sessions, 0 attempts; paths
  relative to the runs root).
- **Manifest phase final, schema/protocol 2, all four frozen pins
  matched** (prepare and analyzer both enforced):
  `milestone_prompt_sha256` `1af10ebb…608a40`,
  `fixture.manifest_sha256` `062b3c92…c216b6` (fixture re-verified by
  the analyzer: 11 files, 133,440 bytes), `rubric.sha256`
  `6c223da4…6046` (schema-2 revision, 6 checks), `non_treatment_sha256`
  `7cbb5452…d28738`; every session `promptMatches: true` (40/40) and
  `sessionSha256` matches its declared `expected_session_sha256`.
- **Environment (manifest, pinned):** `openai-codex/gpt-5.6-sol`,
  thinking `high`, Pi `0.83.0`, Node `v26.4.0`; every final session
  recorded the pinned model key and thinking level.
- **Terminal facts:** all 40 runs `terminalStop: true`, `aborted:
  false`, `errored: false`, `compactionCount: 0` — **zero compactions
  across the cohort**; analyzer `attempts: []` (0 invalid-attempt
  entries); `collection-deviations.json` in the evidence root carries
  `attempts: []`.

---

## 3. Arm metrics (machine facts, analyzer JSON)

Exact values from `.pi/workbench/runs/20260807-232119-rdjv/stdout.log`
(`arms` block). Medians are the frozen middle-two means (n = 20 per
arm); gross p90 is the nearest-rank 18th smallest of 20 (protocol-v2
§8); gross = input + output + cacheRead + cacheWrite.

| Metric | Control (n = 20) | Treatment (n = 20) |
| --- | --- | --- |
| Requests median | 10 | 7 |
| Gross tokens median | 198064 | 46108 |
| Successful inline bytes median | 221201 | 23320 |
| Gross p90 | 246618 | 55082 |
| Totals — cost (descriptive) | 8.125814 | 2.363653 |
| Totals — requests | 211 | 138 |
| Totals — gross tokens | 3974446 | 920005 |
| Totals — successful inline bytes | 4259841 | 466297 |

---

## 4. The four frozen §8 analyzer verdicts (machine facts)

All four verdicts are **ACHIEVED** in the persisted analyzer JSON, with
the exact frozen arithmetic and display ratios (no rounding that changes
meaning):

| # | Id | Threshold | Ratio (display) | Status |
| --- | --- | --- | --- | --- |
| 1 | `bytes_median_reduction` | successful inline bytes median reduction ≥ 50% | `0.8945755218104801` = 89.45755218104801% (treatment median 23320 vs control median 221201) | **ACHIEVED** |
| 2 | `gross_median_reduction` | commander gross tokens median reduction ≥ 20% | `0.7672065594959205` = 76.72065594959205% (treatment median 46108 vs control median 198064) | **ACHIEVED** |
| 3 | `requests_median_non_increase` | treatment requests median ≤ control (non-increase) | `0.3` = 30% reduction (treatment median 7 vs control median 10) | **ACHIEVED** |
| 4 | `gross_p90_regression` | treatment gross p90 ≤ 1.05 × control p90 (tail guard) | `0.22334947165251523` treatment/control ratio (55082 / 246618) | **ACHIEVED** |

### 4.1 Aspirational milestones (reported separately — not release gates)

The plan's aspirational targets (**80%** bytes / **40%** gross / **25%**
requests) are **arithmetically met** by the measured ratios above
(89.46% ≥ 80%, 76.72% ≥ 40%, 30% ≥ 25%). These milestones are **not v2
release gates**: protocol-v2 §8 keeps them aspirational, reported
separately as measured-or-not, and they are not part of the verdict.

---

## 5. Correctness (frozen rubric, machine facts + Commander audit)

Rubric: 6 frozen machine-checkable checks (`build`, `unicode`, `token`,
`needle_occurrences`, `needle_lines`, `needle_files`) over the final
assistant message text; a run passes only when every pattern matches
(protocol-v2 §7; schema-2 `unicode` pattern accepts both spaced and
unspaced comma forms).

- **Treatment arm: 20/20 overall passes.** All 20 treatment runs pass
  the full six-check rubric — the treatment-arm correctness release
  blocker (protocol-v2 §8 criterion 1) is **satisfied**.
- **Control arm: 18/20 overall passes.** Failing runs:
  - `control-10` failed `needle_occurrences`, `needle_lines`, and
    `needle_files`;
  - `control-15` failed `needle_occurrences` and `needle_lines` only.
- Control failures are **descriptive** machine facts; they are **not
  treatment release blockers** and do not affect the §8 criterion 1.

---

## 6. Pagination / no-hidden-truncation condition (frozen machine facts + Commander raw audit)

### 6.1 Frozen analyzer pagination facts (machine facts)

Under protocol-v2 §6.5 exact-ID attribution:

- **Every treatment run has exactly one preview obligation**
  (`previewResults: 1`, `obligations: 1` per run; 20/20 treatment runs).
- **All 20 treatment obligations are paginated**
  (`obligationsPaginated: 1` for all 20) — the incomplete-result misuse
  sign (`obligations > 0` and `obligationsPaginated < obligations`) is
  **absent**.
- **Misuse is false for all 40 runs** (pagination-level and run-level
  flags; zero `misuse: true` in the analyzer JSON).
- `reachedComplete: 0` for all 40 runs. Under the frozen v2 contract
  (§6.3/§6.5), legacy continuation reads (explicit `offset`/`limit`)
  return the built-in result with **no facts block**, so a
  `complete=true` marker (and hence `reachedComplete`) is **expected to
  be 0** for such reads; this is **not a blocker** under the frozen
  contract.
- `orphanReadCalls` and `errorReadResults` are reported per run by the
  analyzer and carry no attribution shift (exact-ID policy).

### 6.2 Commander raw audit (manual facts)

- Raw treatment sources contain **38 explicit `offset` calls across all
  20 treatment files** — explicit `offset`/`limit` continuation reads
  were performed.
- **Zero `name: edit` and zero `name: write` tool calls** in the raw
  treatment sources (consistent with analyzer `editWriteToolCalls: 0`
  for all 40 runs, §7).
- **No unsupported quoting/editing-beyond-preview sign was confirmed**
  in Commander's raw/final-output audit. Manual facts are recorded for
  the record; they are consistent with, and do not override, the frozen
  machine facts.

---

## 7. Release blockers (protocol-v2 §8 — all satisfied by persisted evidence)

| # | Frozen release blocker | Evidence (labeled) | Status |
| --- | --- | --- | --- |
| 1 | Correctness matrix passes and treatment-arm rubric is **20/20** | Analyzer JSON `20260807-232119-rdjv`: treatment 20/20 passes over the frozen schema-2 six-check rubric (§5) | **Satisfied** |
| 2 | Security/mode semantics unchanged — guard fires by **exact name**, no write path added | Reviewed final collector CLI/wiring delegation `20260807-222425-c0en` (review PASS, `588e68ac…`, its final collector CLI/wiring slice) + Commander pre-collection full check `20260807-224049-qoyf` (exit 0) and b0–b6 gates `20260807-224401-r7f0` (exit 0, all PASS incl. b0.2/b0.3/b0.4 package/recipe checks) — supporting evidence. **Exact-name guards remain and no write path was added** — a Commander conclusion from the complete reviewed implementation/test state, not a claim that delegation `20260807-222425-c0en` reviewed all historical core paths. No new post-document gate run is claimed yet | **Satisfied** (pre-collection evidence) |
| 3 | No hidden truncation — every truncated result carries exact facts; analyzer-verified no-hidden-truncation/misuse condition **clean** | Analyzer JSON: `nro-read-facts:` marker contract honored; all 20 treatment previews carry exact facts; `misuse: false` for all 40 runs (§6.1); `reachedComplete=0` is the frozen expected legacy semantics, not a blocker | **Satisfied** |
| 4 | **edit/write tool calls zero** across the cohort | Analyzer JSON: `editWriteToolCalls: 0` for all 40 runs; raw treatment audit: zero `name: edit` / `name: write` (§6.2) | **Satisfied** |
| 5 | Commander-owned no-cache `check` and gates pass on the final diff | **Pre-collection implementation check/gates passed:** `20260807-224049-qoyf` (check, exit 0), `20260807-224401-r7f0` (b0–b6 all PASS, exit 0), plus typecheck `20260807-223822-gbwi` and unit-test `20260807-223830-cj4l` (1670/1670). **Post-document Commander no-cache `check` and b0–b6 gates are PENDING at record-write time** and must pass before final handoff closure (§9) | **Satisfied (pre-collection) / PENDING (post-document)** |

All four §8 efficiency thresholds report **ACHIEVED** (§4). The
thresholds are adoption criteria, not release gates, and here support
— together with the satisfied blockers — the §1 verdict. **No
recollection, denominator/run dropping, threshold/statistic change, or
post-hoc protocol change is permitted** (protocol-v2 §3.2/§8).

---

## 8. Limitations (must be read with this result)

Frozen protocol-v2 §10 limitations, as they apply here:

- **No causal claim.** The analyzer reports machine facts and pinned
  arithmetic; the threshold ratios are arithmetic facts on the declared
  bases, not proof that the overrides caused them.
- **Preview-facts dependency.** Preview/pagination metrics depend on
  the frozen `nro-read-facts:` marker contract (§6.3 of the protocol)
  being implemented exactly by the read override; the marker must never
  appear in fixture files.
- **Misuse is partially machine-derived.** Only the pagination sign of
  incomplete-result misuse is machine-computed; quoting/editing signs
  were audited manually at the verdict (§6.2).
- **Fresh-session attestation.** "Fresh sessions only" is attested by
  the collection record and raw-byte hashes; the analyzer cannot
  independently detect a resumed session from the JSONL alone.
- **Small cohort.** n = 20 per arm; medians and p90 only. **No
  statistical significance is claimed** and none can be derived from
  this record.
- **Attempt-cap / representability.** Final collection was hard-capped
  at 60 successfully-started paid attempts; an exhausted cap yields a
  non-analyzable truthful partial (not applicable — this collection
  completed at 40/40 with 0 invalid attempts). Unrepresentable attempts
  hard-fail collection (none occurred).
- **Environment-specific.** Results apply to the pinned Pi 0.83.0 /
  Node v26.4.0 / `openai-codex/gpt-5.6-sol` / thinking `high`
  environment only.
- **Non-treatment bundle.** The bundle hash enforces that both arms ran
  against identical non-treatment content; it is not a measurement
  input.
- **Legacy continuation semantics.** `reachedComplete=0` is expected
  for legacy `offset`/`limit` results without a marker and is not a
  blocker under the frozen contract (§6.1).
- **Manual facts are not machine facts.** Commander's raw audit (§6.2)
  is manual evidence recorded for context; it does not alter the frozen
  analyzer output.

---

## 9. Reproducibility and verification status

### 9.1 Evidence paths

- Collection record:
  `.pi/workbench/runs/commander-native-tool-v2-final-collection/collection-record.json`
  (40 session entries, 0 attempt entries; schema 2, protocol 2, phase
  `final`) and its 40 raw sources under
  `.pi/workbench/runs/commander-native-tool-v2-final-collection/sources/`.
- Prepare run record: `.pi/workbench/runs/20260807-232116-6utj/` (exit
  0); committed evidence under
  `.pi/workbench/runs/commander-native-tool-benchmark-v2/` and the
  strict manifest
  `.pi/workbench/runs/commander-native-tool-benchmark-v2-manifest.json`.
- Analyzer run record: `.pi/workbench/runs/20260807-232119-rdjv/` (exit
  0); full deterministic JSON report at
  `.pi/workbench/runs/20260807-232119-rdjv/stdout.log`.
- Pre-collection implementation verification records:
  `20260807-223822-gbwi` (typecheck), `20260807-223830-cj4l`
  (unit-test, 1670/1670), `20260807-224049-qoyf` (check),
  `20260807-224401-r7f0` (b0–b6 gates, all PASS); reviewed delegation
  `20260807-222425-c0en` (PASS, bound hash `588e68ac…`).

### 9.2 Exact controlled recipes

- **Collection** — recipe `commander-native-tool-v2-final-collect`
  (DEV-only, uncached, **performs PAID provider/model calls**; requires
  a separate explicit user authorization before any run; **not to be
  rerun without fresh authorization**). It already ran once:
  `20260807-224411-4158`, exit 0, `status=complete valid=40 attempts=40`.
- **Prepare (offline)** — recipe `commander-native-tool-benchmark-v2-prepare`
  (uncached; exclusive-create semantics; **refuses pre-existing
  outputs, so it must not be rerun**): ran as `20260807-232116-6utj`,
  exit 0.
- **Analyzer (offline, read-only)** — recipe
  `commander-native-tool-benchmark-v2` (uncached): ran as
  `20260807-232119-rdjv`, exit 0.

### 9.3 Verification status at record-write time

- **Already passed (pre-collection implementation evidence):**
  Commander no-cache typecheck `20260807-223822-gbwi`, unit-test
  `20260807-223830-cj4l` (1670/1670), full check `20260807-224049-qoyf`,
  and b0–b6 gates `20260807-224401-r7f0` (all PASS) — these ran on the
  pre-collection diff after review of `20260807-222425-c0en`.
- **Pending at record-write time (must pass before final handoff
  closure):** fresh **post-document** Commander no-cache `check` and
  b0–b6 gates on the final diff (which now includes this record and the
  updated handoff). **No run IDs exist yet and no PASS is claimed or
  fabricated here** for these runs. The final verification recipe runs
  and gates remain commander-owned (plan §12) and are never run by a
  worker.
- **v1:** immutable; its own record and post-N5 gate history
  (`20260807-100731-hlrd` b0–b6 PASS) are historical v1 facts and are
  not evidence for the v2 diff.

---

## 10. Explicit non-claims

This record:

- records the NRO protocol-v2 FINAL measurement and verdict; it is
  **not** P9/P3 evidence and does not alter, weaken, or reinterpret the
  frozen P9 verdict, the P3 0.0 request FAIL, or any P9/P3 artifact;
- makes **no token-savings claim beyond the recorded arithmetic facts**
  and **no causal claim** and **no statistical-significance claim**;
- does **not** alter, weaken, reinterpret, or promote the immutable v1
  **N4 FAIL / DO NOT ADOPT** record; v1 evidence was never an input to
  v2 analysis;
- does not claim the four §8 ACHIEVED statuses are release gates (they
  are adoption criteria); it records them together with the satisfied
  release blockers as the basis of the §1 verdict;
- makes **no claim that the pending post-document Commander no-cache
  `check` / b0–b6 gates passed** — they are pending at record-write time
  (§9.3); the pre-collection check/gates are cited only as what they
  are: pre-collection implementation evidence;
- makes no claim that N2b or N3 were run — both remain **NOT_RUN**;
- claims no commit/publish/tag/release — none occurred;
- contains no message bodies, tool arguments, thinking text, secrets,
  or absolute private input paths (privacy boundary applied by this
  record).
