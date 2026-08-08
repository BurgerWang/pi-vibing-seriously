# Commander Token Optimization — P9 Final Benchmark and Verdict Record

| Field | Value |
| --- | --- |
| Record | P9 final benchmark + quality matrix + Sol verdict (durable result record) |
| Plan | `docs/plans/commander-token-optimization.md` (durable contract; P9 in §6, aspirational targets in §10.2, execution status in §13) |
| Protocol | `docs/baselines/commander-token-p9-protocol.md` (frozen method, frozen before final results; this record is its executed result) |
| Recorded | 2026-08-06 |
| Analyzer run | `20260806-120523-gy65` — exit 0; full JSON report at `.pi/workbench/runs/20260806-120523-gy65/stdout.log` |
| Manifest | `.pi/workbench/runs/commander-token-p9-manifest.json` (schema_version 1; exactly 3 baseline + 3 current sessions) |
| Sol verdict | **P9 PASS** — **FINAL RELEASE-QUALITY EXIT PASS under §10.1** (not a token-savings/optimization-success claim; §10.2 targets are expressly non-release-blocking) |
| P6 | NOT_SCHEDULED (capability-gated; does not block P9) |

This record is the durable evidence for the P9 phase exit (§6) and the final
release-quality verdict of the Commander Token Optimization plan. It is the
executed result of the frozen protocol (`docs/baselines/commander-token-p9-protocol.md`):
every decision number below is the machine-derived analyzer JSON of run
`20260806-120523-gy65` over the strict manifest and its declared session
files, and every quality-matrix mapping is grounded in the cited Commander
run/review records. This is evidence recording, not worker acceptance: the
mapping of §9/§10.1 rows and the verdict are Sol-owned facts recorded here
verbatim.

---

## 1. Scope and verdict

**Scope.** P9 (§6) re-measures the §2 metrics on the corrected
supplemental/post-deviation final-current cohort, reports the §10.2
aspirational targets as measured-or-not (every strict P0-based target
frozen NOT_MEASURABLE; the only measured arithmetic runs between the
pinned P3 pre cohort and the corrected supplemental/post-deviation
final-current cohort — protocol §3.4), runs the §10.1 release-blocking
quality matrix (all 11 §9 rows, all 9 §10.1 criteria), and ends in the Sol
verdict.

**Verdict (Sol-owned, recorded here):**

- **P9 PASS** and **FINAL RELEASE-QUALITY EXIT PASS under §10.1**: all
  eleven §9 matrix rows and all nine §10.1 criteria map to PASS with the
  evidence in §§6–7; §10.2 targets are expressly non-release-blocking
  (plan §10.2), so the missed targets do not block the verdict.
- This is **not** a token-savings or optimization-success claim: all three
  strict P0 targets are **NOT_MEASURABLE** (frozen basis-incomparable
  reasons) and all three supplemental comparable-milestone targets are
  **MISSED**; the historical P3 request-savings verdict **FAIL** (8→8,
  reduction 0.0) stays recorded and combined Slice B remains **NOT PASS**
  as an optimization exit.
- **No publish/tag/commit/release action occurred.**

---

## 2. Evidence identities

### 2.1 Delegations and actual-diff reviews (all review records under `.pi/workbench/delegations/`)

The three records below are the P8/P9 closing reviews: the P8 final
compatibility/status closure, the P9 harness, and the P9 real-prep repair.
Prior Slice A–D reviewed delegations (with their bound hashes and
verification runs) are preserved in plan §13 rows 1–4 and their handoff
records.

| Delegation | Worker paths (all reviewed) | Review verdict | Bound diff hash (review record) |
| --- | --- | --- | --- |
| P8 final compatibility/status closure `20260806-081008-l7na` | `docs/compatibility.md` | PASS, complete coverage | `3e4189b920f843010cbce7ba77597421d6460b0271d5b341f14283b048110711` |
| P9 harness `20260806-095638-fu5o` | `docs/baselines/commander-token-p9-protocol.md`, `scripts/commander-token-benchmark.ts`, `tests/commander-token-benchmark.test.ts` | PASS, complete coverage | `a2a0d7859e890e2507144ce40bd1b6ca855b4fd31ab534baf49626cd0c366bf2` |
| Real-prep terminal-expectation repair `20260806-115923-zjyf` | `scripts/commander-token-p9-prepare.ts`, `tests/commander-token-p9-prepare.test.ts` | PASS, complete coverage | `4429cf9e964295cde046068091e5454e8df773d059e7d095dcef22b605ee4905` |

