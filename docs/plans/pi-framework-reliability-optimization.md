# Pi Framework Reliability Optimization — Four-Stage Execution Plan

| Field | Value |
| --- | --- |
| Plan id | `pi-framework-reliability-2026-08-23` |
| Version | `1.0` |
| Created | 2026-08-23 |
| Scope | Gate authority, run continuity, compaction continuity, development efficiency, templates/docs/CI |
| Status | `IMPLEMENTED / DEVELOPMENT_VERIFIED`; current-tree formal Pi Gate authority remains `NOT_RUN` |
| Authority | This document is a development contract, not Gate PASS evidence. Only current committed Gate artifacts can grant reusable Gate authority. |

## Observable outcome

Pi keeps the current architecture and public workflow, but fails closed at every
formal authority boundary, retains the active objective across compaction and
overflow, finds the real newest Gate attempt without history-window lies, and
publishes efficiency claims only from version/actor/recipe-separated evidence.

No shadow governance, replacement runtime, or second telemetry pipeline is
introduced. Historical reports remain historical and non-authoritative.

## Acceptance criteria and evidence map

| Criterion | Required outcome | Evidence / exit check |
| --- | --- | --- |
| `C1` | Malformed Gate booleans fail setup before a run is allocated. | Strict schema matrix for Gate/check string, number, null, array, and object values. |
| `C2` | Reserved B6 cannot be replaced or weakened by project YAML. | Override/weakening regression tests plus canonical B6 definition binding. |
| `C3` | A selected failing optional Gate cannot yield successful reusable authority. | Optional-only Gate integration test. |
| `C4` | Human manual evidence cannot be supplied by a model-callable tool. | Provenance tests for model denial and explicit user attestation. |
| `C5` | Historical prerequisite/artifact references are accepted only when their source authority is current and identity-bound. | Commit A to B stale-source tests; dependent result must block or require rerun. |
| `C6` | Gate status never disappears after 10/50 unrelated runs and never falls back across a corrupt newer attempt. | More-than-50 and more-than-1000 run tests; corrupt/missing/oversize newest tests. |
| `C7` | Gate lookup cost is not proportional to parsing every historical manifest on each UI refresh. | Immutable pre-evaluation attempt index plus strict fallback/cache tests and deterministic read counters. |
| `C8` | Compaction restores one complete latest snapshot and retains objective/next action/reviewed paths. Successful and observably cancelled attempts record a terminal immediately; an unobserved native failure is reconciled at the next compact/session lifecycle and can never receive more than one terminal. | Compact state/lifecycle tests, runtime wiring tests, and the Pi 0.84.2 public-API limitation record. |
| `C9` | Overflow recovery is narrow, single-shot, loop-safe, and produces a recoverable handoff on failure. | Classifier/decision/wiring canary tests. |
| `C10` | Plan progress is traceable without becoming a second authority system. | Optional plan reference is hash-bound into the existing delegation/validation chain; drift is visible and never grants PASS. |
| `C11` | Efficiency reports separate extension version, actor, and recipe cohorts and disclose scope/quality. | Cache benchmark tests plus a current offline report. |
| `C12` | Generic initialization never assumes npm for non-Node projects or invents absent scripts. | Node/Go/Python initialization tests. |
| `C13` | Current Pi source target, CI, architecture, B0-B6 templates, and historical-report labels agree. | Typecheck, release-assets/package tests, CI workflow, documentation review. |

## Stage 1 — Formal authority repair

1. Make all Gate and check booleans literal-only and setup-failing.
2. Reserve B6 and reject project replacement or weakening.
3. Make explicitly selected failures participate in invocation outcome.
4. Split human user attestation from model-provided notes and bind provenance.
5. Validate the freshness of prerequisite and artifact source runs; bind source
   run id and binding digest into dependent evidence.
6. Ensure final-lane prerequisite closure comes from the same current run or a
   separately current reusable source, never a raw historical status.

Exit: `C1-C5` pass in focused schema/Gate/validation/controller tests.

Rollback: revert this stage as one coherent authority patch. Never rewrite or
delete previously committed run evidence; older evidence simply remains
historical and may assess as non-reusable under the repaired reader.

## Stage 2 — Continuity and context recovery

1. Replace fixed 10/50-run searches with a strict recipe-filtered iterator and
   immutable pre-evaluation Gate-attempt markers that are always revalidated.
2. Stop at a corrupt newest Gate candidate and report `UNKNOWN/CORRUPT`; never
   call a truncated history `NOT_RUN (never run)` and never recover an older
   PASS across damaged newer authority.
3. Cache classified run inventory in-process so repeated status/widget refresh
   does not reparse every manifest; retain a strict full-scan fallback.
