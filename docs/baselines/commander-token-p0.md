# Commander Token Optimization — Slice A P0 Baseline Record

| Field | Value |
| --- | --- |
| Record | P0 baseline (exact) + conservative P1 inline-byte observation for Slice A |
| Plan | `docs/plans/commander-token-optimization.md` (durable contract; Slice A = P0 + P1) |
| Recorded | 2026-08-05 |
| Capture method | Two user-captured `/q-cost-status` displays; the current snapshot was captured **after a fresh `/reload`**; the prior snapshot (P1 cohort, §2) was captured earlier in the same parent session |
| Source of truth for re-derivation | Persisted Pi Session JSONL / session entries, read via `/q-cost-status` (session entries only — no project config, no trust gate); telemetry/run records supply token/run evidence but alone **cannot** reproduce inline content bytes |
| Privacy boundary | Numeric values, tool names, run IDs, and artifact paths only — no tool arguments, no result text, no prompt/message content (per `docs/security.md`: `/q-cost-status` shows counts, IDs and tool names only) |
| Plan status at record time | Baseline/comparison **recorded**; final full `check`, Commander gates, rollback review, and Slice A exit verdict **PENDING** — no P0/P1 exit and no benchmark savings are claimed by this record |

This record is self-contained evidence for the Commander Token Optimization
Slice A P0 baseline and the conservative P1 inline-byte comparison. It
records **exactly** what the captured `/q-cost-status` displays showed;
where a value was rendered compactly or omitted by the bounded display it
is labeled **unavailable** and is never invented here.

---

## 1. Current P0 snapshot (exact — captured after fresh `/reload`)

### 1.1 Commander cost and token facts (exact, unabridged)

| Fact | Value |
| --- | --- |
| Commander cost | $21.978 |
| Commander gross tokens | **23,603,500** |
| — input | 1,530,854 |
| — output | 111,430 |
| — cacheRead | 21,961,216 |
| — cacheWrite | 0 |
| CacheRead share (rendered) | 93.0% |
| Commander requests (assistant-message turns) | 187 |
| Compactions (commander session) | 4 |

Consistency checks (exact arithmetic on the captured values):

- Gross identity: `1,530,854 + 111,430 + 21,961,216 + 0 = 23,603,500` ✓
- CacheRead share: `21,961,216 / 23,603,500 × 100 = 93.0422…%` → rendered
  `93.0%` at the deterministic one-decimal rule ✓ (non-zero gross, so the
  share is defined)

### 1.2 Cost buckets (worker / other / total)

| Bucket | Cost (exact) | Tokens (as rendered) | Exact token count |
| --- | --- | --- | --- |
| Commander | $21.978 | (see §1.1) | recorded in §1.1 |
| Worker | $0.402 | compact `42M` | **unavailable** — rendered compactly; exact count was not present in the bounded user display |
| Other | $1.357 | compact `190k` | **unavailable** — rendered compactly; exact count was not present in the bounded user display |
| Total | $23.737 | compact `66M` | **unavailable** — rendered compactly; exact count was not present in the bounded user display |

Consistency check (exact arithmetic on the captured costs):

- Cost identity: `$21.978 + $0.402 + $1.357 = $23.737` ✓

The worker/other/total **exact token counts are not recorded** because their
rendered values were compact (`42M` / `190k` / `66M`). They must be
re-derived from the persisted session entries (§5) before any use; this
record does not fabricate them.

### 1.3 Tool-result text bytes (exact)

- **3,276,725 UTF-8 text bytes across 306 tool results** (inline TEXT only —
  counted as bytes, never stored or rendered; tool arguments never
  inspected).

Per-tool rows as rendered by the bounded display (text bytes descending;
`calls / text bytes`):

| Tool name | Calls | Text bytes |
| --- | --- | --- |
| workbench_review_worker_diff | 31 | 1,098,425 |
| read | 91 | 1,017,440 |
| grep | 70 | 777,174 |
| workbench_run_recipe | 12 | 193,036 |
| workbench_delegate_worker | 23 | 83,088 |
| find | 12 | 75,597 |
| workbench_delegation_status | 21 | 9,657 |
| workbench_read_gate | 10 | 7,154 |
| workbench_read_run | 11 | 6,067 |
| workbench_project_inspect | 8 | 2,810 |
| workbench_run_gate | 6 | 2,784 |
| ls | 9 | 2,415 |

**Omitted tool row (explicitly unavailable):** the bounded display rendered
`+1 more tools omitted`, and the exact structured value of that omitted
tool (tool name, call count, text bytes) **was not present in the captured
user display**. It is **not** recorded here and **not** invented; it must be
re-derived from the persisted session entries (§5) if needed.

Derived consistency check (arithmetic only, **not** a captured fact, **not**
per-tool attribution): the 12 displayed rows sum to 3,275,647 bytes across
304 calls; subtracting from the captured total leaves a residual of
**1,078 bytes across 2 calls** attributable *in aggregate* to the omitted
row. Which tool that is, and its exact per-tool row values, remain
unavailable from this capture.

---

## 2. Prior snapshot for the P1 comparison (workbench_run_recipe cohort)