### 2.2 Commander verification runs (all under `.pi/workbench/runs/`)

| Stage | Typecheck | Unit-test | Check | Gates |
| --- | --- | --- | --- | --- |
| P8 (hash `3e4189b9…`) | `20260806-081059-rlxw` exit 0 | `20260806-081106-6ykl` 1122/1122 | `20260806-081321-gk7a` 1122/1122 | `20260806-081834-p6lf` b0-b6 PASS |
| P9 harness (hash `a2a0d785…`) | `20260806-100728-61hd` exit 0 | `20260806-100736-hwvm` 1156/1156 | `20260806-100947-4gei` 1156/1156 | `20260806-101218-3jqk` b0-b6 PASS |
| Real-prep repair (hash `4429cf9e…`) | `20260806-120244-1fy2` exit 0 | `20260806-120252-a1up` 1183/1183 | — (covered below) | — (covered below) |
| Sol-owned quality verification (hash `4429cf9e…`) | — | — | **`20260806-120618-qwxe` PASS 1183/1183 (full no-cache check)** | **`20260806-120856-frol` PASS b0-b6 with required manual evidence** |

The all-gate run `20260806-120856-frol` records the required manual
evidence (b2.2, b2.3, b3.2, b3.3, b4.1–b4.3, b5.1, b5.2) and the
machine-injected b6 worker-first facts (strict policy active, commander
writes hard-denied, latest delegation `20260806-115923-zjyf` REVIEWED,
reviewed hash `4429cf9e…` equals the current diff hash, write lease locked,
gate initiated by the approved Sol commander). **The Sol verdict is based on
`20260806-120618-qwxe` and `20260806-120856-frol`.**

### 2.3 Real preparation and analysis records

- First real prep **`20260806-115823-m5by` FAILED (exit 1) before any
  artifacts** with the exact issue:
  `TERMINAL_MISMATCH: invalid attempt "invalid-4": observed aborted=true does not match the fixed expectation aborted=false`.
  Root cause fixed to require exactly `invalid-4` and `invalid-5` aborted,
  re-reviewed (delegation `20260806-115923-zjyf`), then:
- Successful preparation **`20260806-120518-y8xy` (exit 0)** created the
  strict manifest (`.pi/workbench/runs/commander-token-p9-manifest.json`),
  the privacy-safe deviation record
  (`.pi/workbench/runs/commander-token-p9-benchmark/collection-deviations.json`),
  the 8 invalid copies and the 3 corrected copies — all listed in that
  run's persisted `artifact_paths`.
- Analyzer run **`20260806-120523-gy65` (exit 0)** over
  `.pi/workbench/runs/commander-token-p9-manifest.json`; full JSON at
  `.pi/workbench/runs/20260806-120523-gy65/stdout.log`. Prompt SHA-256
  `01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f`; model
  `openai-codex/gpt-5.6-sol`; thinking `high`; exact 3+3 cohort; **zero
  compactions** in every session; every run retained (none excluded).

---

## 3. Collection protocol deviation (prominent)

**The original fresh cohort was invalidated.** The first three collection
attempts used a literal-path prompt and the next five used
whitespace-corrupted prompts, so none of the eight was a valid milestone
session. **All 8 invalid attempts are preserved and disclosed** in
`.pi/workbench/runs/commander-token-p9-benchmark/collection-deviations.json`
(schema_version 1; project-relative paths under
`commander-token-p9-benchmark/invalid-attempts/invalid-<N>/`):