4. Restore only the latest complete compact snapshot. Persist durable objective,
   next action, and reviewed worker changed-path summary independently from the
   transient widget task.
5. Record compaction `started` and at most one terminal state. Record success
   and observable cancellation immediately; reconcile an unobserved native
   failure on the next compact/session lifecycle because Pi 0.84.2 exposes no
   failure-completion event. Deliver retry context immediately when Pi will
   retry, and use one narrow overflow-only recovery attempt before a bounded
   handoff.

Exit: `C6-C9` pass, including more than 1000 synthetic runs and overflow canary
coverage.

Rollback: disable the classification cache and fall back to strict full
scanning, but retain immutable attempt markers and their fail-closed reader;
never delete crash markers merely to recover an older PASS. Keep lifecycle
entries append-only and readable as historical telemetry.

## Stage 3 — Plan adherence and measured efficiency

1. Keep one durable plan contract and bind an optional minimal `plan_ref`
   (`plan_id`, version/hash, candidate/status, criterion ids, next action) into
   the existing delegation transaction and validation evidence. It never
   grants PASS by itself.
2. Surface plan drift or uncovered criteria as stale/unknown at final authority
   boundaries; completion language cannot override machine evidence.
3. Reuse the cache benchmark to publish extension-version, actor, and recipe
   cohorts. Separate project-lifetime action-cache facts from filtered prompt
   telemetry, and keep incomplete/legacy schemas explicit.
4. Compare lookup latency, action-cache usefulness, compact recovery semantics,
   and final Gate behavior against the frozen pre-change baseline.

Exit: `C10-C11` pass. Improvement claims require comparable current cohorts;
otherwise the result remains `NOT_MEASURED`, not a guessed percentage.

Historical baseline before the metric-definition repair (offline,
non-authoritative) reported 1,338 run manifests, 126 action-cache hits and
1,212 apparent misses (9.42%). The repaired report shows that 70 of those rows
have unknown execution source and must not be counted as misses: 126 hits,
1,142 exec misses, 70 unknown, 9.94% over the 1,268 cache/exec denominator.
The retained prompt history has 11,630 usage records, but only 50 schema-1.3
observations, all commander and zero worker. These are historical cohorts, not
evidence of current-HEAD or worker efficiency.

## Stage 4 — Architecture, defaults, CI, and release closure

1. Generate generic recipes only from detected stacks and real declared scripts;
   unsupported stacks remain explicit `NOT_CONFIGURED`.
2. Keep the composition root under its upper bound without encoding a minimum
   line count, and document the actual domain/controller/adapter boundaries.
3. Align templates and model guidance to B0-B6, distinguish released Pi
   baseline from the current source/test target, and label old Gate reports as
   historical/non-authoritative.
4. Run typecheck, focused suites, full tests, package/release-assets checks,
   diff checks, then assess a fresh Gate run separately from development tests.

Exit: `C12-C13` pass and every earlier criterion has fresh evidence. A full test
PASS does not by itself convert historical Gate artifacts into current formal
authority.

## Final closure record

The implementation candidate is the current uncommitted working tree. The
development suite is fresh evidence for this candidate; it is deliberately not
represented as a Pi Gate PASS or reusable production authority. A formal Gate
run was not used to orchestrate this repository-maintenance work.

| Stage | State | Fresh evidence |
| --- | --- | --- |
| 1 | `COMPLETE / DEVELOPMENT_VERIFIED` | Strict boolean, reserved B6, optional/manual provenance, prerequisite/artifact freshness and evidence-binding regressions pass; legacy manual v1 authority is explicitly non-reusable. |
| 2 | `COMPLETE / DEVELOPMENT_VERIFIED` | More-than-50 and more-than-1000 history, corrupt/crash/mutated marker, run-identity/cache-poison, latest-snapshot compact and native/fallback overflow single-shot regressions pass. Pi 0.84.2's unobserved native-failure terminal remains eventually reconciled, never synchronously observable. |
| 3 | `COMPLETE / DEVELOPMENT_VERIFIED` | `plan_ref` is bound into delegation and full Gate validation/assessment; drift/partial coverage fail closed. Offline report: 1,338 manifests, 126 hits, 1,142 exec misses, 70 unknown, 9.94%; current-HEAD and worker benefit remain `NOT_MEASURED`. |
| 4 | `COMPLETE / DEVELOPMENT_VERIFIED` | `npm run check`: typecheck PASS; 2,535 tests PASS, 0 FAIL, 1 explicitly skipped formal stress case; `git diff --check` PASS. CI pins immutable current action SHAs and uses weekly dependency updates. Formal current-tree Pi Gate status: `NOT_RUN`. |
