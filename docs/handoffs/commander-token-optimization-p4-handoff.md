# Commander Token Optimization — P4 Handoff (durable session-resume document)

| Field | Value |
| --- | --- |
| Purpose | Self-contained handoff so a brand-new, memoryless session can continue the Commander Token Optimization plan from the current P4 state |
| Repository | `/home/hanbaoji/Projects/pi-vibing-seriously` (pi-dev-workbench) |
| Branch / base | `main` @ `aa2301763d95` (full `aa2301763d953d28fa05e06a0080704f3cea20e5`) — **intentionally dirty**; the entire optimization implementation lives in the uncommitted working tree (per-delegation `diff_hash_before`/`diff_hash_after` are recorded in each ledger record) |
| Pre-document implementation hash | `9c44b23a797bd90c769d2ee79e1fee76b5f11a3b2dc259470c5119851b168a50` — see §1.3: this is the hash **before** this handoff document was written; it is **not** the live current hash afterwards |
| Durable authority | `docs/plans/commander-token-optimization.md` (approved P0–P9 / Slice A–E contract) + `docs/plans/worker-token-budget-repair.md` (immutable companion constraints) |
| Handoff date | 2026-08-05 |
| Owner | GPT-5.6 Sol commander (requirements, architecture, review, gates, final verdict) |
| Executor | Fresh bounded Worker children, one bounded slice per delegation, `standard` spend profile (bounds cumulative spend only; never expands parent-approved path/scope authority) |

This document consolidates the two handoff responses from the Sol session
that executed Slice C (P4). It records newer execution state than the plan
document's prose (which is stale at "Slice C (P4) READY_TO_START", §2.4);
the plan's **requirements and dependencies remain authoritative**. Follow
plan §12 evidence-placeholder discipline: resolve every dynamic id/hash
from the live ledger at session start — never trust a value embedded here
as current evidence.

---

## 1. Current operational state

### 1.1 Repo and git