| Attempt | Category | Aborted | Raw SHA-256 | Prompt SHA-256 | Terminal |
| --- | --- | --- | --- | --- | --- |
| invalid-1 | literal_path_prompt | false | `25bec47e7bca601d0b2c009e75d7773e96294e140639c2f03517f2a483843357` | `170e543b4b978a166dbdbedcf05267ca67869f8f11d61a7f398b372dda5f4831` | stop |
| invalid-2 | literal_path_prompt | false | `31894132e8c7f5263a64d56ed931fdeae27b9a69ae6ddc234b7b03e5cc3361da` | `170e543b4b978a166dbdbedcf05267ca67869f8f11d61a7f398b372dda5f4831` | stop |
| invalid-3 | literal_path_prompt | false | `345a8a29aa78dc2c3af108918a0ca2b914c5785ed5990934bafb78bd75e0a369` | `170e543b4b978a166dbdbedcf05267ca67869f8f11d61a7f398b372dda5f4831` | stop |
| invalid-4 | whitespace_corrupted_prompt | **true** | `b24d5bab87b3aa8138ab0d8a5822adfce30049a2e17fcad7eed188f94c752c38` | `714f4720985f6db0bfbc5112058f1033382096a4e52c5dc763ceeaf872a2ce8b` | aborted |
| invalid-5 | whitespace_corrupted_prompt | **true** | `bf98b81fde03a5446ccb25eb3ebb74ed408a106aedffa8b395778240dd49ddce` | `714f4720985f6db0bfbc5112058f1033382096a4e52c5dc763ceeaf872a2ce8b` | aborted |
| invalid-6 | whitespace_corrupted_prompt | false | `48a0626572ab4c5b61f2c9725b8b978cc384e45fc9d1a0365787928e113b2e5a` | `714f4720985f6db0bfbc5112058f1033382096a4e52c5dc763ceeaf872a2ce8b` | stop |
| invalid-7 | whitespace_corrupted_prompt | false | `403a4911d7ac678459bdff147d1115324886723896f17b17a9caa00bad431265` | `714f4720985f6db0bfbc5112058f1033382096a4e52c5dc763ceeaf872a2ce8b` | stop |
| invalid-8 | whitespace_corrupted_prompt | false | `49a3305e2c75ae175f2bbadc81b5a673b82abdd68518660d315a948e64b12505` | `714f4720985f6db0bfbc5112058f1033382096a4e52c5dc763ceeaf872a2ce8b` | stop |

Exactly **invalid-4 and invalid-5** are machine-observably aborted; the
other six ended with a terminal `stop`. The first failed prep run
(`20260806-115823-m5by`) is the recorded evidence of the expectation
mismatch that was root-fixed before the successful preparation.

**The corrected three sessions (`final-current-1..3`) were collected only
after the failed attempts were observed, so they are a disclosed
supplemental/post-deviation cohort and MUST NOT be presented as the
pristine preregistered cohort or as causal evidence.** The strict manifest
declares exactly the three pinned P3 pre sessions (baseline) plus these
three corrected sessions (current); the analyzer enforced byte-identity of
every declared session, the frozen extracted-text prompt hash, the pinned
environment (`openai-codex/gpt-5.6-sol`, thinking `high`), and zero
compactions (protocol §3.5 fail-closed conditions).

---

## 4. Per-run machine facts (all six runs; nothing excluded)

Exact values from the analyzer JSON (`20260806-120523-gy65`); gross =
input + output + cacheRead + cacheWrite; successful inline bytes = UTF-8
tool-result text bytes of toolResult messages not marked `isError` (total
and successful figures are identical for every run — zero error-marked
tool results; per-tool breakdowns are in the analyzer JSON).

| Run | Cohort | Requests | Input | Output | CacheRead | Gross | Successful inline bytes | Cost (USD) | Compactions | Session SHA-256 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pre-1 | baseline | 3 | 22,533 | 773 | 15,872 | 39,178 | 46,425 | 0.143791 | 0 | `08b7467e3945b913d8a7e5f81cb890cc057078ed6b50973f7d4dff4c3f5744ec` |
| pre-2 | baseline | 2 | 8,285 | 762 | 4,608 | 13,655 | 5,584 | 0.066589 | 0 | `a245d51db3a030f69028af82d80ffdfb3870c9ef68c099d43b3d7df2c331a899` |
| pre-3 | baseline | 3 | 22,886 | 865 | 15,872 | 39,623 | 47,090 | 0.148316 | 0 | `93aad011fbccd7b60b380f4825c3b4d9ebb753c1fe91da424a17b412b5cd677b` |
| final-current-1 | current | 3 | 30,381 | 1,148 | 2,560 | 34,089 | 54,812 | 0.187625 | 0 | `c4ab12123ce7123e0c2516d7992747b71dc00ed19d8c7cfca72b64cee7d714aa` |
| final-current-2 | current | 4 | 20,276 | 1,103 | 22,016 | 43,395 | 64,917 | 0.145478 | 0 | `901b6015c7649d928c219f32c7cd065a9e5f1250af78f87194624d0870d60092` |
| final-current-3 | current | 3 | 17,821 | 1,073 | 12,800 | 31,694 | 47,159 | 0.127695 | 0 | `74e3051766888fc07b689f246d3902a74305ccff3a18f511358390b4358273b7` |