The parent session's earlier `/q-cost-status` capture (pre-dating the two
post-policy Commander verification runs of §4) showed the
`workbench_run_recipe` per-tool row at:

| Snapshot | Calls | Text bytes |
| --- | --- | --- |
| Prior (10-call cohort) | 10 | 191,257 |
| Current (§1.3) | 12 | 193,036 |
| **Delta** | **+2** | **+1,779** |

**Cohort basis:** the first 10 parent-session `workbench_run_recipe` tool
results preceded the two post-policy Commander runs; the two new calls in
the current snapshot are exactly those post-policy Commander verification
runs — `typecheck` and `unit-test` (§4).

---

## 3. Conservative P1 inline-byte comparison (observational)

This is a **conservative inline-byte observation**, not a benchmark. It
attributes the entire captured byte growth to the two new recipe calls and
compares their marginal per-call size against the pre-policy cohort
average.

### 3.1 Arithmetic (exact)

| Quantity | Formula | Value |
| --- | --- | --- |
| Delta calls | `12 − 10` | 2 calls |
| Delta bytes | `193,036 − 191,257` | 1,779 bytes |
| Marginal per-call (new pair) | `1,779 / 2` | **889.5 bytes/call** |
| Historical cohort average | `191,257 / 10` | **19,125.7 bytes/call** |
| Relative reduction (observational) | `(19,125.7 − 889.5) / 19,125.7 × 100` | **95.35%** |

Formula shown in full:

```
relative reduction = (historical cohort average − new-pair marginal average) / historical cohort average × 100
                   = (19,125.7 − 889.5) / 19,125.7 × 100
                   = 18,236.2 / 19,125.7 × 100
                   = 95.3492…%  →  95.35%
```

### 3.2 Cohort basis and limitations (must be read with the number)

- The historical 10-call cohort is **heterogeneous**: it mixes different
  recipes with different output sizes from before the P1 summary policy
  landed; it is not a matched control.
- The new pair is **only two calls** (`typecheck`, `unit-test`), both
  success-path runs whose bounded summaries are expected to be small — a
  two-call sample cannot generalize.
- This is **not a comparable-milestone gross-token benchmark**: gross
  tokens, requests, and compactions were not measured on matched
  milestones.
- It therefore **does not prove causal total-token savings**; the P1
  summary policy's effect on the commander session is observed here only as
  inline recipe-result bytes on two runs.
- It **cannot satisfy the §10.2 P9 aspirational targets**; §10.2 targets
  are measured-or-not at P9 only, and this record makes no such claim.

Label: **observational only** — descriptive, never a savings claim.

---

## 4. Complementary Commander verification runs (post-policy pair)

The two new `workbench_run_recipe` calls in §2 are these Commander-run
verifications (both PASS, both `exit_code 0`, both at git commit
`aa2301763d953d28fa05e06a0080704f3cea20e5`, `git_dirty: true` at run time):

| Run ID | Recipe | Result | Evidence |
| --- | --- | --- | --- |
| `20260805-135054-weh0` | `typecheck` | PASS (exit 0; clean `tsc --noEmit`) | `.pi/workbench/runs/20260805-135054-weh0/` (summary.json, manifest.json, logs) |
| `20260805-135054-6zit` | `unit-test` | PASS 879/879 (exit 0; TAP `tests 879 / pass 879 / fail 0`) | `.pi/workbench/runs/20260805-135054-6zit/` (summary.json, manifest.json, logs) |

These runs are recorded here as the P1 cohort's new pair and as
complementary targeted-verification evidence; they are **not** final gates
and do **not** constitute a Slice A exit.

---

## 5. Re-derivation source and method (reproducibility)

1. **Source:** persisted Pi Session JSONL / session entries. `/q-cost-status`
   derives every fact above from session entries only — no project config,
   no trust gate.
2. **Session path:** the current session file path is **not hardcoded in
   this record**. It must be resolved at runtime via the Pi session manager
   (`sessionManager.getSessionFile()`, falling back to
   `sessionManager.getSessionId()` — the same resolution the workbench
   extension uses in `extensions/workbench-runtime/index.ts`). Do **not**
   guess the path.
3. **Procedure to re-derive:** run a fresh `/reload`, then `/q-cost-status`
   in the commander session, and read the same fields recorded above:
   commander cost; commander gross/component tokens and cacheRead share;
   commander requests; compactions; worker/other/total costs and token
   totals; total tool-result text bytes; and the bounded per-tool rows.
   For values this record labels unavailable (exact worker/other/total
   token counts, the omitted per-tool row), read the exact structured facts
   from the persisted session entries directly (the display bounds them;
   the structured fields do not).
4. **Limits of other sources:** telemetry/run records supply token/run
   evidence but alone cannot reproduce inline content bytes; per-tool
   inline text-byte attribution requires the persisted session entries.
5. **Relationship to plan §2:** the plan's §2 table remains the audited
   point-in-time observation used to size the problem; this record is the
   exact P0 capture that §6 P0's re-derivation step refers to, and any
   future P9 comparison must anchor on this record.