- Repo: `/home/hanbaoji/Projects/pi-vibing-seriously`; `main` @ `aa2301763d95`, **intentionally dirty** (expected — do not "fix" it; do not commit without the user's explicit release step, §9).
- `workbench_project_inspect`: no config errors; declared recipes `check`, `typecheck`, `unit-test` (DEV/VERIFY).

### 1.2 Authority model (strict worker-first)

- Commander **writes are denied** — every change to source, tests, and docs (including plan-status sync and handoff documents) is a reviewed Worker delegation inside parent-approved paths.
- One writing worker per worktree; Workers run **only write-free declared recipes**; Worker prose is never acceptance evidence; only Sol maps evidence to criteria and gives the verdict.
- A pending or stale review blocks the next delegation and VERIFY; B6 (Worker-First Compliance) stays machine-backed.

### 1.3 Latest implementation delegation and the hash rule

- Latest **implementation** delegation before this handoff document: **`20260805-225535-zwm5`** — REVIEWED / **PASS** / complete (coverage-complete review at bound hash `9c44b23a797bd90c769d2ee79e1fee76b5f11a3b2dc259470c5119851b168a50`; only path changed: `tests/run-result-wiring.test.ts`, P4b legacy-record verdict + read-only invariance). Record: `.pi/workbench/delegations/20260805-225535-zwm5/` (`review.json`).
- **`9c44b23a…` is the pre-document implementation hash** — the current diff hash **before** this handoff document was written (this document itself is delegation `20260805-230821-eo10`, recorded running/PENDING_REVIEW at write time; its `diff_hash_before` is exactly `9c44b23a…`).
- **Rule for the next session:** resolve the live current/reviewed hash with `workbench_delegation_status` at session start (require latest delegation REVIEWED and current diff hash == reviewed hash). **Never claim this document's future diff hash** — the working tree hash changes once this document lands; a self-referential "document hash" is never evidence (plan §12).
- P4 closure is **not** complete (see §5, §7): the P6-C separation test (§6) and the current Commander verification/gates are still outstanding.

---

## 2. Durable authority and documents (read before acting)

| Document | Role |
| --- | --- |
| `docs/plans/commander-token-optimization.md` | **Approved durable contract**: §4 immutable constraints, §5 scope, §6 P0–P9 phases + dependency graph, §7 Slice A–E delegations, §8 output-summary policy + failure-information precedence, §9 quality matrix rows 1–11, §10 acceptance (10.1 release-blocking / 10.2 aspirational targets), §11 rollback/stop conditions, §12 evidence-placeholder discipline, §13 execution checklist |
| `docs/plans/worker-token-budget-repair.md` | **Immutable companion**: Worker `standard` default, all Worker budgets/context safety unchanged (§4.1 of the optimization plan); its Phase 6 stays deferred; §11 "no version bump / no CHANGELOG without Sol's release decision; release notes are Sol's" |
| `docs/baselines/commander-token-p0.md` | P0 baseline: exact snapshot + observational P1 inline-byte comparison (2 calls / 1779 bytes; 889.5 vs 19125.7 bytes/call; 95.35% observational with cohort limitations) |
| `docs/baselines/commander-token-p3.md` | P3 comparable-milestone measurement: **pre total 8 vs current total 8 → reduction 0.0 → FAIL (measured)** under the frozen rule "PASS only if current total requests < pre total requests"; evidence root `.pi/workbench/runs/commander-token-p3-benchmark/` (analysis.json SHA-256 `5cd71bddb3132d7306868c5a5a18bd1aa1aaf4a4ce4a2fefb97ee924beddc221`) |
| `docs/architecture.md` | P4a + P4b implemented documentation sections (updated by the P4 delegations) |
| This document | Durable handoff; records execution state newer than the plan prose |

**Plan status prose is stale:** the plan header/§13 still say "SLICE C (P4) READY_TO_START". That was true before P4 implementation began; the authoritative requirements/dependencies are unchanged, but this handoff (§3–§7) records the newer execution state. Do not "correct" the plan prose directly (Commander writes denied) — the status sync is a Worker delegation in §7 step 6.

---

## 3. Full plan map / current phase state

### 3.1 Phase states

| Phase | State | Evidence (recorded) |
| --- | --- | --- |
| **P0** | **PASS** | Slice A; `check` `20260805-141013-i4lx` 879/879; gates `20260805-141242-tyt8` b0–b6; baseline `docs/baselines/commander-token-p0.md` |
| **P1** | **PASS** | Slice A; summary policy wired (`core/result-summary.ts`, `/q-run`, `/q-gate`); same check/gates |
| **P2** | **PASS** | Slice B; layered `workbench_read_run` + whole-diff scope/hash binding; `check` `20260805-155633-j420` 925/925; gates `20260805-160158-udt6` b0–b6 |
| **P3** | **Measured FAIL, accepted non-blocking ONLY under §10.2** | `docs/baselines/commander-token-p3.md`: 8 → 8, reduction **0.0**. Frozen strict-less-than rule neither weakened nor rerun; **no savings claim of any kind**; P4 does not use or trust P3's batching; P9 must report the miss |
| **P4** | **Implementation/review essentially complete; closure PENDING** | P4a+P4b delegations (see §4), last one `20260805-225535-zwm5` REVIEWED/PASS. Closure blocked on: (1) the P6-C action-cache independence test (§6), (2) current Commander verification/gates (§7). **Not marked PASS** |
| **P5** | **PENDING** — NOT_STARTED, blocked on P4 only | Slice D remainder; after P4 close; start with bounded gap analysis (§8) |
| **P6** | **NOT_SCHEDULED — capability-gated** | No implementation until Sol verifies Pi capability to observe/optimize the commander compaction summary (no cache-stability / fail-closed / §4 regression) and approves a fresh design; never schedule without the gate |
| **P7** | **PASS** | Slice D portion; advisory-only cumulative observability (no hard stop ever); `check` `20260805-170224-xxp8` 978/978; gates `20260805-170509-y7re` b0–b6; recovery incident record (index.ts zero-byte, recovered to SHA-256 `606a11c2…`) in plan §13 row 4 |
| **P8** | **PENDING** | After P5/P7; unknown scope → bounded diagnosis → Sol architecture/scope → implementation (§8) |
| **P9** | **PENDING** | Final benchmark + full §9 matrix + §10.1 criteria + **Sol verdict** (Commander-owned, never a Worker delegation) |

**Current sequence: P4 close → P5 → P8 → P9.** Do **not** redo P7 (PASS, presentation-only work already verified). Do **not** schedule P6 without its capability gate. Combined Slice B exit stays NOT PASS (non-blocking); overall final exit stays PENDING — no final release/publication claim.

### 3.2 Slice A–E mapping

| Slice | Phases | Status |
| --- | --- | --- |
| A | P0 + P1 | PASS |
| B | P2 + P3 | Implementation/evidence complete; P2 exit PASS; combined exit NOT PASS (non-blocking); does not block C |
| C | P4 | In progress — implementation/review done, closure pending (§6, §7) |
| D | P5 + P7 | P7 portion PASS; P5 portion pending (blocked on P4 only); combined exit PENDING |
| E | P8 (+ P6 iff gate passes) + P9 prep | NOT_STARTED; P9 benchmark/verdict never part of a Worker delegation |

---

## 4. What P4 (Slice C: P4a + P4b) changed

Goal: validation deduplication with strict evidence invalidation — reuse prior validation evidence only while bound hashes and config/dependency/gate state are unchanged; any diff/commit/dependency/config/gate change invalidates cached evidence and forces re-run (§6 P4; §9 rows 6–7).

### 4.1 P4a — validation evidence capture and persistence

- **`extensions/workbench-runtime/core/validation-evidence.ts`** — `ValidationEvidenceBlock` persisted on `RunRecord.validation_evidence` (manifest.json), with EITHER a full `binding` or a bounded `unavailable` block. `ValidationOutcomeSource = "exec" | "cache" | "gate"`; outcome must be `successful: true, complete: true` (failures persist unsuccessful evidence and never flip).
- **Exact invalidation dimensions (binding components):** git HEAD commit; **complete diff hash** (SHA-256 over full content of every changed regular file + path + porcelain status, streamed/bounded memory; a changed non-regular path refuses reuse); **every `KNOWN_LOCKFILES` hash** (exact complete set required — incomplete map or unknown key = corrupt; markers `missing` / `not-a-file` / `too-large`); **relevant workbench config hash** (project/recipes/gates/profiles.yaml, strict fail-closed collection: ENOENT is the only safe "missing" marker, other stat/read errors abort); **effective gate-state hash** (recipes: gate schema hash; gates: schema + hashed manual evidence + bounded worker-first/actor facts + prerequisite status facts gateId → status); `profile` (optional — own property absent when profile-less); `mode` (current runtime mode, never persisted manifest mode).
- **Targets:** recipe binds `name` + `definition_hash` (recipeDefinitionHash) + normalized invocation (`executedArgvHash(raw argv)` for exec with persisted `argv_hash`; action-key argv hash for action-cache materialized records; intended-argv hash on spawn failure) + normalized `cwd`; gate binds `selector` + sorted `requested_gates` + sorted `effective_gates`.
- **Privacy:** a binding persists ONLY bounded hashes, enums and ids — never raw source/config/lockfile content, environment/secret values, manual-evidence text, or argv.
- **Fixed refusal codes** — canonical single runtime allowlist `VALIDATION_REFUSAL_REASONS` (exact-membership only; no consumer duplicates the set), deterministic order: `missing-binding` → `legacy-binding` → `corrupt-binding` → `unavailable-binding` → `unsuccessful-source` → `incomplete-source` → `non-sol-source` → `commit-mismatch` → `diff-mismatch` → `dependencies-mismatch` → `config-mismatch` → `gate-state-mismatch` → `profile-mismatch` → `mode-mismatch` → `target-mismatch` → `collection-failure`.
- **`extensions/workbench-runtime/core/recipe-runner.ts`** — `captureAndPatchRunManifest` (exported, **never throws**): capture failure persists a bounded unavailable block; if even the patch write fails it returns the original no-binding record so returned and persisted records can never disagree and the original exec/cache/spawn outcome is never masked. **P6-C action keys unchanged.**
- **`extensions/workbench-runtime/core/gate-engine.ts`** — gate runs persist `validation_evidence` (block or `unavailableEvidenceBlock(reason)`); `persistedManualEvidence` + capture-hash derivation from persisted manual entries (hashed, never raw); strict `readPersistedGateRunFacts(projectRoot, runId, manifest)` (schema/identity/shape cross-check, extra-evidence rejection, bounded manual notes).
- **`extensions/workbench-runtime/core/runs.ts`** — manifest `validation_evidence?` field; `argv_hash` doc (exec + cache).

### 4.2 P4b — strict current-state assessment on `workbench_read_run`

- **`extensions/workbench-runtime/core/validation-assessment.ts`** — every readable run yields exactly one explicit status **`REUSABLE` | `RERUN_REQUIRED`** with fixed reason codes; reuses the P4a parser/current-state collector/comparator unchanged (no weakening or duplication). Target reconstruction: recipe rebuilt from persisted privacy-safe identity (name + invocation hash) + **currently declared** definition + normalized cwd; persisted `argv_hash` must be a valid 64-hex and exactly equal the binding's invocation hash, else `corrupt-binding` (raw argv never re-derived or rendered); removed recipe fails closed. Gate: current selector/requested/effective resolved against the **current effective catalog** (removed gate or different resolved set = target-mismatch); manual evidence recovered only as a privacy-safe hash; prerequisites re-resolved from latest persisted gate runs; actor/worker-first facts hashed in via a read-only projection (`buildReadOnlyWorkerFirstGateFacts` in `index.ts` — the assessment itself never refreshes or persists delegation state).
- **Fail-closed:** missing/legacy/corrupt/unavailable bindings, failed/incomplete/non-Sol sources and collection failures → `RERUN_REQUIRED` with fixed codes; legacy records (no `validation_evidence`) stay readable and render `RERUN_REQUIRED — missing-binding`. Never throws a reusable result.
- **`extensions/workbench-runtime/core/run-result.ts`** — `validationLine` renderer: `validation : REUSABLE` / `validation : RERUN_REQUIRED — <reasons>` (em dash), in summary and evidence layers; `details.validation = { status, reasons }`; within the §8 caps.
- **`extensions/workbench-runtime/core/render.ts`** — fail-closed `readRunValidation` boundary: canonical allowlist, all-or-nothing (mixed canonical/non-canonical reasons → wholly unavailable), contradiction/injection-safe.
- **All `read_run` include modes** (`summary` default / `manifest` / `logs` / `all`) carry the verdict; caller-bounded tails (`max_lines`/`max_bytes`) unchanged.
- **TUI/static metadata:** `core/tool-catalog.ts` + `index.ts` read_run description/promptSnippet/promptGuidelines state the verdict is a **current-state observation only — it never skips recipe/gate execution and is never acceptance evidence; final recipe/gate runs remain required**.
- **Read-only, no auto-skip, no acceptance:** the assessment never writes under `runs/`, never appends session/delegation entries, never mutates delegation authority, and **never consults or alters the P6-C action cache** (keys/decisions/hits/misses/run counts). P4b wiring tests prove byte/entry/stub/counter invariance across reads.
- **Action-cache independence:** P4a tests in `tests/p6-c-action-cache.test.ts` assert evidence on exec + cache terminals with unchanged cache semantics (same action key, same execution counts, hit behavior preserved; a cached failure persists unsuccessful `source: "cache"` evidence and still reproduces the failure).

### 4.3 Key paths from the P4 work

**Source:** `extensions/workbench-runtime/core/validation-evidence.ts`, `…/validation-assessment.ts`, `…/recipe-runner.ts`, `…/gate-engine.ts`, `…/run-result.ts`, `…/render.ts`, `…/runs.ts`, `…/tool-catalog.ts`, `extensions/workbench-runtime/index.ts`; reused unchanged: `cache/action-key.ts`, `cache/action-types.ts` (`KNOWN_LOCKFILES`), `cache/canonical-hash.ts`.

**Tests:** `tests/validation-evidence.test.ts`, `tests/validation-assessment.test.ts`, `tests/recipe-runner.test.ts`, `tests/gates.test.ts`, `tests/run-result.test.ts`, `tests/tool-renderers.test.ts`, `tests/run-result-wiring.test.ts`, `tests/p6-c-action-cache.test.ts` (P6-C lifecycle + P4a terminal-evidence tests).

**Docs:** `docs/architecture.md` (P4a + P4b sections), `docs/plans/commander-token-optimization.md` (status sync pending, §7 step 6).

**Key P4 implementation delegations (ledger):** `20260805-200824-5b6c` (strict parser/collection, `captureAndPatchRunManifest`, argv_hash wiring), `20260805-202959-qy0w` (evidence + runner/gate/cache-terminal tests, architecture doc), `20260805-204813-i4pz` (optional `profile`), `20260805-210505-pc79` (new `validation-assessment.ts` + wiring), `20260805-211949-47ch` (argv_hash cross-check, `readPersistedGateRunFacts`, `validationLine`), `20260805-213748-bdpu` + `20260805-214147-z61r` (gate persisted-manual-evidence hash, `tests/validation-assessment.test.ts`), `20260805-220137-latq` (run-result validation-line tests), `20260805-220956-v5gf` (tool-renderers tests), `20260805-221912-z7ar` (canonical refusal-code tuple, fail-closed `readRunValidation`), `20260805-223511-739w` + `20260805-224731-09hl` + `20260805-225535-zwm5` (registered-runtime P4b tests: fresh-Sol manual gate run, legacy adversarial `missing-binding` verdict + read-only invariance). Also `20260805-222802-ffkz` (env-clearing hooks in `tests/commander-advisory-wiring.test.ts` — fixes the worker-env-dependent advisory test).

---

## 5. Verification evidence (accurately qualified)

| What | Run ID | Recorded result | Qualification |
| --- | --- | --- | --- |
| Latest Worker `typecheck` | `20260805-225717-z08m` | PASS (exit 0) | Worker-run (write-free recipe), during/for `20260805-225535-zwm5`; not Commander verification |
| Latest Worker `unit-test` | `20260805-225717-lv42` | PASS — 1055/1055 (exit 0) | Same; covers the zwm5 legacy-record additions |
| Commander no-cache `unit-test` | `20260805-224233-59b8` | PASS — 1054/1054 | Commander-run, but **predates the final gate/legacy wiring additions** (`20260805-224731-09hl` gate test + `20260805-225535-zwm5` legacy adversarial test) — does **not** cover the current diff |
| Final `check` on current diff | — | **NOT RUN** | No `check` recipe has been run on the current P4 diff |
| Base gates / B6 on current diff | — | **NOT RUN** | Historical gate runs (`20260805-141242-tyt8`, `20260805-160158-udt6`, `20260805-170509-y7re`) validated earlier hashes only; **historical runs do not validate the current hash** |

- Worker-run recipe evidence is never acceptance; final `check`/gates are Commander-owned (§7).
- The P4b test suite count grew across the slice (999/1000 → 1048 → 1053 → 1055) as the final tests landed; only `20260805-225717-lv42` (1055/1055) and `20260805-224233-59b8` (1054/1054) are the current evidence set.
- Nothing here claims P4 PASS or final-release PASS.

---

## 6. Exact immediate next task — P6-C action-cache independence test

**Delegate one focused Worker task (standard spend profile):**

- **Expected path:** `tests/p6-c-action-cache.test.ts` (file exists — P6-C store/recipe-runner lifecycle + P4a terminal-evidence tests live there; the delegation extends it at that path per the delegation contract. Exact allowed paths are fixed by Sol at delegation time.)
- **Purpose:** prove the P4 read/assessment surface cannot interact with the action cache:
  - a `workbench_read_run` read (and the `REUSABLE`/`RERUN_REQUIRED` assessment it renders) **cannot change the action key** (same inputs → same action key);
  - cannot change **cache decisions/materialization/store** (no record written, altered, or removed; no cache-index/CAS change);
  - cannot change the **execution counter** (no auto-execute);
  - **cannot auto-execute or auto-skip** (no-cache still never reads/writes; refresh still executes; a failure is never flipped);
  - the **next explicit recipe/gate invocation keeps normal semantics**: same-input → normal `hit` with the same action key and **no re-execution** (hit adds a new run manifest, never overwrites).
- **No P6-C cache-key source changes are expected** — preserve action-cache independence; this test is the P4/P6-C separation proof, not a new feature.
- **Review the complete actual diff** (whole-diff scope check vs parent-approved paths + hash binding) **before any verification**; then the Worker runs the write-free `typecheck`/`unit-test` recipes; then proceed to §7.

---

## 7. P4 closure procedure (Commander-owned, in order)

1. **Resolve live state:** `workbench_project_inspect`; `workbench_delegation_status` — require the latest delegation REVIEWED with current diff hash == reviewed hash (a pending/stale review or hash mismatch blocks further work). Resolve the live hash — do not trust §1.3's pre-document value as current.
2. **Commander no-cache `typecheck`** (`workbench_run_recipe typecheck`, `cache: no-cache`).
3. **Commander no-cache `unit-test`** (expect 1055+ with the §6 test landed).
4. **Commander no-cache `check`** (typecheck + unit-test + `git diff --check`), uncached.
5. **List/read the b0–b6 gate definitions** (gate catalog) and **provide the exact required manual evidence**: b2.2/b2.3 (boundary + error-path) and b3.2/b3.3 (smoke) are `manual` checks requiring Commander evidence from the actual diff and recipe runs; b4/b5 manual items as applicable; a required NOT_RUN never passes.
6. **Run the base gates** on the current diff (b1/b2/b3 + B6; all-gate `/q-gate all`).
7. **Only then** delegate the Worker docs-sync of `docs/plans/commander-token-optimization.md` status/evidence (§13 rows, header, closing status: P4 exit PASS/evidence, P5 READY_TO_START, §6 next-task record) — Commander writes are denied, so the status sync is a Worker delegation; then Sol actual-diff review of that documentation change and **re-verify** (the docs change alters the diff hash, so final `check`/gates must be re-run after it, exactly as the plan's §12 post-execution recording requires).

---

## 8. Development basis for what comes next

### 8.1 P5 (milestone session/handoff lifecycle — Slice D remainder)

Start with a **bounded gap analysis delegation**: state-recovery mechanisms already exist (`tests/p5-state-recovery.test.ts`, the session-resume sections in both plans, worker handoff bounds `worker/handoff.ts` 120 lines / 12,288 bytes, additive ledger records). The analysis must identify what P5 must add (bounded milestone handoff notes, session-resume state, handoff points so long sessions stop accumulating silently) vs what already exists, then Sol approves the scope, then a bounded implementation delegation lands.

### 8.2 P8 (WebSocket recovery, persist-first IDs — Slice E)

Unknown scope: split into **bounded diagnosis → Sol architecture/scope decision → bounded implementation**. Requirements: durable IDs for runs/diffs/tools/results so reconnect/recovery reuses persisted artifacts by ID instead of re-fetching/re-inlining; fail-closed on missing IDs; no duplicate inlining after reconnect. Depends on P5, P7.

### 8.3 P9 (final benchmark + verdict)

Commander-owned: re-measure §2 metrics vs the P0 baseline on comparable milestones; report aspirational §10.2 targets (≥80% inline-byte reduction, ≥25% call reduction, ≥40% gross-token reduction) **as measured-or-not**; run the full §9 matrix + §10.1 release-blocking criteria; **Sol issues the verdict — never turn a miss into PASS** (P3's 0.0 reduction must be reported).

### 8.4 P6 rules

Capability-gated (like the worker repair's Phase 6): no implementation until Sol verifies Pi capability to observe/optimize the commander compaction summary without regressing cache stability, fail-closed behavior, or §4 constraints, and approves a fresh design. Without the gate, P6 stays NOT_SCHEDULED.

### 8.5 Quality matrix rows 1–11 (all release-blocking at P9; §9 of the plan)

| Row | Scenario | Slice / state |
| --- | --- | --- |
| 1 | Green recipe summary ≤ caps + full-log path | A — done |
| 2 | Failure summary precedence (status → failing tests → first root cause, bottom-up truncation) | A — done |
| 3 | Warning-with-exit-0 surfaced | A — done |
| 4 | Segmented diff: whole-diff scope + hash binds every segment | B — done |
| 5 | Hidden out-of-scope path fails review, machine-checked | B — done |
| 6 | Stale hash → evidence invalid, reuse refused until re-run | C — P4 implemented |
| 7 | Config/dependency/diff/commit/gate-state change invalidates evidence | C — P4 implemented |
| 8 | WebSocket recovery persist-first, fail-closed on missing ID | E — P8 pending |
| 9 | Advisory soft/high only, zero hard-stop paths | D — P7 done |
| 10 | Legacy records parse unchanged, additive only | all — P4 legacy fail-closed done |
| 11 | Worker `standard` default and budgets byte-identical; repair plan untouched | all — holds |

### 8.6 Release-blocking criteria (§10.1) and stop conditions (§11)

**Release-blocking (P9 verdict requires all):** (1) every §9 row with recorded recipe/gate evidence; (2) every §4 constraint holds vs the actual diff + machine-backed checks; (3) logs/reports/patch sources persisted and path-referenced; (4) whole-diff scope + hash binding on every reviewed slice; (5) no hard-stop path for Commander budgets; (6) cache stays enabled with cache-telemetry guarantees; (7) Worker delegation semantics unchanged, repair plan untouched; (8) P9 benchmark recorded vs P0 with targets measured-or-not; (9) rollback/stop conditions documented as not triggered.

**Stop conditions:** P6 gate fails → NOT_SCHEDULED (others proceed); any §4 violation or §9 regression (esp. rows 5, 6, 7, 9, 11) → stop, fix at root, re-review; evidence-invalidation or stale-hash reuse failure → stop until proven; any attempted Commander hard stop or cache disablement → stop (both forbidden); Worker budget drift → stop, revert the slice.

**Rollback:** each slice's git diff reverted and re-reviewed; data additive-only (no migration/rewrite); never touches worker delegation semantics, identity, or review state.

### 8.7 Publication steps

P9 verdict → Sol release decision → version bump / CHANGELOG entry **only with Sol's release decision** (release notes are Sol's, not the Worker's — worker repair plan §11); publication remains pending until then; the only push action ever is the normal user `git push origin main` (§9). No final release/publication claim exists today.

---

## 9. Strict continuation rules (bind every delegation and every session)

- [ ] **No Commander writes** — all changes (source, tests, docs, plan-status sync) go through reviewed Worker delegations inside exact parent-approved paths.
- [ ] **Every Worker diff reviewed** — whole-diff scope check vs approved paths + whole-diff hash binding, complete displayed-path coverage; pending/stale review blocks the next delegation and VERIFY.
- [ ] **Exact project-relative paths** in every delegation (absolute-path attempts are rejected by scope enforcement).
- [ ] **Final gates Commander-owned** — `check`, `typecheck`, `unit-test` in VERIFY and base gates b0–b6 + B6 run by Sol; Workers run only write-free declared recipes; Worker prose never acceptance; a required NOT_RUN never passes.
- [ ] **Preserve all evidence** — logs, manifests, session JSONL, patches, run/gate/delegation/benchmark records (additive only; no deletion/rewrite; keep `.pi/workbench/runs/commander-token-p3-benchmark/` and every `review.json`).
- [ ] **Static batching only** (the P3 policy) — no dynamic/agentic batching ever.
- [ ] **P7 presentation-only** — advisory warnings never kill review, fixes, verification, handoff, or user response; zero hard-stop paths.
- [ ] **No orchestration** — no new background processes, daemons, queues, or sandboxes; unchanged pi-native architecture.
- [ ] **No force push, no tags, no package publish** — the only push is the normal user `git push origin main` after Sol's release decision.
- [ ] **Worker spend budget `standard`** — bounds cumulative spend only; never expands parent-approved path/scope authority; worker budgets/context safety unchanged.
- [ ] **P6 stays NOT_SCHEDULED** without the capability gate; **P7 is not redone**; **P3's measured FAIL is never rewritten or claimed as savings**.

---

## 10. Session-start checklist (memoryless session)

1. `workbench_project_inspect` — repo/git/recipes (expect `main` @ `aa2301763d95`, dirty).
2. `git status` / `git log` — confirm the dirty working tree carries the optimization work; never "clean" it.
3. `workbench_delegation_status` — resolve the **live current/reviewed diff hash** and latest delegation review state; do not treat §1.3's pre-document hash `9c44b23a…` as current after this document.
4. Read this handoff, then `docs/plans/commander-token-optimization.md`, then `docs/plans/worker-token-budget-repair.md`.
5. Execute §6 (P6-C independence test delegation) → review → §7 (P4 closure) → P5 gap analysis (§8.1).