Every run: prompt SHA-256 `01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f`
(`promptMatches: true`), model key `openai-codex/gpt-5.6-sol`, thinking
`high`, `cacheWrite` 0. Baseline session hashes reproduce the pinned
preserved P3 pre hashes byte-for-byte (protocol §2.4). Session files:
`.pi/workbench/runs/commander-token-p3-benchmark/sessions/pre-<N>/<basename>.jsonl`
(baseline) and
`.pi/workbench/runs/commander-token-p9-benchmark/sessions/final-current-<N>/<basename>.jsonl`
(current), with basenames recorded in the manifest.

---

## 5. Cohort totals, target table, and verdict arithmetic

### 5.1 Cohort totals (machine sums)

| Quantity (cohort totals) | baseline (pre-1..3) | current (final-current-1..3) |
| --- | --- | --- |
| Requests | **8** | **10** |
| Gross tokens | **92,456** | **109,178** |
| Successful inline bytes | **99,099** | **166,888** |
| Tool-result entries (all successful) | 17 | 25 |
| Cost (USD, descriptive) | **0.358696** | **0.460798** |
| Compactions | 0 | 0 |

### 5.2 Aspirational target table (§10.2, measured-or-not)

| Target (§10.2) | Comparison basis | Pre | Current | Reduction ratio | Threshold | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Commander requests | P0 reference | 187 (P0 session) | — | `null` | ≥ 25% | **NOT_MEASURABLE** (basis-incomparable: P0 is one long-lived session; no comparable short-cohort sum is derived) |
| Successful tool-result inline bytes | P0 reference | 3,276,725 (P0 total; no isError split) | — | `null` | ≥ 80% | **NOT_MEASURABLE** (basis-incomparable: P0 has no successful-bytes denominator) |
| Commander gross tokens | P0 reference | 23,603,500 (P0 session) | — | `null` | ≥ 40% | **NOT_MEASURABLE** (basis-incomparable) |
| Commander requests | comparable (pinned P3 pre vs corrected supplemental/post-deviation final-current, equal n=3) | 8 | 10 | **−25%** | ≥ 25% | **MISSED** |
| Successful tool-result inline bytes | comparable | 99,099 | 166,888 | **−68.40533204169568%** | ≥ 80% | **MISSED** |
| Commander gross tokens | comparable | 92,456 | 109,178 | **−18.08644111793718%** | ≥ 40% | **MISSED** |

- Ratios are exact analyzer arithmetic `(pre − current) / pre` on
  equal-size cohort totals; classifications carry the machine reasons in
  the analyzer JSON. Comparable arithmetic is **historical
  comparable-cohort arithmetic — non-causal, not strict P0 measurement**
  (protocol §3.4).
