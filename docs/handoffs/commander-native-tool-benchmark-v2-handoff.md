# Commander Native Tool Optimization — NRO Protocol-v2 Handoff (post-analysis, durable session-resume document)

| Field | Value |
| --- | --- |
| Purpose | Self-contained handoff so a brand-new, memoryless session can continue the NRO protocol-v2 work from the **completed collection/prepare/analyze + verdict-recorded** state, without re-deriving any v1 or v2 fact |
| Repository | `pi-dev-workbench` (project root; this document uses project-relative paths only) |
| Branch / base | `main` (dirty working tree by design — all NRO v1 + v2 work lives uncommitted) |
| ⚠ Pre-document hash warning | Hashes embedded in this document (e.g. `588e68ac…` for delegation `20260807-222425-c0en`) are **historical evidence of reviewed states**, not the live post-document hash: writing this document changed the working tree. **The next session MUST resolve the live diff hash/state itself** and must never treat any embedded hash as current evidence |
| Durable authority | `docs/plans/commander-native-tool-optimization.md` + `docs/plans/worker-token-budget-repair.md` + `docs/baselines/commander-native-tool-benchmark.md` (immutable v1 result) + `docs/baselines/commander-native-tool-benchmark-protocol-v2.md` (frozen v2 contract) + `docs/baselines/commander-native-tool-benchmark-v2.md` (**new immutable v2 FINAL result record**) |
| Handoff date | 2026-08-07 (written by the N5-style documentation-recording slice, after the v2 verdict) |
| Owner | GPT-5.6 Sol commander (requirements, architecture, scope, actual-diff review, final verification, gates, final verdict) |
| Executor | Fresh bounded workers, one bounded slice per delegation; worker reports are never acceptance evidence |

This document is **documentation-only consolidation**: it changes no plan,
baseline, protocol, artifact, denominator, threshold, or verdict. Nothing
here is acceptance evidence; no PASS is claimed for anything that did not
run. The v2 measurement is **complete** (collection + prepare + analyzer +
verdict record); what remains is Commander-owned verification of this
documentation diff and final handoff closure.

---

## 1. Current state (what changed, in one view)

- **v2 FINAL measurement completed and recorded.** Paid v2 collection
  `20260807-224411-4158` (exit 0, `status=complete valid=40 attempts=40`,
  20/arm ABBA×10, 0 invalid attempts) → offline prepare `20260807-232116-6utj`
  (exit 0, 40 sessions / 0 attempts committed byte-exact) → formal analyzer
  `20260807-232119-rdjv` (exit 0, full JSON at
  `.pi/workbench/runs/20260807-232119-rdjv/stdout.log`).
- **Sol verdict recorded (immutable, in the new v2 result record):**
  **PASS / ADOPT the currently implemented N1 read-preview and N2
  grep-count overrides under frozen protocol v2**, with strict
  qualifications: all release blockers and all four adoption thresholds
  satisfied by the persisted v2 evidence; **N2b and N3 remain NOT_RUN**;
  v1 remains immutable **FAIL / DO NOT ADOPT** and is never reinterpreted;
  no causal/significance claim; no commit/publish/tag/release.
- **This handoff was rewritten** from the stale pre-collection state to
  the completed post-analysis state. The earlier handoff's claims that v2
  collector/wiring/evidence/result are absent are **superseded** — v2
  collection, prepare, analyze, evidence, manifest, and result record all
  exist now.
- **Files changed by this slice (exactly two):**
  `docs/baselines/commander-native-tool-benchmark-v2.md` (new immutable
  v2 FINAL result record) and `docs/handoffs/commander-native-tool-benchmark-v2-handoff.md`
  (this document). No protocol, source, test, package/recipe/gate config,
  v1 baseline, P9/P3 artifact, or run artifact was modified.

## 2. Key persisted v2 facts (verify by reading; do not rerun collection/prepare/analyze)

| Item | Value |
| --- | --- |
| Reviewed implementation delegation | `20260807-222425-c0en` — review PASS; bound hash `588e68ac4911323fdc0b1b7657b651ae7d25a2dad292b9c686581af1042c7b27` (**historical**, see warning above) |
| Pre-collection implementation verification | typecheck `20260807-223822-gbwi` (exit 0); unit-test `20260807-223830-cj4l` (exit 0, **1670/1670**); full check `20260807-224049-qoyf` (exit 0); gates **b0–b6 all PASS** `20260807-224401-r7f0` (exit 0) |
| Collection run | `20260807-224411-4158` — `commander-native-tool-v2-final-collect`, exit 0; `status=complete valid=40 attempts=40`; record `.pi/workbench/runs/commander-native-tool-v2-final-collection/collection-record.json` + `sources/` |
| Prepare run | `20260807-232116-6utj` — `commander-native-tool-benchmark-v2-prepare`, exit 0; manifest `.pi/workbench/runs/commander-native-tool-benchmark-v2-manifest.json`; evidence root `.pi/workbench/runs/commander-native-tool-benchmark-v2/` (40 sessions, 0 attempts; all four pins matched; fixture verified 11 files / 133,440 bytes) |
| Analyzer run | `20260807-232119-rdjv` — `commander-native-tool-benchmark-v2`, exit 0; full JSON at `.pi/workbench/runs/20260807-232119-rdjv/stdout.log` |
| Verdict record | `docs/baselines/commander-native-tool-benchmark-v2.md` (immutable; this slice) |

