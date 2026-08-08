# Commander Token Optimization — Durable Implementation Plan

| Field | Value |
| --- | --- |
| Status | **P8 PASS; P9 PASS; FINAL RELEASE-QUALITY EXIT PASS (UNDER §10.1); P6 NOT_SCHEDULED (CAPABILITY-GATED); COMBINED SLICE B EXIT NOT PASS (NON-BLOCKING) — ALL PHASES CLOSED** (current status; §13 rows 1–4 are point-in-time phase history and rows 5–8 carry the current status; the Sol verdict is recorded in `docs/baselines/commander-token-p9.md`. The verdict `P9 PASS` / `FINAL RELEASE-QUALITY EXIT PASS` is governed by §10.1 only — §10.2 targets are expressly non-release-blocking; all three strict P0 targets are NOT_MEASURABLE on the frozen basis-incomparability grounds and all three supplemental comparable-milestone targets are MISSED; the historical P3 measured FAIL (8→8, reduction 0.0) stays recorded; no token-savings or optimization-success claim is made; no publish/tag/commit/release action occurred. This documentation synchronization changes the diff hash, so fresh Commander-owned no-cache `check`/gates on the new diff remain required and any post-sync failure reopens the verdict — their future run IDs are not yet resolved and are never pre-filled. Historical phase summary follows: Slice A is PASS: the final full `check` run `20260805-141013-i4lx` passed 879/879 and the Commander gates run `20260805-141242-tyt8` passed b0-b6; the P0 baseline and the observational P1 inline-byte comparison are recorded in the baseline record — 2 calls / 1779 bytes, 889.5 vs 19125.7 bytes/call, 95.35% observational with cohort limitations in the record; the rollback/stop-condition review is COMPLETE at the Slice A boundary — no stop condition remains active. Slice B1 targeted verification is COMPLETE: `typecheck` `20260805-151436-pvaw` PASS and `unit-test` `20260805-151445-9x5v` PASS 909/909. Slice B2 actual-diff review is COMPLETE: delegation `20260805-153326-fgpg` received coverage-complete review PASS at bound hash `a74df139c60c2cd97e0beff911f222315432db86dc350d63ac35e1b69208b95b` (8/8 displayed); fresh targeted verification is COMPLETE: `typecheck` `20260805-155137-at02` PASS and `unit-test` `20260805-155143-oy4g` PASS 925/925. The Commander final verification is COMPLETE against the reviewed hash `c1b1e47a6b65322cbbf699d419e5db8b134ffbcba20561e245f84ae9f13b7690`: full `check` run `20260805-155633-j420` PASS 925/925 and Commander gates run `20260805-160158-udt6` PASS b0-b6, both run after the prior documentation synchronization on that reviewed hash. P2's quality/implementation exit is PASS (layered run output plus the coverage-gated complete-scope/hash behavior and the current verification). P3's static batching policy implementation is verified, but the P3 measured phase exit is FAIL: the comparable-milestone benchmark record `docs/baselines/commander-token-p3.md` measured pre total 8 vs current total 8 commander requests (reduction 0.0) under the frozen rule 'PASS only if current total requests < pre total requests' — so the combined Slice B P2+P3 exit is NOT PASS, and no causal or overall token savings are claimed; the §2 snapshot remains a point-in-time observation only. P3 is now closed/completed with this measured FAIL accepted as non-blocking: consistent with §10.2's non-release-blocking target policy, the user accepted the measured miss rather than weakening or rerunning the frozen strict-less-than rule — the acceptance authorizes downstream execution but does not erase the miss and permits no savings claim. Slice C (P4) is therefore PASS: the focused P4/P6-C action-cache independence separation delegation `20260805-231448-yv3u` (only worker path `tests/p6-c-action-cache.test.ts`) received Sol actual-diff review PASS with complete displayed-path coverage at the reviewed/current bound hash `4d1325ffdcc10ab6825847e0edb010622bfa92c909d113d3efde2e852fcf89eb`; Commander no-cache verification is COMPLETE on the current diff: `typecheck` `20260805-232823-jwoq` exit 0, `unit-test` `20260805-232832-we0r` 1059/1059 exit 0, full `check` `20260805-233043-3v8c` 1059/1059 exit 0, and the all-gate run `20260805-233326-t3w6` PASS b0-b6 with the required manual evidence recorded (see §13 row 3). The P4/P6-C independence proof: the registered read/assessment leaves action key, cache store, and execution counter semantics unchanged; no-cache/refresh/failure behavior and the next explicit same-key hit remain normal. P4 does not use or trust P3's batching functionality. The Slice C documentation-synchronization delegation `20260805-233348-ad7n` (plan document only) received Sol actual-diff review PASS at bound hash `ce6a7ed35c106d6000209cf839d5c240feb33e8e1e9d70df2c929904b4bed864`, followed by Commander current-diff verification COMPLETE on that reviewed hash: `typecheck` `20260805-233712-kgzo` exit 0, `unit-test` `20260805-233718-ioq5` 1059/1059 exit 0, full `check` `20260805-233930-ytck` 1059/1059 exit 0, and the all-gate run `20260805-234159-uu94` PASS b0-b6 with the required manual evidence recorded — Slice C/P4 is fully closed (see §13 row 3); P5 is unblocked and is PASS (see §13 row 4). Slice D's P7 commander advisory portion is PASS: the P7 source/config/footer/`/q-cost-status`/tests/docs work is implemented and the advisory-only/no-hard-stop contract is verified; actual-diff review of the latest implementation/docs delegation `20260805-165159-baee` is PASS with complete coverage (no current diff hash is pinned in prose because this documentation write changes it); final targeted verification is COMPLETE: `typecheck` run `20260805-165951-cbyr` PASS and `unit-test` run `20260805-170000-uxif` PASS 978/978; final full verification is COMPLETE: `check` run `20260805-170224-xxp8` PASS 978/978 and Commander gates run `20260805-170509-y7re` PASS b0-b6. Recovery incident: the initial P7 delegation `20260805-161430-kiu5` left `index.ts` at zero bytes; the exact pre-delegation content was recovered to SHA-256 `606a11c2c774cde86fde2dd25abed425cdf9eb87a6d9e73ee315aed1ff1de7a1` before P7 completion — recovery record only, no HEAD restore implied. Slice D (P5+P7) is PASS: the P5 milestone lifecycle portion is PASS — the read-only gap diagnosis `20260805-234450-dmpg` (no project changes, reviewed PASS), the first implementation `20260805-235827-myfz` with actual-diff review PASS and complete coverage at hash `d03984b95f83aeaa1cefc3575d8c7926ad63ef8eabaec791b10bcba4ab34932a`, the Sol-found privacy/state/docs defect repair `20260806-001818-wii9` with actual-diff review PASS and complete coverage at the final implementation hash `62b2066ebe047298cd8964cebc83d19bd6c564e3f9ee08a0f75d152dec5ee5ad`, and Commander verification COMPLETE against that reviewed hash: `typecheck` `20260806-003235-srpw` exit 0, `unit-test` `20260806-003242-2eja` 1078/1078 exit 0, full `check` `20260806-003458-25rd` 1078/1078 exit 0, and the all-gate run `20260806-003754-6lri` PASS b0-b6 with the required manual evidence recorded (bounded P5 behavior summary in §13 row 4) — so the combined Slice D exit was PASS at that time (point-in-time history as of Slice D completion; superseded by rows 5–8). P8 and P9 have since PASSED and the FINAL RELEASE-QUALITY EXIT PASS is recorded — verdict and evidence in `docs/baselines/commander-token-p9.md`, see §13 rows 5/7/8) |
| Slice A baseline/comparison | Recorded in `docs/baselines/commander-token-p0.md` — exact P0 snapshot (captured after a fresh `/reload`) plus the observational P1 inline-byte comparison, with re-derivation source and cohort limitations in the record |
| Plan date | 2026-08-05 |
| Last status update | 2026-08-06 — P9 verdict recorded: P9 PASS; FINAL RELEASE-QUALITY EXIT PASS under §10.1 (see `docs/baselines/commander-token-p9.md`; §13 rows 5/7/8) |
| Repository | pi-dev-workbench (`/home/hanbaoji/Projects/pi-vibing-seriously`) |
| Git state at plan creation | `main` @ `aa2301763d95` (informational snapshot only — every execution must re-check live git state; never treat this as evidence) |
| Owner | GPT-5.6 Sol commander (requirements, architecture, review, gates, verdict) |
| Executor | Fresh bounded DeepSeek workers, one bounded slice per delegation (worker spend profile per the active worker-token repair plan) |
| Scope | Reduce commander-session token consumption (calls, inline bytes, repeated context, duplicate verification, long-session accumulation, WebSocket payload risk) **without** reducing requirements, evidence, actual-diff review, or final verification. Documentation + phased implementation; see §5. |

This document is the durable contract for the user-approved Commander Token
optimization. It is self-contained: a brand-new Pi session can execute it
without access to any earlier conversation. It records the audited snapshot
(as an observed snapshot, not a permanent benchmark), the governing
objective, the immutable quality constraints, scope and non-goals, the
P0–P9 phases with dependencies, bounded implementation slices A–E, the
output-summary policy (inline caps + failure-information precedence), the
quality verification matrix, release-blocking acceptance criteria vs.
aspirational benchmark targets, rollback/stop conditions, and dynamic
evidence-placeholder discipline. It is a companion to, and does **not**
modify, `docs/plans/worker-token-budget-repair.md`: every constraint that
plan pins for worker delegations remains in force (§4).

---

## 1. Problem

The commander session (GPT-5.6 Sol in the workbench) is the longest-lived,
highest-context session in the project. At the audited snapshot its token
consumption was dominated by: repeated commander tool calls that re-read or
re-fetch the same content; tool results inlined in full into context
(recipe/gate logs, run records, diffs, file reads); duplicate verification
calls over unchanged state; context accumulation across a long multi-slice
session (with three compactions); and large inline payloads that also raise
WebSocket payload risk on the live session. None of this is bounded or even
observable today at the commander level: the cumulative spend-budget repair
(`worker-token-budget-repair.md`) protects worker children only, and the
commander session has no cumulative observability and no inline-output
policy.

## 2. Audited snapshot (observed — not a permanent benchmark)

Observed at the audited snapshot of the commander session; approximate
values as recorded at that time. **This table is a point-in-time
observation, not a release benchmark**: exact values must be re-derived at
P0 (§6) and re-measured at P9 against the P0 baseline; the snapshot exists
only to size the problem and to sanity-check P9 movement.

| Metric (commander session, audited snapshot) | Observed value |
| --- | --- |
| Commander requests (turns) | ≈ 108 |
| Gross tokens (billed, all kinds) | ≈ 14.16M |
| cacheRead share of gross tokens | ≈ 93.1% |
| Compactions (commander session) | 3 |
| Estimated cost | ≈ $12.83 |

Attribution at the snapshot was not yet decomposed by cause (inline tool
bytes vs. repeated context vs. verification duplication); P0 adds numeric
and per-tool-category byte attribution. Until P0 lands, no reduction claim
may cite these numbers as a baseline.

## 3. Governing objective

Reduce, in order of leverage: (1) the number of commander calls,
(2) inlined tool-result bytes, (3) repeated context (re-reads, re-fetches,
post-compaction re-loads), (4) duplicate verification over unchanged state,
(5) long-session accumulation, and (6) WebSocket payload risk — **never at
the expense of** requirements, evidence, actual-diff review, or final
verification. Every optimization must keep the full evidence trail
persisted and reviewable; summaries are presentation, not evidence.

## 4. Immutable quality constraints (non-regression contract)

These bind every phase and slice; a change that violates any of them is
rejected at review regardless of token savings.

1. **Worker default stays `standard`**; all current Worker context-budget
   (800k/900k) and cumulative spend-budget (low/standard/extended)
   profiles, thresholds, defaults, and semantics remain **unchanged**
   (per `worker-token-budget-repair.md`; its Phase 6 remains deferred).
2. **Worker-first authority remains**: one writing worker per worktree;
   workers run only write-free declared recipes; worker prose is never
   acceptance; only Sol maps evidence to criteria and gives the verdict.
3. **Sol reviews the complete actual diff**: display may be segmented, but
   the whole-diff scope check (every changed path vs. parent-approved
   paths) and whole-diff hash binding are mandatory; no segment may be
   skipped, and segmentation never replaces whole-diff verification.
4. **Final check/gates remain commander-owned**: `check`, `typecheck`,
   `unit-test`, base gates and B6 in VERIFY are run by Sol; workers never
   run final gates and never claim PASS.
5. **Complete logs/reports/patch sources remain persisted**: inline
   summaries may shrink, but the full artifacts (run logs, reports,
   patches, ledger records) are always written and referenced by path.
6. **Commander budgets are advisory only**: soft/high thresholds warn and
   steer; they **never hard-kill** review, fixes, verification, handoff, or
   user response (P7).
7. **Cache remains enabled**: no change disables or bypasses prompt
   caching; stable-prefix discipline and cache-telemetry guarantees stay.
8. **Reasoning-effort / adaptive-reasoning adaptation remains deferred**
   pending provider capability evidence (mirrors the worker repair's
   Phase 6 decision gate); no adaptive-reasoning support is claimed by
   this plan.

## 5. Scope

### 5.1 In scope

- Numeric baseline tooling and per-category attribution of commander token
  and byte consumption (P0).
- Inline output-summary policy for recipe/gate/run/diff/tool results with
  bounded summaries, failure-first ordering, and full-log path references
  (P1, P2).
- Batching of independent read-only commander calls (P3).
- Validation deduplication with strict evidence invalidation (P4).
- Milestone session/handoff lifecycle and commander cumulative
  observability with advisory soft/high budgets (P5, P7).
- Compaction-summary optimization **only behind a verified Pi capability
  gate** (P6) and WebSocket recovery via persist-first IDs (P8).
- Final benchmark and quality non-regression verdict (P9).

### 5.2 Out of scope (non-goals)

- Any change to Worker budget profiles, defaults, context safety, or
  delegation semantics (constraint §4.1).
- Any hard stop or enforcement on commander spend (advisory only).
- Disabling, bypassing, or re-plumbing prompt caching.
- Any change to requirements, evidence persistence, actual-diff review, or
  final verification (the objective's inviolables).
- Adaptive reasoning / reasoning-effort control (deferred, §4.8).
- Cost enforcement, per-user/per-project commander billing, or ledger
  migration/rewrite of existing records (additive-only data).
- Rewriting `docs/plans/worker-token-budget-repair.md` or its recorded
  evidence.
- New background processes, daemons, queues, or sandboxes; unchanged
  pi-native architecture.

## 6. Phases P0–P9

Phases land in order; a phase's exit condition is commander-judged from
recipe/gate evidence and the actual diff — never from worker prose.
Dependencies are listed per phase; see §6.1 for the graph.

| Phase | Goal | Dependency | Exit condition (evidence) |
| --- | --- | --- | --- |
| **P0** | Numeric/tool-byte baseline and attribution: exact commander request count, gross tokens, cacheRead share, compactions, cost, and per-tool-category inline-byte attribution (read/grep/find/ls, recipe summaries, run-log excerpts, diff views); re-derive §2 exactly; record as the P0 baseline record with re-derivation instructions | none (start) | Baseline record written; attribution table reproducible from persisted Pi Session JSONL/session entries (required for per-tool inline text-byte attribution) with telemetry/run records as token/run evidence — telemetry/run records alone cannot reproduce inline content bytes |
| **P1** | Successful recipe/gate summaries with bounded failure-first output and full logs: success summaries ≤ caps (§9) + full-log path; failures use §9 precedence; summaries never replace persisted logs | P0 | Summary policy enforced for recipe/gate results; inline bytes for successful runs measurably below P0 attribution |
| **P2** | Layered run/diff/tool results with whole-diff scope guarantees: summary → evidence → persisted layer; segmented display allowed; whole-diff scope check + hash binding mandatory | P1 | Layering enforced; whole-diff check/hash binding present for every diff review |
| **P3** | Fewer commander calls through independent read-only batching: batch independent read-only tool calls per turn; batch responses honor §9 caps | P0, P1 | Commander request count per comparable milestone measurably reduced vs. P0 |
| **P4** | Validation deduplication with strict evidence invalidation: reuse prior validation evidence only while bound hashes and config/dependency/gate state are unchanged; any diff/commit/dependency/config/gate change invalidates cached evidence and forces re-run | P2, P3 | Invalidation matrix (§10 rows 6–7) passes; no stale evidence reused |
| **P5** | Milestone session/handoff lifecycle: bounded milestone handoff notes, session-resume state, and handoff points so long sessions stop accumulating silently | P1–P4 | Handoff/session-resume records persisted; post-handoff sessions resume from persisted state without full re-reads |
| **P6** | Compaction-summary optimization behind a verified Pi capability gate: no implementation until Sol verifies Pi capability to observe/optimize the commander compaction summary without regressing cache stability, fail-closed behavior, or §4 constraints, and approves a fresh design | P5 | Gate: capability verification record + Sol-approved design; without it, P6 stays NOT_SCHEDULED (like the worker repair's Phase 6) |
| **P7** | Commander cumulative observability: cumulative commander-session spend observability with configurable observation-first soft/high advisory thresholds; **no hard stop ever**; warnings never kill review, fixes, verification, handoff, or user response | P0 | Soft/high warnings fire at configured thresholds; zero hard-stop paths exist; §10 row 9 passes |
| **P8** | WebSocket recovery through persist-first IDs: durable IDs for runs/diffs/tools/results so reconnect/recovery reuses persisted artifacts by ID instead of re-fetching/re-inlining; fail-closed on missing IDs | P5, P7 | Recovery reuses persisted artifacts; no duplicate inlining after reconnect; missing-ID fail-closed tested |
| **P9** | Final benchmark and quality non-regression verdict: re-measure §2 metrics vs. P0 on comparable milestones; report aspirational targets (§11.2) as measured-or-not; run the full §10 matrix and §11.1 release-blocking criteria; Sol gives the verdict | all of P0–P8 | Benchmark report + quality matrix evidence recorded; Sol verdict issued |

### 6.1 Dependency graph

```
P0 ──► P1 ──► P2 ──► P3 ──► P4 ──► P5 ──► P6 (capability gate; may stay NOT_SCHEDULED)
                                  │
P0 ──► P7 ────────────────────────┴──► P8 ──► P9
```

P7 may proceed in parallel with P3–P5 once P0 lands; P6 is gated and never
blocks other phases; P9 requires everything else.

The P2→P3→P4 dependency edges are preserved as the plan graph, but P3 is
closed/completed with its measured FAIL (0.0 request reduction) accepted as
non-blocking under §10.2's non-release-blocking target policy: the FAIL
stays recorded, the frozen measurement rule is neither weakened nor rerun,
and P4 does not use or trust P3's batching functionality. P4 is therefore
PASS (see §13 row 3); P5 is PASS (see §13 row 4) — no longer
dependency-blocked by P4.

## 7. Bounded implementation slices A–E

Each slice is **one bounded worker delegation** (fresh worker, one coherent
vertical slice, source + tests + docs where applicable) followed by
**actual-diff review** (whole-diff scope check + hash binding, §4.3),
**targeted verification** (write-free declared recipes: `typecheck`,
`unit-test`; `check` is commander-owned), and **commander final gates**.
Exact allowed paths are fixed per delegation by Sol at delegation time —
never inferred from this document. Phases map to slices as shown; a slice
may be split only with Sol's approval, never unilaterally.

| Slice | Phases | Worker implementation | Actual-diff review | Targeted verification | Commander final gates |
| --- | --- | --- | --- | --- | --- |
| **A** | P0 + P1 | Baseline/attribution tooling (pure, numeric) + inline summary policy for recipe/gate results; unit tests; docs | Whole-diff scope + hash binding; no out-of-scope paths | `typecheck`, `unit-test` recipes; attribution reproducible | `check` recipe; gate review; exit P0/P1 |
| **B** | P2 + P3 | Layered result rendering + whole-diff scope/hash helpers; read-only batching policy for commander calls; tests; docs | Same, plus segmented-diff scenarios (§10 row 4) | `typecheck`, `unit-test`; batching determinism tests | `check` recipe; gate review; exit P2/P3 |
| **C** | P4 | Validation-evidence cache with strict invalidation keys (diff/commit hash, dependency lockfile, config, gate state); tests incl. §10 rows 6–7; docs | Same; stale-hash and config-change invalidation reviewed against the actual diff | `typecheck`, `unit-test`; invalidation matrix | `check` recipe; gate review; exit P4 |
| **D** | P5 + P7 | Milestone handoff/session-resume state + commander cumulative observability with configurable advisory soft/high thresholds (no hard stop); tests; docs | Same; advisory-only behavior reviewed (no enforcement path) | `typecheck`, `unit-test`; §10 rows 9, 11 | `check` recipe; gate review; exit P5/P7 |
| **E** | P8 (+ P6 if and only if its gate passes) + P9 prep | Persist-first ID recovery; P6 design only if gate passed and Sol approved; final benchmark harness; tests; docs | Same; WebSocket recovery and P6 gating reviewed | `typecheck`, `unit-test`; recovery tests | `check` recipe; gate review; then Sol runs P9 final benchmark + verdict |

Slice E's P6 work is **conditional**: if the §6 P6 capability gate has not
passed, Slice E excludes P6 and records it as NOT_SCHEDULED. P9's final
benchmark and verdict are commander-owned and are never part of a worker
delegation.

## 8. Output-summary policy (inline caps — starting values, configurable)

Starting policy for inline result summaries; values are **configurable
starting points, not constants** and are subject to the failure-information
precedence below (caps never truncate precedence items). Full logs are
always persisted and referenced by path.

| Context | Success cap (inline) | Failure cap (inline) |
| --- | --- | --- |
| Recipe/gate result summary | 4 KiB / 40 lines | 12 KiB / 120 lines |

- Failure summaries always carry the full log path even when the inline
  body is truncated.
- Summary content is machine-derived (status, counts, paths, hashes), not
  prose claims.
- Caps are per-result, measured in UTF-8 bytes and lines, code-point-safe.
- Any configuration change to the caps is itself a reviewed change (P4
  invalidation applies).

**Mandatory failure-information precedence** (order is fixed; earlier items
always appear before later ones, and caps truncate from the bottom of the
list, never the top):

1. Status / exit code (and which command).
2. Failing tests (names/count).
3. First root cause (first error/failure detail).
4. Timeout / cancelled (if applicable).
5. Warning count (warnings-with-exit-0 must be visible).
6. Full log paths (and any other persisted artifact paths).
7. Omission facts (what the summary does **not** contain, e.g. "log
   truncated at N KiB; full log at <path>").

## 9. Quality verification matrix

Every row is release-blocking at P9 (and relevant rows are targeted at the
slice indicated). Expected behavior is verified by commander-run recipes /
gates and actual-diff review, never by worker prose.

| # | Scenario | Required behavior | Slice |
| --- | --- | --- | --- |
| 1 | Green 825-test summary | Successful `unit-test` result inlines only the bounded success summary (≤ caps) + full-log path; no full log inlined | A |
| 2 | Failed tests | Failure summary leads with status/exit, failing test names, first root cause; caps truncate bottom-up per §8; full log path present | A |
| 3 | Warning-with-exit-0 | Warning count surfaced even at exit 0; summary distinguishes clean vs. warning success | A |
| 4 | Large segmented diff | Display may be segmented, but whole-diff scope check covers **all** changed paths and the whole-diff hash binds every segment; no segment skippable | B |
| 5 | Hidden out-of-scope path | Any changed path outside parent-approved allowed paths fails review; machine-checked, never satisfiable by prose | B |
| 6 | Stale hash | Evidence bound to a hash that differs from current state is invalid; reuse refused until re-run | C |
| 7 | Changed config/dependency invalidation | Config, dependency (lockfile), diff/commit, or gate-state change invalidates cached validation evidence and forces re-run | C |
| 8 | WebSocket recovery | Persist-first IDs survive reconnect; recovery reuses persisted artifacts, no duplicate inlining; missing ID fails closed | E |
| 9 | Commander soft/high behavior | Advisory warnings fire at configured thresholds; zero hard-stop paths; review/fixes/verification/handoff/user response never killed | D |
| 10 | Legacy records | Pre-optimization ledger/run records parse unchanged; new fields additive; no migration/rewrite | all |
| 11 | Unchanged Worker standard default | Worker `standard` default, all worker budgets and context safety byte-identical; worker-budget test suites pass unchanged | all |

## 10. Acceptance criteria

### 10.1 Release-blocking (P9 verdict requires all)

1. Every §9 matrix row passes with recorded recipe/gate evidence.
2. Every §4 immutable constraint holds, verified against the actual diff
   and machine-backed checks (B6-style), not worker prose.
3. Complete logs/reports/patch sources still persisted and path-referenced
   for every run, review, and gate (constraint §4.5).
4. Whole-diff scope check + hash binding present for every reviewed slice
   (constraint §4.3).
5. No hard-stop path exists for commander budgets (constraint §4.6).
6. Cache remains enabled and cache-telemetry guarantees hold (constraint
   §4.7).
7. Worker delegation semantics unchanged (constraint §4.1); worker-repair
   plan untouched.
8. P9 benchmark recorded against the P0 baseline with targets reported as
   measured-or-not (§11.2) — never claimed before measurement.
9. Rollback/stop conditions (§11) documented as not triggered.

### 10.2 Aspirational benchmark targets (not release PASS claims)

Measured at P9 on **comparable milestones** against the P0 baseline:

- ≥ 80% reduction of successful inline result bytes (P1/P2 effect);
- ≥ 25% reduction in commander calls per comparable milestone (P3 effect);
- ≥ 40% reduction in comparable-milestone gross tokens (cumulative effect).

These are **targets, not acceptance criteria**: missing a target never
blocks release; the P9 verdict is governed by §10.1 only. Targets are
reported as measured values with their comparison basis, and are never
claimed achieved before P9 measurement.

Consistent with this policy, a measured miss at a phase exit (as recorded
for P3's FAIL, 0.0 request reduction) may be accepted as a completed,
non-blocking optimization outcome: acceptance closes the phase for
downstream execution without weakening or redefining its frozen measurement
rule, without rerunning the criterion, and without any savings claim — the
miss stays recorded and must be reported by P9, and downstream phases must
not rely on the missed functionality.

## 11. Rollback and stop conditions

**Stop conditions** (halt the phase stream and return to Sol):

- P6 capability gate fails → P6 stays NOT_SCHEDULED; other phases proceed.
- Any §4 constraint violation or §9 matrix regression (esp. rows 5, 6, 7,
  9, 11) → stop, fix at root, re-review.
- Evidence invalidation failures (row 7) or stale-hash reuse (row 6) →
  stop until the invalidation mechanism is proven.
- Any attempted hard stop on commander spend, or any cache-disablement →
  stop; both are forbidden (§4.6, §4.7).
- Worker budget drift (row 11) → stop; revert the offending slice.

**Rollback**: every slice lands as its own reviewed delegation, so rollback
is that slice's git diff reverted and re-reviewed; data is additive-only
(no migration, no rewrite of legacy records); rollback never touches
worker delegation semantics, commander/worker identity, or review state.

## 12. Evidence-placeholder discipline (dynamic instructions)

As a contract for future execution, this plan **never pre-fills unknown
dynamic evidence**: no "latest delegation" id, no current diff hash, no
run id, and no dynamic baseline-record value may be embedded as a constant
before it is resolved, and creation-time values are never treated as
future evidence. Executions must resolve each item at run time:

- Baseline/run/delegation ids and diff hashes: read from the live ledger,
  telemetry, and git state at execution time (e.g., the most recent
  finished delegation/review in `.pi/workbench/delegations/` and `git
  status`/`git log` at that moment); record the resolved values in the
  phase's evidence.
- The Git state in the header table is an informational creation-time
  snapshot only and is never treated as evidence.
- Any summary that references an id/hash must state how it was resolved
  and when, so a future reader can re-derive it.

**Post-execution recording.** After execution, the plan's status/evidence
sections — the header status, §13 rows, and the closing status — may
record the **resolved** values: run IDs (e.g., the `typecheck` and
`unit-test` runs in §13 row 1), review hashes, and the declared durable
baseline record path `docs/baselines/commander-token-p0.md`, each with its
resolution time/method. That is recorded evidence, not a placeholder: run
IDs and review hashes must already exist and be resolved from the live
ledger, telemetry, and git state before they are recorded, and the
baseline record path is the static, declared durable location fixed by
this plan — the linked file must remain valid. Values recorded in the
status/evidence sections are evidence of what already happened — never a
pre-filled promise, and never treated as future evidence for a later
phase.

## 13. Execution checklist (updated per phase; rows 1–4 are point-in-time phase history; rows 5–8 and the header carry the current status)

Rows 1–4 below record each phase's status **as it stood at that phase's
completion** — point-in-time history, including their then-current
"P8/P9 pending/not started" and "overall exit PENDING" wording, which
described the state at that time and is superseded by rows 5–8 and the
header. They are preserved unchanged as historical evidence; current
status is in the header, rows 5–8, and the closing status.

| # | Item | Status |
| --- | --- | --- |
| 0 | Plan approved; immutable constraints and scope fixed | APPROVED |
| 1 | Slice A (P0 baseline/attribution + P1 summary policy) | PASS — the final full `check` run `20260805-141013-i4lx` passed 879/879 and the Commander gates run `20260805-141242-tyt8` passed b0-b6 (earlier targeted verification also PASS: `typecheck` run `20260805-135054-weh0`; `unit-test` run `20260805-135054-6zit` 879/879). The exact Commander gross/component token facts and the deterministic one-decimal cacheRead share are now rendered additively by `/q-cost-status` (full unabridged digits with exact gross = input + output + cacheRead + cacheWrite, explicit `N/A` on a zero gross, defensive normalization of malformed/non-finite/negative counts, and an explicit clamp note above `MAX_COMMANDER_COUNT_DISPLAY` — dedicated rendering tests landed with the reviewed renderer closure). The P0 baseline and the observational P1 inline-byte comparison are RECORDED in `docs/baselines/commander-token-p0.md` (2 calls / 1779 bytes; 889.5 vs 19125.7 bytes/call; 95.35% observational, with cohort limitations in the baseline record). The rollback/stop-condition review is COMPLETE at the Slice A boundary (row 8). No P0/P1 exit and no savings are claimed |
| 2 | Slice B (P2 layered results/whole-diff scope + P3 read-only batching) | IMPLEMENTED — B1 targeted verification COMPLETE; B2 actual-diff review + targeted verification COMPLETE; final check/gates PASS; P2 exit PASS; P3 exit FAIL (measured) — ACCEPTED AS NON-BLOCKING; combined Slice B exit NOT PASS (implementation/evidence work complete; no longer blocks Slice C/P4). Slice B1 (P2 layered `workbench_read_run` results + the P3 read-only batching guideline) targeted Commander verification is COMPLETE: `typecheck` run `20260805-151436-pvaw` PASS and `unit-test` run `20260805-151445-9x5v` PASS 909/909. Slice B2 (P2 coverage-gated segmented actual-diff review) implementation is complete; the B2 defect-repair delegation `20260805-153326-fgpg` (hash-reset test expectations, the REVIEWED fail-closed gap, legacy rendering/normalization, byte-bounded next include_paths guidance, plan staleness) received coverage-complete actual-diff review PASS at bound hash `a74df139c60c2cd97e0beff911f222315432db86dc350d63ac35e1b69208b95b` (8/8 displayed), and fresh targeted verification is COMPLETE: `typecheck` run `20260805-155137-at02` PASS and `unit-test` run `20260805-155143-oy4g` PASS 925/925. The Commander final verification is COMPLETE against the reviewed hash `c1b1e47a6b65322cbbf699d419e5db8b134ffbcba20561e245f84ae9f13b7690`: full `check` run `20260805-155633-j420` PASS 925/925 and Commander gates run `20260805-160158-udt6` PASS b0-b6, both run after the prior documentation synchronization on that reviewed hash. P2's quality/implementation exit is PASS (layered run output plus the coverage-gated complete-scope/hash behavior and the current verification). P3's static batching policy implementation is verified, but the P3 measured phase exit is FAIL: the comparable-milestone benchmark record `docs/baselines/commander-token-p3.md` measured pre total 8 vs current total 8 commander requests (reduction 0.0) under the frozen rule 'PASS only if current total requests < pre total requests' — so the combined Slice B P2+P3 exit is NOT PASS; no causal or overall token savings are claimed. P3 is closed/completed with its measured FAIL accepted as non-blocking: per §10.2's non-release-blocking target policy, the user accepted the measured miss rather than weakening or rerunning the frozen rule — the 0.0 reduction stays recorded, no savings are claimed, and the acceptance authorizes downstream execution only. The combined Slice B exit remains NOT PASS as an optimization exit, but Slice B's implementation/evidence work is complete and it no longer blocks starting Slice C (P4). This evidence-only status synchronization itself requires Sol actual-diff review and a final current-diff `check`/gate rerun; those future run IDs are not yet resolved |
| 3 | Slice C (P4 validation deduplication + strict invalidation) | PASS — P4 exit PASS. The P4a/P4b implementation (validation-evidence capture/persistence with exact invalidation bindings and the strict `REUSABLE`/`RERUN_REQUIRED` current-state assessment; §9 rows 6–7) landed via the reviewed P4 implementation delegations recorded in `docs/handoffs/commander-token-optimization-p4-handoff.md`. The focused P4/P6-C action-cache independence separation delegation `20260805-231448-yv3u` (only worker path `tests/p6-c-action-cache.test.ts`) received Sol actual-diff review PASS with complete displayed-path coverage at the reviewed/current bound hash `4d1325ffdcc10ab6825847e0edb010622bfa92c909d113d3efde2e852fcf89eb`. The P4/P6-C independence proof: the registered `workbench_read_run` read and its `REUSABLE`/`RERUN_REQUIRED` assessment leave the action key, cache store, and execution counter semantics unchanged — no record written/altered/removed, no cache-index/CAS change, no auto-execute and no auto-skip; no-cache still never reads/writes, refresh still executes, a failure is never flipped, and the next explicit same-key invocation keeps normal semantics (same action key → normal hit, no re-execution; a hit adds a new run manifest, never overwrites). Commander no-cache verification is COMPLETE on the current diff: `typecheck` `20260805-232823-jwoq` exit 0; `unit-test` `20260805-232832-we0r` 1059/1059 exit 0; full `check` `20260805-233043-3v8c` 1059/1059 exit 0; all-gate run `20260805-233326-t3w6` PASS b0-b6 with the required manual evidence recorded. P4 requires P2/P3 (dependency graph preserved): P2's exit is PASS, and P3 is closed/completed with its measured FAIL (comparable-milestone benchmark `docs/baselines/commander-token-p3.md`: pre total 8 vs current total 8 requests, reduction 0.0) accepted as non-blocking per §10.2 — Slice C does not use or trust P3's batching functionality; the FAIL stays recorded and no savings are claimed. The Slice C documentation-synchronization delegation `20260805-233348-ad7n` (plan document only) received Sol actual-diff review PASS at bound hash `ce6a7ed35c106d6000209cf839d5c240feb33e8e1e9d70df2c929904b4bed864`, followed by Commander current-diff verification COMPLETE on that reviewed hash: `typecheck` `20260805-233712-kgzo` exit 0; `unit-test` `20260805-233718-ioq5` 1059/1059 exit 0; full `check` `20260805-233930-ytck` 1059/1059 exit 0; all-gate run `20260805-234159-uu94` PASS b0-b6 with the required manual evidence recorded — the prior pending claim is resolved, and nothing about Slice C/P4 remains pending |
| 4 | Slice D (P5 milestone lifecycle + P7 advisory observability) | PASS — combined Slice D (P5+P7) exit PASS. The P7 commander cumulative observability portion (configurable observation-first soft/high advisory thresholds; no hard stop ever — §4.6, §6 P7, §9 row 9) is PASS and is not redone: source/config/footer/`/q-cost-status`/tests/docs implemented and the advisory-only/no-hard-stop contract verified. Actual-diff review of the latest implementation/docs delegation `20260805-165159-baee` is PASS with complete coverage (no current diff hash pinned in prose — this documentation write changes it). Final targeted verification is COMPLETE: `typecheck` run `20260805-165951-cbyr` PASS and `unit-test` run `20260805-170000-uxif` PASS 978/978. Final full verification is COMPLETE: `check` run `20260805-170224-xxp8` PASS 978/978 and Commander gates run `20260805-170509-y7re` PASS b0-b6. Recovery incident: the initial P7 delegation `20260805-161430-kiu5` left `index.ts` at zero bytes; the exact pre-delegation content was recovered to SHA-256 `606a11c2c774cde86fde2dd25abed425cdf9eb87a6d9e73ee315aed1ff1de7a1` before P7 completion — recovery record only, no HEAD restore implied. The P5 milestone session/handoff lifecycle portion is PASS: the read-only gap diagnosis delegation `20260805-234450-dmpg` (no project changes) received reviewed PASS; the first P5 implementation delegation `20260805-235827-myfz` received actual-diff review PASS with complete coverage at bound hash `d03984b95f83aeaa1cefc3575d8c7926ad63ef8eabaec791b10bcba4ab34932a`; Sol-found privacy/state/docs defects were repaired by the delegation `20260806-001818-wii9`, which received actual-diff review PASS with complete coverage at the final implementation hash `62b2066ebe047298cd8964cebc83d19bd6c564e3f9ee08a0f75d152dec5ee5ad`. Verified P5 behavior, stated without overclaim: the explicit USER-ONLY `/q-milestone-handoff <next step>` command; an ordinary `/new` remains a fresh DEV session; persist-first additive prepared/resumed/cancelled schema-v1 records; the bounded/redacted explicit next step is mirrored into CompactState; parent-linked target setup with hidden pointers/status note and copied mode/compact/delegation settings; replacement-context reload due Pi setup ordering; no lease transfer and the target is locked; malformed/legacy inputs fail closed with no rewrite; no model/provider call, agent turn, automation, threshold action, steering, or hard stop is performed; no P6/P8/worker-budget/default changes. Commander verification against the reviewed implementation hash `62b2066ebe047298cd8964cebc83d19bd6c564e3f9ee08a0f75d152dec5ee5ad` is COMPLETE: `typecheck` `20260806-003235-srpw` exit 0; `unit-test` `20260806-003242-2eja` 1078/1078 exit 0; full `check` `20260806-003458-25rd` 1078/1078 exit 0; all-gate run `20260806-003754-6lri` PASS b0-b6 with the required manual evidence recorded (the 8 summary "warnings" were test-name matches, not runtime warnings). Slice D is therefore complete: combined Slice D P5+P7 exit is PASS; P8, P9 and publication remain pending/not started; overall exit remains PENDING — no final release/publication claim is made. This documentation synchronization itself changes the diff hash, so its own Sol actual-diff review plus a fresh final current-diff `check`/gate rerun remain pending — those future run IDs/hashes are not yet resolved and are never pre-filled |
| 5 | Slice E (P8 persist-first recovery; P6 only if its capability gate passes; P9 prep) | PASS — P8 exit PASS and P9 exit PASS (P6 remained NOT_SCHEDULED, so Slice E's conditional P6 work did not occur). P8 final compatibility/status closure delegation `20260806-081008-l7na` (its only worker path was `docs/compatibility.md` — a one-path docs closure, not the P8 implementation; P8 functionality is validated by the full P8 tests/check/gates cited in this row) received Sol actual-diff review PASS with complete coverage at bound hash `3e4189b920f843010cbce7ba77597421d6460b0271d5b341f14283b048110711`; Commander verification on that hash: typecheck `20260806-081059-rlxw` exit 0; unit-test `20260806-081106-6ykl` 1122/1122; check `20260806-081321-gk7a` 1122/1122; gates `20260806-081834-p6lf` b0-b6 PASS. Exact P8 boundary: persist-first tool-result recovery/replay is verified across fresh runtime/resume with the SAME valid native Pi session identity; this repository implements no WebSocket (or any other) transport and no cross-different-session-ID recovery is claimed. The P9 harness delegation `20260806-095638-fu5o` (protocol doc + analyzer script + tests) received review PASS at hash `a2a0d7859e890e2507144ce40bd1b6ca855b4fd31ab534baf49626cd0c366bf2`; typecheck `20260806-100728-61hd` exit 0; unit-test `20260806-100736-hwvm` 1156/1156; check `20260806-100947-4gei` 1156/1156; gates `20260806-101218-3jqk` b0-b6 PASS. P9 execution, quality matrix and Sol verdict are recorded in `docs/baselines/commander-token-p9.md` (see rows 7–8). |
| 6 | P6 capability gate (compaction-summary optimization) | NOT_SCHEDULED — pending verified Pi capability + Sol-approved design; confirmed at the P9 exit: the prerequisite remains absent, P6 never blocked any other phase, and no active stop condition arises from it |
| 7 | P9 final benchmark + quality matrix + Sol verdict | PASS — Sol verdict **P9 PASS** and **FINAL RELEASE-QUALITY EXIT PASS** under §10.1 (see `docs/baselines/commander-token-p9.md`). Real-prep terminal-expectation repair delegation `20260806-115923-zjyf` review PASS at hash `4429cf9e964295cde046068091e5454e8df773d059e7d095dcef22b605ee4905`; typecheck `20260806-120244-1fy2` exit 0; unit-test `20260806-120252-a1up` 1183/1183. First real prep `20260806-115823-m5by` FAILED before artifacts (`TERMINAL_MISMATCH: invalid attempt "invalid-4": observed aborted=true does not match the fixed expectation aborted=false`); root-fixed to require exactly invalid-4 and invalid-5 aborted, re-reviewed, then successful preparation `20260806-120518-y8xy` created the strict manifest, the privacy-safe deviation record, 8 invalid copies and 3 corrected copies. Analyzer run `20260806-120523-gy65` exited 0 over `.pi/workbench/runs/commander-token-p9-manifest.json` (full JSON in its stdout.log; prompt hash `01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f`; model `openai-codex/gpt-5.6-sol`; thinking high; exact 3+3 cohort; zero compactions). Sol-owned quality verification: full no-cache check `20260806-120618-qwxe` PASS 1183/1183 and all-gate run `20260806-120856-frol` PASS b0-b6 with the required manual evidence. Targets are measured-or-not only: all three strict P0 targets NOT_MEASURABLE (frozen basis-incomparable); all three supplemental comparable targets MISSED (requests 8→10, −25%, vs ≥25%; successful inline bytes 99,099→166,888, −68.40533204169568%, vs ≥80%; gross tokens 92,456→109,178, −18.08644111793718%, vs ≥40%; costs descriptive 0.358696→0.460798); historical P3 8→8 reduction 0.0 FAIL preserved — this exit is NOT a token-savings/optimization-success claim. Post-sync Commander-owned no-cache `check`/gates on the new documentation diff remain required and must be read from later workbench records — not pre-filled; any post-sync failure reopens the verdict. |
| 8 | Rollback/stop-condition review at every slice boundary | COMPLETE at every slice boundary through P9 — no stop condition is active at verdict time. Historical: the transient accidental plan truncation was detected during actual-diff review, repaired from the persisted full review artifact, and re-reviewed (Slice A). At P9: the transient prep expectation mismatch was stopped (first real prep `20260806-115823-m5by` failed before any artifacts), root-fixed (delegation `20260806-115923-zjyf` review PASS at hash `4429cf9e…`), re-reviewed and reverified (typecheck `20260806-120244-1fy2`, unit-test `20260806-120252-a1up` 1183/1183, check `20260806-120618-qwxe` 1183/1183, gates `20260806-120856-frol` b0-b6 PASS). No §4 violation or §9 regression remains active; P6 stays NOT_SCHEDULED (capability-gated — its §11 stop condition resolves to NOT_SCHEDULED, not a halt); no source, persisted evidence, cache, or Worker semantics were lost or rolled back |

**Status: P8 PASS; P9 PASS; FINAL RELEASE-QUALITY EXIT PASS (UNDER §10.1); P6 NOT_SCHEDULED (CAPABILITY-GATED); COMBINED SLICE B EXIT NOT PASS (NON-BLOCKING) — ALL PHASES CLOSED; NO PUBLISH/TAG/COMMIT/RELEASE ACTION.**
Slice A (P0 numeric/byte attribution in
`core/cost-breakdown.ts` + the P1 bounded summary policy in
`core/result-summary.ts`, wired into `workbench_run_recipe`,
`workbench_run_gate`, `/q-run` and `/q-gate` in `index.ts`) is PASS: the
final full `check` run `20260805-141013-i4lx` passed 879/879 and the
Commander gates run `20260805-141242-tyt8` passed b0-b6 (earlier targeted
verification also PASS: `typecheck` `20260805-135054-weh0`, `unit-test`
`20260805-135054-6zit` 879/879). Slice B1 (P2 layered `workbench_read_run`
results + the P3 read-only batching guideline) targeted Commander
verification is COMPLETE: `typecheck` run `20260805-151436-pvaw` PASS and
`unit-test` run `20260805-151445-9x5v` PASS 909/909. Slice B2 (P2
coverage-gated segmented actual-diff review) implementation is complete:
additive displayed-path coverage facts on review records (displayed_paths /
remaining_paths / coverage_complete / review_path — a path is displayed
only when it appears in an actually rendered patch entry; globally omitted
paths stay remaining; bounded/per-path-truncated entries count as that
path's bounded evidence segment; prior coverage merges only on the SAME
bound hash with valid worker-path membership, a hash change resets, and
legacy schema_version-1 records infer prior coverage only from their
persisted patch entries), the repeatable coverage-gated
`workbench_review_worker_diff` lifecycle (REVIEWED requires scope PASS AND
complete displayed-path coverage; a same-hash complete PASS rerender keeps
the valid REVIEWED binding; a changed hash resets coverage; a scope FAIL
invalidates a prior same-hash REVIEWED state fail-closed via the pure
`demoteReviewedToPending` transition, pending/stale staying safely
blocking), deterministic rendered coverage counts, bounded next
`include_paths` guidance (max 50 paths) and the durable review.json path.
The B2 actual-diff review is COMPLETE: delegation `20260805-153326-fgpg`
received coverage-complete review PASS at bound hash
`a74df139c60c2cd97e0beff911f222315432db86dc350d63ac35e1b69208b95b` (8/8
displayed), and fresh targeted verification is COMPLETE: `typecheck` run
`20260805-155137-at02` PASS and `unit-test` run `20260805-155143-oy4g`
PASS 925/925. The Commander final verification is COMPLETE against the reviewed hash
`c1b1e47a6b65322cbbf699d419e5db8b134ffbcba20561e245f84ae9f13b7690`: full
`check` run `20260805-155633-j420` PASS 925/925 and Commander gates run
`20260805-160158-udt6` PASS b0-b6, both run after the prior documentation
synchronization on that reviewed hash. P2's quality/implementation exit is
PASS (layered run output plus the coverage-gated complete-scope/hash
behavior and the current verification). P3's static batching policy
implementation is verified, but the P3 measured phase exit is **FAIL**: the
comparable-milestone benchmark record `docs/baselines/commander-token-p3.md`
measured pre total 8 vs current total 8 commander requests (reduction 0.0)
under the frozen rule 'PASS only if current total requests < pre total
requests' — so the combined Slice B P2+P3 exit is **NOT PASS**; no causal or
overall token savings are claimed here; the §2
snapshot remains a point-in-time observation only,
the recorded P1 comparison is observational and cannot satisfy the §10.2
targets, which are measured-or-not at P9. Per §10.2's non-release-blocking
target policy, the user accepted this measured FAIL as a completed,
non-blocking optimization outcome: the frozen strict-less-than rule is
neither weakened nor rerun, the 0.0 reduction stays recorded, no savings are
claimed, and P9 must report the missed P3 result; the acceptance authorizes
downstream execution only. Slice C (P4) is therefore PASS: the focused
P4/P6-C action-cache independence separation delegation
`20260805-231448-yv3u` (only worker path `tests/p6-c-action-cache.test.ts`)
received Sol actual-diff review PASS with complete displayed-path coverage
at the reviewed/current bound hash
`4d1325ffdcc10ab6825847e0edb010622bfa92c909d113d3efde2e852fcf89eb`;
Commander no-cache verification is COMPLETE on the current diff: `typecheck`
`20260805-232823-jwoq` exit 0, `unit-test` `20260805-232832-we0r` 1059/1059
exit 0, full `check` `20260805-233043-3v8c` 1059/1059 exit 0, and the
all-gate run `20260805-233326-t3w6` PASS b0-b6 with the required manual
evidence recorded. The P4/P6-C independence proof: the registered
read/assessment leaves the action key, cache store, and execution counter
semantics unchanged; no-cache/refresh/failure behavior and the next explicit
same-key hit remain normal (see §13 row 3). P4 does not use or trust P3's
batching functionality. The Slice C documentation-synchronization
delegation `20260805-233348-ad7n` (plan document only) received Sol
actual-diff review PASS at bound hash
`ce6a7ed35c106d6000209cf839d5c240feb33e8e1e9d70df2c929904b4bed864`, followed
by Commander current-diff verification COMPLETE on that reviewed hash:
`typecheck` `20260805-233712-kgzo` exit 0, `unit-test` `20260805-233718-ioq5`
1059/1059 exit 0, full `check` `20260805-233930-ytck` 1059/1059 exit 0, and
the all-gate run `20260805-234159-uu94` PASS b0-b6 with the required manual
evidence recorded — the prior pending claim is resolved, and nothing about
Slice C/P4 remains pending (see §13 row 3). Slice D's P7
commander advisory portion is PASS (commander cumulative observability with
configurable observation-first soft/high advisory thresholds; no hard stop
ever): the P7 source/config/footer/`/q-cost-status`/tests/docs work is
implemented and the advisory-only/no-hard-stop contract is verified.
Actual-diff review of the latest implementation/docs delegation
`20260805-165159-baee` is PASS with complete coverage (no current diff hash
is pinned in prose because this documentation write changes it). Final
targeted verification is COMPLETE: `typecheck` run `20260805-165951-cbyr`
PASS and `unit-test` run `20260805-170000-uxif` PASS 978/978. Final full
verification is COMPLETE: `check` run `20260805-170224-xxp8` PASS 978/978
and Commander gates run `20260805-170509-y7re` PASS b0-b6. Recovery
incident: the initial P7 delegation `20260805-161430-kiu5` left `index.ts`
at zero bytes; the exact pre-delegation content was recovered to SHA-256
`606a11c2c774cde86fde2dd25abed425cdf9eb87a6d9e73ee315aed1ff1de7a1` before
P7 completion — recovery record only, no HEAD restore implied. Slice D (P5+P7) is PASS: the P5 milestone lifecycle portion is PASS — the
read-only gap diagnosis `20260805-234450-dmpg` (no project changes,
reviewed PASS), the first implementation `20260805-235827-myfz` with
actual-diff review PASS and complete coverage at hash
`d03984b95f83aeaa1cefc3575d8c7926ad63ef8eabaec791b10bcba4ab34932a`, and the
Sol-found privacy/state/docs defect repair `20260806-001818-wii9` with
actual-diff review PASS and complete coverage at the final implementation
hash `62b2066ebe047298cd8964cebc83d19bd6c564e3f9ee08a0f75d152dec5ee5ad`;
Commander verification against that reviewed hash is COMPLETE: `typecheck`
`20260806-003235-srpw` exit 0, `unit-test` `20260806-003242-2eja` 1078/1078
exit 0, full `check` `20260806-003458-25rd` 1078/1078 exit 0, and the
all-gate run `20260806-003754-6lri` PASS b0-b6 with the required manual
evidence recorded (bounded P5 behavior summary in §13 row 4). So the combined
Slice D exit was PASS at that time (point-in-time history as of Slice D
completion; superseded). P8 and P9 have since PASSED and the FINAL
RELEASE-QUALITY EXIT PASS is recorded — verdict and evidence in
`docs/baselines/commander-token-p9.md` and §13 rows 5/7/8: P8 delegation
`20260806-081008-l7na` review hash `3e4189b920f843010cbce7ba77597421d6460b0271d5b341f14283b048110711`
with typecheck `20260806-081059-rlxw`, unit-test `20260806-081106-6ykl`
1122/1122, check `20260806-081321-gk7a` 1122/1122, gates `20260806-081834-p6lf`
b0-b6 (recovery boundary: persist-first replay with the SAME valid native
Pi session identity; no WebSocket transport, no cross-different-session-ID
recovery claim); P9 harness delegation `20260806-095638-fu5o` review hash
`a2a0d7859e890e2507144ce40bd1b6ca855b4fd31ab534baf49626cd0c366bf2` with
typecheck `20260806-100728-61hd`, unit-test `20260806-100736-hwvm` 1156/1156,
check `20260806-100947-4gei` 1156/1156, gates `20260806-101218-3jqk` b0-b6;
repair delegation `20260806-115923-zjyf` review hash
`4429cf9e964295cde046068091e5454e8df773d059e7d095dcef22b605ee4905` with
typecheck `20260806-120244-1fy2`, unit-test `20260806-120252-a1up` 1183/1183;
first prep `20260806-115823-m5by` FAILED before artifacts
(`TERMINAL_MISMATCH` on invalid-4), root-fixed, then successful preparation
`20260806-120518-y8xy`; analyzer `20260806-120523-gy65` exit 0 (strict 3+3,
zero compactions, prompt hash
`01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f`);
Sol-owned quality verification no-cache check `20260806-120618-qwxe`
1183/1183 and gates `20260806-120856-frol` b0-b6 PASS with required manual
evidence. All strict P0 targets NOT_MEASURABLE; all supplemental comparable
targets MISSED (requests −25%, bytes −68.40533204169568%, gross
−18.08644111793718%); historical P3 8→8 reduction 0.0 FAIL preserved; no
token-savings or optimization-success claim. Worker defaults/budgets (§4.1,
§10.1.7) and review/gate responsibilities are unchanged;
`docs/plans/worker-token-budget-repair.md` is untouched. This documentation
synchronization itself changes the diff hash, so fresh Commander-owned
no-cache `check`/gates on the new diff are required and must be read from
later workbench records — their future run IDs are not yet resolved and are
never pre-filled; the verdict recorded here is based on `20260806-120618-qwxe`
and `20260806-120856-frol`, and any post-sync failure reopens it.