- **Every current sample is retained; no cherry-picking** (all three
  final-current sessions declared, including final-current-2's 4 requests).
- **No P0 ratio or savings claim is formed**: the strict P0 targets are
  frozen NOT_MEASURABLE and never produce a classification.
- **Historical P3 preserved**: pre 8 vs current 8, reduction **0.0**,
  verdict **FAIL** under the frozen rule `PASS only if current total
  requests < pre total requests` (`docs/baselines/commander-token-p3.md`),
  accepted as non-blocking without redefining or rerunning the rule;
  combined Slice B (P2+P3) remains **NOT PASS** as an optimization exit.

---

## 6. §9 quality matrix — all 11 rows PASS

Every row is release-blocking at P9 (plan §9). Evidence: the cited test
suites within the Commander runs of §2.2, the review records of §2.1, and
the gate run `20260806-120856-frol` with its recorded manual evidence.

| # | Scenario | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Green 825-test summary | **PASS** | `tests/result-summary.test.ts` + `tests/result-summary-wiring.test.ts`: successful summaries bounded to the §8 success caps with full-log paths, no full log inlined (exact/minimum caps, omission facts). Runs: unit `20260806-120252-a1up` 1183/1183; check `20260806-120618-qwxe`. |
| 2 | Failed tests | **PASS** | Same suites, failure paths: status/exit first, failing-test names, first root cause, bottom-up truncation, full log path. Gate manual evidence b2.3 of `20260806-120856-frol` records fail-closed error-path coverage. |
| 3 | Warning-with-exit-0 | **PASS** | Same suites: warning count surfaced at exit 0, clean vs. warning success distinguished. Gate `20260806-120856-frol` b1.1 surfaced its "recipe wrote to stderr" warning while passing. |
| 4 | Large segmented diff | **PASS** | `tests/diff-review.test.ts` + `tests/diff-review-wiring.test.ts`: coverage-gated segmented review, whole-diff hash binding, displayed_paths/remaining_paths/coverage_complete, hash-change reset, fail-closed demotion. All three review records (§2.1) have `coverage_complete: true` and `remaining_paths: []`. |
| 5 | Hidden out-of-scope path | **PASS** | Same suites: scope FAIL invalidates REVIEWED fail-closed, machine-checked, never prose-satisfiable. All three review records: `mismatch: false`, `drift_paths: []`, `violations: []`. |
| 6 | Stale hash | **PASS** | `tests/validation-evidence.test.ts`, `tests/validation-assessment.test.ts`, `tests/p4-compare.test.ts`: REUSABLE only on exact binding; diff/commit drift, missing/legacy/corrupt bindings refuse reuse (RERUN_REQUIRED fail-closed). |
| 7 | Changed config/dependency invalidation | **PASS** | `tests/validation-evidence.test.ts`: every lockfile add/change/remove invalidates dependencies; every workbench config file change invalidates config; gate-state, recipe-target, profile and mode changes refuse reuse. |
| 8 | WebSocket recovery | **PASS (exact P8 boundary)** | `tests/tool-result-recovery.test.ts` + `tests/p8-recovery-wiring.test.ts`: persist-first `wtr1` receipt lifecycle (begin/finalize/recover), repeated-recover byte/mtime invariance, missing/invalid-ID and forged-handle fail-closed, parallel same-id replay fail-closed. P8 review `20260806-081008-l7na` PASS at hash `3e4189b9…`; runs `20260806-081059-rlxw`, `20260806-081106-6ykl` 1122/1122, `20260806-081321-gk7a` 1122/1122, `20260806-081834-p6lf` b0-b6. **Boundary: persist-first tool-result recovery/replay is verified across fresh runtime/resume with the SAME valid native Pi session identity (deterministic receipt id = bounded native session identity + toolCallId); this repository implements no WebSocket (or any other) transport and no cross-different-session-ID recovery is claimed.** |
| 9 | Commander soft/high behavior | **PASS** | `tests/commander-advisory.test.ts` + `tests/commander-advisory-wiring.test.ts` + `tests/p5-command-guard.test.ts`: advisory warnings fire at configured thresholds, zero hard-stop paths; review/fixes/verification/handoff/user response never killed (P7, plan §13 row 4). |
| 10 | Legacy records | **PASS** | `tests/run-result.test.ts` (legacy records without optional fields render identically), `tests/validation-evidence.test.ts` (legacy/unavailable bindings refuse reuse, never rewritten), `tests/tool-result-recovery.test.ts` (legacy unknown-schema receipts fail closed, never migrated); additive-only data rule. |
| 11 | Unchanged Worker standard default | **PASS** | `tests/worker-budget.test.ts` (pinned 1,000,000 context, 80% soft / 90% hard, `standard` default), `tests/worker-spend.test.ts`, `tests/worker-policy.test.ts` (delegation semantics unchanged); `docs/plans/worker-token-budget-repair.md` untouched; b6 worker-first facts in `20260806-120856-frol`. |

---

## 7. §10.1 release-blocking criteria — all 9 PASS

| # | Criterion (§10.1) | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Every §9 matrix row passes with recorded recipe/gate evidence | **PASS** | §6 mapping; no-cache check `20260806-120618-qwxe` 1183/1183; all-gate run `20260806-120856-frol` b0-b6 PASS with manual evidence. |
| 2 | Every §4 immutable constraint holds, verified against the actual diff and machine-backed checks (B6-style) | **PASS** | Three review records (§2.1) with zero violations; b6 machine-injected facts in `20260806-120856-frol` (policy active, hard denial, reviewed hash equals current diff hash, lease locked). |
| 3 | Complete logs/reports/patch sources persisted and path-referenced (§4.5) | **PASS** | Per-run manifests/summaries/stdout/stderr under `.pi/workbench/runs/…`; review records with `review_path`; prepare run `20260806-120518-y8xy` artifact_paths; full analyzer JSON at `.pi/workbench/runs/20260806-120523-gy65/stdout.log`. |
| 4 | Whole-diff scope check + hash binding for every reviewed slice (§4.3) | **PASS** | Prior Slice A–D reviewed delegations with their bound hashes are recorded in plan §13 rows 1–4; the three closing review records (§2.1) cover P8/P9: `20260806-081008-l7na` (1/1 path), `20260806-095638-fu5o` (3/3 paths), `20260806-115923-zjyf` (2/2 paths): all `coverage_complete: true`, `mismatch: false`, `drift_paths: []`. |
| 5 | No hard-stop path for commander budgets (§4.6) | **PASS** | Advisory-only contract (§6 P7) verified in `tests/commander-advisory*.test.ts`; zero hard-stop paths. |
| 6 | Cache remains enabled; cache-telemetry guarantees hold (§4.7) | **PASS** | No change disables/bypasses caching; cache suites (`tests/p6-b-stable-prefix.test.ts`, `tests/p6-c-*.test.ts`, `tests/p6-d-*.test.ts`) pass within `20260806-120618-qwxe`; P4/P6-C independence verified (plan §13 row 3). |
| 7 | Worker delegation semantics unchanged; worker-repair plan untouched (§4.1) | **PASS** | `tests/worker-policy.test.ts`, `tests/worker-runner.test.ts` unchanged and passing; `docs/plans/worker-token-budget-repair.md` untouched; b6. |
| 8 | P9 benchmark recorded against the P0 baseline with targets reported as measured-or-not (§11.2) | **PASS** | This record; frozen protocol; analyzer JSON `20260806-120523-gy65` (P0 targets NOT_MEASURABLE with fixed reasons; comparable targets MISSED with machine reasons); never claimed before measurement. |
| 9 | Rollback/stop conditions (§11) documented as not triggered | **PASS** | §8 below; plan §13 row 8. |

**P6 remains `NOT_SCHEDULED`** and does not block P9: its capability gate
requires a verified Pi capability to observe/optimize the commander
compaction summary plus a Sol-approved design (plan §6, §7 Slice E); that
prerequisite is absent, so no P6 implementation, design, or capability
claim exists, and P9 proceeded without it.

---

## 8. Rollback/stop-condition review (§11)

- The transient prep expectation mismatch was **stopped** at the first real
  prep (`20260806-115823-m5by` failed before any artifacts — no partial
  outputs, no source/evidence/cache/Worker-semantics loss), **root-fixed**
  (terminal-expectation table corrected to require exactly `invalid-4` and
  `invalid-5` aborted; delegation `20260806-115923-zjyf`), **re-reviewed**
  (review PASS at hash `4429cf9e…`), and **reverified** (typecheck
  `20260806-120244-1fy2`, unit-test `20260806-120252-a1up` 1183/1183,
  no-cache check `20260806-120618-qwxe` 1183/1183, gates
  `20260806-120856-frol` b0-b6 PASS).
- **No §4 constraint violation and no §9 regression remains active.**
- P6 stays **NOT_SCHEDULED** (its capability gate is the §11 stop
  condition that resolves to NOT_SCHEDULED; it never halts other phases
  and does not block P9).
- **At verdict time there is no active rollback/stop condition.**

---

## 9. Limitations and non-claims

- **No causal claim.** The comparable arithmetic is historical
  comparable-cohort arithmetic between the pinned P3 pre cohort and the
  disclosed post-deviation current cohort; it attributes nothing.
- **P0 is not a comparison basis.** P0 is one long-lived commander session
  (187 requests, 23,603,500 gross tokens); every strict P0 target is
  frozen NOT_MEASURABLE and no classification is derived from comparing
  short-cohort sums against P0. P0's byte fact (3,276,725) has no isError
  split, so it is never a successful-bytes denominator.
- **Collection deviation.** The current cohort is a disclosed
  supplemental/post-deviation cohort, not the pristine preregistered
  cohort; all 8 invalid attempts are preserved and disclosed (§3); no
  causal or optimization effect is attributed to any change.
- **Small cohorts.** n = 3 per arm; no statistical power claimed.
- **Environment-specific.** P3 environment pinned (`openai-codex` /
  `gpt-5.6-sol`, thinking high, Pi 0.83.0, Node v26.4.0); re-measurement
  on other versions is not directly comparable.
- **All targets missed or unmeasurable; no savings claim.** Strict P0
  targets NOT_MEASURABLE; supplemental comparable targets MISSED (requests
  −25%, bytes −68.40533204169568%, gross −18.08644111793718%); historical
  P3 0.0 FAIL preserved; costs (0.358696 → 0.460798) are descriptive only.
- **No P9/§10.2 success claim.** The verdict is a §10.1 release-quality
  verdict, not a token-savings or optimization-success claim.
- **P6 NOT_SCHEDULED**; no P6 capability/design claim.
- **P8 boundary.** No WebSocket transport claim; recovery/replay claimed
  only with the same valid native Pi session identity.
- **No publication.** No publish/tag/commit/release action occurred.

---

## 10. Re-derivation

The durable artifacts are the source of truth; this record must reproduce
from them:

1. **Manifest:** read `.pi/workbench/runs/commander-token-p9-manifest.json`;
   verify schema_version 1, the pinned P0/P3 references, the frozen prompt
   hash `01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f`,
   the environment (`openai-codex/gpt-5.6-sol`, thinking `high`), and
   exactly 3 baseline + 3 current sessions with their expected hashes.
2. **Analyzer rerun:** `npm run commander:benchmark -- .pi/workbench/runs/commander-token-p9-manifest.json --json`
   must exit 0 and produce JSON deterministically identical to
   `.pi/workbench/runs/20260806-120523-gy65/stdout.log` (session hashes,
   prompt hashes, counts, targets, statuses).
3. **Session byte-identity:** `sha256sum` the six declared session files
   and compare to §4 (baseline must reproduce the pinned preserved P3 pre
   hashes; current must match the manifest's collection-time hashes).
4. **Deviations:** verify `collection-deviations.json` against the eight
   files under `commander-token-p9-benchmark/invalid-attempts/` (categories,
   exactly invalid-4/invalid-5 aborted, raw/prompt hashes).
5. **Cohort arithmetic:** recompute totals (requests 8/10; gross
   92,456/109,178; successful bytes 99,099/166,888; cost 0.358696/0.460798)
   and the ratios (−25%, −68.40533204169568%, −18.08644111793718%).
6. **Run/review records:** read the manifests/summaries of every run in
   §2.2 (exit codes, counts, bound diff hashes) and the three review
   records in §2.1 (verdicts, bound hashes, coverage facts); confirm the
   b6 facts and manual evidence in `20260806-120856-frol`.

---

## 11. Deliberately not done / next step

**Deliberately not done (no claim of completion):**

- P6 compaction-summary optimization — remains NOT_SCHEDULED (no verified
  Pi capability, no Sol-approved design).
- No WebSocket (or any other) transport implementation; no
  cross-different-session-ID recovery claim.
- No re-collection of a pristine preregistered cohort — the corrected
  sessions are the disclosed supplemental/post-deviation cohort (§3).
- No rerun or redefinition of the frozen P3 rule; the P3 0.0 FAIL stays
  recorded; combined Slice B remains NOT PASS.
- No P0-ratio or savings claim; no publish/tag/commit/release.

**Next step (required, commander-owned):** this documentation
synchronization (this record + the plan status update) changes the diff
hash, so **fresh Commander-owned no-cache `check` and gates on the new diff
are required**. Their run IDs are **not yet resolved** and must be read
from later workbench records — nothing in this record claims they have
already run. The Sol verdict recorded here is based on `20260806-120618-qwxe`
and `20260806-120856-frol`; **any post-sync failure reopens the verdict**.