Measured headline facts (all in the analyzer JSON; see the result record
§§3–6 for the full tables): treatment 20/20 correctness, control 18/20
(`control-10` failed `needle_occurrences`/`needle_lines`/`needle_files`;
`control-15` failed `needle_occurrences`/`needle_lines` — descriptive
only); treatment pagination 20/20 with zero misuse; `editWriteToolCalls:
0` for all 40 runs; arm medians control 10 / 198064 / 221201 / p90 246618
vs treatment 7 / 46108 / 23320 / p90 55082; four verdicts all ACHIEVED —
bytes `0.8945755218104801`, gross `0.7672065594959205`, requests `0.3`,
gross p90 ratio `0.22334947165251523`. Aspirational milestones (80/40/25%)
are arithmetically met but non-gating.

## 3. What was deliberately not done

- **No recollection** — the paid v2 collection ran exactly once and must
  not be rerun without fresh user authorization.
- **No rerun of exclusive `prepare`** — the v2 prepare has
  exclusive-create semantics and refuses pre-existing outputs; rerunning
  is impossible by design and must not be attempted unless a new protocol
  is approved.
- **No protocol/source/test/config changes**: no change to
  `recipes.yaml`, `package.json`, scripts, tests, protocol docs, the v1
  baseline, P9/P3 artifacts, or any run artifact.
- **N2b / N3 not run** (remain NOT_RUN by Sol's verdict).
- **No commit/publish/tag/release**, no CHANGELOG/version bump.
- **No final gates run by the worker** — post-document Commander
  no-cache `check` and b0–b6 gates are pending at write time; the
  pre-collection check/gates (`20260807-224049-qoyf`,
  `20260807-224401-r7f0`) are cited in the record only as pre-collection
  implementation evidence.

## 4. Assumptions and risks

- **Embedded hashes are historical evidence.** All hashes/run IDs in this
  handoff and in the result record describe persisted reviewed states;
  the working tree changed when these docs landed. The next session must
  resolve live git/delegation state itself (see §6) and must never treat
  embedded values as current evidence.
- **Post-document verification is outstanding.** Fresh Commander no-cache
  `check` and b0–b6 gates on the final diff (including these two docs)
  have **not run**; nothing here claims them. They are required before
  final handoff closure.
- **v1 immutability.** The v1 N4 FAIL / DO NOT ADOPT record is immutable
  and never reinterpreted; v1 evidence was never an input to v2 analysis.
- **Frozen-contract semantics.** `reachedComplete=0` across the cohort is
  the frozen expected legacy `offset`/`limit` semantics (no marker on
  continuation results) and is not a blocker; misuse is false for all 40
  runs. Any future re-interpretation would be a post-hoc protocol change
  and is forbidden.
- **Privacy boundaries.** Docs contain no message bodies, tool arguments,
  thinking text, secrets, or absolute private paths.

## 5. Verification evidence (exact commands/records already run)

| Check | Run ID / record | Outcome |
| --- | --- | --- |
| Reviewed delegation | `20260807-222425-c0en/review.json` | PASS, `mismatch: false`, `drift_paths: []`, `violations: []` |
| Commander no-cache typecheck (pre-collection) | `20260807-223822-gbwi` | exit 0 |
| Commander no-cache unit-test (pre-collection) | `20260807-223830-cj4l` | exit 0 — **1670/1670** (`ℹ tests 1670`, `ℹ pass 1670`, `ℹ fail 0`) |
| Full check (pre-collection) | `20260807-224049-qoyf` | exit 0 |
| Gates b0–b6 (pre-collection) | `20260807-224401-r7f0` | exit 0 — **b0–b6 all PASS** (`gates.json` all `"status": "PASS"`) |
| Paid v2 collection | `20260807-224411-4158` | exit 0 — `status=complete valid=40 attempts=40` |
| v2 prepare | `20260807-232116-6utj` | exit 0 — evidence committed, 40 sessions / 0 attempts, all pins |
| v2 analyzer | `20260807-232119-rdjv` | exit 0 — full JSON report persisted |
| Post-document Commander no-cache `check` / b0–b6 gates | — | **NOT_RUN / PENDING at write time** — no IDs exist; do not claim |

## 6. Continuation (next session, in order)

1. **Review this actual diff first** (Commander): the two documentation
   paths only — `docs/baselines/commander-native-tool-benchmark-v2.md`
   and `docs/handoffs/commander-native-tool-benchmark-v2-handoff.md`.
2. **Resolve live state:** `workbench_project_inspect` (git commit, dirty
   tree, recipe list, config errors); confirm the latest delegation is
   REVIEWED and its bound hash equals the live diff hash. Never reuse
   embedded hashes as current evidence.
3. **Run the pending verification:** Commander-owned **no-cache**
   `typecheck`, `unit-test`, full `check`, then **b0–b6 gates** on the
   final diff (workers never run gates).
4. **Close the handoff** only after those pass — the v2 result record is
   immutable and already records the verdict; the post-document
   check/gates are the remaining precondition for final handoff closure.
5. **Do not:** rerun paid collection (needs fresh user authorization),
   rerun exclusive `prepare` (refuses pre-existing outputs; only a new
   approved protocol would justify a new evidence pipeline run), modify
   v1/P9/P3 artifacts, or change frozen protocol constants.

## 7. Explicit non-claims

This handoff: claims no PASS for the pending post-document `check`/gates
(they are NOT_RUN at write time); does not alter, weaken, reinterpret, or
promote the v1 N4 FAIL / DO NOT ADOPT record; makes no causal or
significance claim and no token-savings claim beyond the recorded
arithmetic facts; is not collection authorization (fresh paid collection
requires a later separate explicit user authorization); claims no
commit/publish/tag/release; contains no message bodies, tool arguments,
thinking text, secrets, or absolute private input paths; and is a harness
handoff, not acceptance evidence — only Sol maps evidence to criteria.
