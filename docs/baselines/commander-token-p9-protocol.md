# Commander Token Optimization — P9 Benchmark Protocol (frozen before final results)

| Field | Value |
| --- | --- |
| Record | P9 benchmark protocol — **frozen method and limitations only; no dynamic P9 result** |
| Plan | `docs/plans/commander-token-optimization.md` (durable contract; P9 in §6, aspirational targets in §10.2, execution status in §13) |
| Frozen | 2026-08-06 |
| Analyzer | `scripts/commander-token-benchmark.ts` (offline CLI, `npm run commander:benchmark`); machine facts only |
| P0 reference | `docs/baselines/commander-token-p0.md` (pinned facts below — reported, never used as a comparison denominator) |
| P3 reference | `docs/baselines/commander-token-p3.md` + `analysis.json` (preserved cohorts are historical supporting evidence) |
| Status | **PROTOCOL FREEZE ONLY — no P9 result, no phase PASS, no release verdict, no plan status change, no CHANGELOG entry, no publication claim is made by this document** |
| Owner | GPT-5.6 Sol commander (measurement, quality matrix, verdict) |
| P6 | NOT_SCHEDULED (capability-gated; §6 of the plan) |

This document freezes the P9 benchmark method **before** any final P9
measurement. It is the harness contract the offline analyzer implements and
the protocol Sol executes at P9. It records no dynamic P9 result: every
numeric value below is either a pinned reference fact copied from an
already-recorded baseline document or a frozen protocol constant. The
plan's §12 evidence-placeholder discipline applies unchanged: dynamic
values (fresh session filenames, the executed manifest, the analyzer
output, run IDs) are resolved at execution time and are never pre-filled
here.

---

## 1. Purpose and status

P9 (§6) re-measures the §2 metrics on the fresh final-current cohort,
reports the §10.2 aspirational targets as measured-or-not (every strict
P0-based target is frozen NOT_MEASURABLE; the only measured target
arithmetic runs between the pinned P3 pre cohort and the fresh
final-current cohort — §3.4), runs the §10.1 release-blocking quality
matrix, and ends in the Sol verdict. This protocol freezes the measurement
method so the final result cannot be shaped after the fact:

- **What is frozen here:** the analyzer contract, the manifest schema, the
  pinned reference facts, the fact semantics, the target arithmetic and
  thresholds, the cohort requirements, the fail-closed conditions, the
  privacy boundary, and the limitations that must be read with any result.
- **What is not here:** any current-cohort measurement value, any dynamic
  ACHIEVED/MISSED/NOT_MEASURABLE outcome, any PASS/FAIL verdict, any plan
  status change, any publication claim. (The always-NOT_MEASURABLE P0
  targets and the target classification rules are frozen protocol
  constants, fixed in §3.4 — not results.)
- **Ownership:** P9 measurement, the §10.1 matrix run, and the final
  verdict are commander-owned (plan §4.3, §7 Slice E). Workers never run
  final gates and never claim PASS; this protocol doc is the harness
  contract, not acceptance evidence.

---

## 2. Frozen references

### 2.1 P0 reference (pinned facts — reported, not a comparison basis)

Source: `docs/baselines/commander-token-p0.md` (§1). The analyzer reports
these exact pinned facts, which the P9 manifest must carry in
`p0_reference`:

| Fact | Pinned value |
| --- | --- |
| Commander requests | 187 |
| Commander input tokens | 1,530,854 |
| Commander output tokens | 111,430 |
| Commander cacheRead tokens | 21,961,216 |
| Commander cacheWrite tokens | 0 |
| Commander gross tokens (`input + output + cacheRead + cacheWrite`) | 23,603,500 |
| Tool-result inline text bytes | 3,276,725 |

P0 recorded **no isError split**: the P0 inline-byte fact is the **total**
tool-result text bytes. The P0 total is therefore **never used as a
successful-bytes denominator** — no matched successful-bytes basis exists
against P0. Every strict P0-based aspirational target (§10.2) is **ALWAYS
NOT_MEASURABLE** with a fixed basis-incomparable reason: P0 is one
long-lived commander session (187 requests, 23.6M gross tokens), a
different scale and basis from the short 3-session cohorts, so comparing a
short cohort sum to the P0 session is not a comparable measurement; no
ACHIEVED/MISSED classification is ever derived from such a comparison.

### 2.2 Fixed comparable milestone prompt

Source file: `.pi/workbench/runs/commander-token-p3-benchmark/milestone-prompt.txt`
(read-only repository evidence milestone).

Prompt identity: the **SHA-256 of the extracted first user-message text**
in each Session JSONL (concatenated text parts of the first user message),
**not** a raw file-byte hash of `milestone-prompt.txt` — the same
definition the P3 analyzer used (P3 record §8 step 3).

Pinned extracted-text hash (frozen from the P3 record §4.3, identical
across all six P3 sessions):

```
01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f
```

Every declared session — baseline and current — must hash to exactly this
value or the analyzer fails closed (PROMPT_MISMATCH).

### 2.3 Preserved P3 reference (historical supporting evidence)

Source: `docs/baselines/commander-token-p3.md`; evidence root
`.pi/workbench/runs/commander-token-p3-benchmark/` (six fresh sessions,
frozen ABBAAB order, zero compactions, environment captured in
`environment.txt`: provider/model `openai-codex` / `gpt-5.6-sol`, thinking
high, Pi 0.83.0, Node v26.4.0).

Pinned P3 reference facts (frozen from the P3 record §5.2 and
`analysis.json`, schema_version 1, SHA-256
`5cd71bddb3132d7306868c5a5a18bd1aa1aaf4a4ce4a2fefb97ee924beddc221`):

| Fact | Pinned value |
| --- | --- |
| pre cohort total requests | 8 |
| current cohort total requests | 8 |
| request reduction ratio `(8 − 8) / 8` | 0.0 |
| P3 request-savings verdict (frozen rule: PASS only if current < pre) | FAIL |

**P3 0.0 request reduction must be reported by P9** (plan §10.2 and §13 row
2): the manifest carries these pinned facts in `p3_reference`, the analyzer
machine-verifies their internal consistency (ratio and verdict must
reproduce the frozen rule) and reports them; the three preserved P3 **pre**
sessions are declared in the baseline cohort so their measured totals are
also reported as supporting evidence. The preserved P3 **current**
sessions (`current-1..current-3`) are historical evidence only and are NOT
part of the P9 baseline. The accepted non-blocking FAIL is neither weakened
nor rerun; no savings are claimed from it.

### 2.4 Baseline session files (for the manifest)

Exactly the three preserved P3 **pre** Session JSONL files, recorded in the
P3 record §4.3 (project-relative under
`.pi/workbench/runs/commander-token-p3-benchmark/`):

| Label | File | Pinned raw-byte SHA-256 (§4.3) |
| --- | --- | --- |
| pre-1 | `sessions/pre-1/2026-08-05T10-54-10-323Z_019fd18f-3193-739d-97ca-4d1b28fd4310.jsonl` | `08b7467e3945b913d8a7e5f81cb890cc057078ed6b50973f7d4dff4c3f5744ec` |
| pre-2 | `sessions/pre-2/2026-08-05T10-56-52-803Z_019fd191-ac43-76fd-962f-9d77cb9d8e42.jsonl` | `a245d51db3a030f69028af82d80ffdfb3870c9ef68c099d43b3d7df2c331a899` |
| pre-3 | `sessions/pre-3/2026-08-05T10-57-23-421Z_019fd192-23dd-7ce3-b719-4b92182f9bf5.jsonl` | `93aad011fbccd7b60b380f4825c3b4d9ebb753c1fe91da424a17b412b5cd677b` |

At P9, the analyzer's reported per-run `session_sha256` values for these
three sessions must reproduce the pinned hashes exactly (byte-identity of
the preserved evidence). The preserved P3 current sessions
(`current-1..current-3`, hashes `a337b1b3…`, `0664d81d…`, `eef8c1f1…` in
the P3 record §4.3) remain historical evidence; they are never declared in
the P9 manifest. The P9 **current** cohort is exactly the three fresh
final-current sessions (`final-current-1..final-current-3`), whose
expected raw-byte SHA-256 values are resolved at collection time.

---

## 3. Offline analyzer contract

### 3.1 CLI

```
npm run commander:benchmark -- <manifest.json> [--json]
```

- `<manifest.json>` is the strict benchmark manifest (schema below). Its
  path may be absolute on the command line; **session paths inside the
  manifest are relative to the manifest file's directory** and absolute
  paths, drive/UNC paths, NUL bytes and `..` segments are rejected.
- `--json` emits the deterministic JSON report; without it the bounded
  human rendering is emitted.
- Exit codes: `0` success, `1` any fail-closed analysis error (stderr only,
  no partial stdout), `2` usage error.
- The analyzer reads only the manifest and the declared session files. It
  performs no model call, no network access, no provider/cache/session
  state access, and **no file writes** — nothing is persisted, cached or
  modified by the tool itself.

### 3.2 Manifest schema (strict, schema_version 1)

Manifest placement at P9: `.pi/workbench/runs/commander-token-p9-manifest.json`
(the `runs/` evidence root contains both the preserved P3 evidence
directory and the fresh P9 evidence directory, so all session paths are
clean relative paths under one containment root). Unknown keys, a wrong
schema version, a malformed prompt hash, an environment other than the
pinned P3 environment, P0 reference facts other than the pinned facts
(including gross-identity violations), a `p3_reference` that does not
reproduce the frozen rule, malformed sessions, duplicate labels,
duplicate (realpath-equal) session files, and any cohort shape other than
exactly three baseline + three current sessions are all rejected
fail-closed. Every session entry carries `expected_session_sha256` — the
pinned preserved P3 hash for the baseline sessions, the collection-time
raw-byte hash for the fresh current sessions.

```json
{
  "schema_version": 1,
  "milestone_prompt_sha256": "01257273902f43f1ea0f807e75dd1d29ac8a4e39abe354f7ec61179cf911da5f",
  "environment": {
    "model_key": "openai-codex/gpt-5.6-sol",
    "thinking_level": "high"
  },
  "p0_reference": {
    "commander_requests": 187,
    "commander_input_tokens": 1530854,
    "commander_output_tokens": 111430,
    "commander_cache_read_tokens": 21961216,
    "commander_cache_write_tokens": 0,
    "commander_gross_tokens": 23603500,
    "tool_result_text_bytes": 3276725
  },
  "p3_reference": {
    "pre_total_requests": 8,
    "current_total_requests": 8,
    "request_reduction_ratio": 0.0,
    "verdict": "FAIL",
    "rule": "PASS only if current total requests < pre total requests"
  },
  "sessions": [
    { "label": "pre-1", "cohort": "baseline", "path": "commander-token-p3-benchmark/sessions/pre-1/2026-08-05T10-54-10-323Z_019fd18f-3193-739d-97ca-4d1b28fd4310.jsonl", "expected_session_sha256": "08b7467e3945b913d8a7e5f81cb890cc057078ed6b50973f7d4dff4c3f5744ec" },
    { "label": "pre-2", "cohort": "baseline", "path": "commander-token-p3-benchmark/sessions/pre-2/2026-08-05T10-56-52-803Z_019fd191-ac43-76fd-962f-9d77cb9d8e42.jsonl", "expected_session_sha256": "a245d51db3a030f69028af82d80ffdfb3870c9ef68c099d43b3d7df2c331a899" },
    { "label": "pre-3", "cohort": "baseline", "path": "commander-token-p3-benchmark/sessions/pre-3/2026-08-05T10-57-23-421Z_019fd192-23dd-7ce3-b719-4b92182f9bf5.jsonl", "expected_session_sha256": "93aad011fbccd7b60b380f4825c3b4d9ebb753c1fe91da424a17b412b5cd677b" },
    { "label": "final-current-1", "cohort": "current", "path": "commander-token-p9-benchmark/sessions/final-current-1/<fresh-session-file>.jsonl", "expected_session_sha256": "<resolved-at-collection-time>" },
    { "label": "final-current-2", "cohort": "current", "path": "commander-token-p9-benchmark/sessions/final-current-2/<fresh-session-file>.jsonl", "expected_session_sha256": "<resolved-at-collection-time>" },
    { "label": "final-current-3", "cohort": "current", "path": "commander-token-p9-benchmark/sessions/final-current-3/<fresh-session-file>.jsonl", "expected_session_sha256": "<resolved-at-collection-time>" }
  ]
}
```

`<fresh-session-file>` and `<resolved-at-collection-time>` entries are
dynamic placeholders resolved at P9 execution time (plan §12 discipline).
The cohort shape must be exactly three baseline (`pre-1..pre-3`) and three
current (`final-current-1..final-current-3`) sessions; every fresh run must
be declared — no run may be dropped, cherry-picked or replaced after
inspection.

### 3.3 Session fact semantics (buildCostBreakdown-compatible)

The analyzer reuses `buildCostBreakdown` from
`extensions/workbench-runtime/core/cost-breakdown.ts` (the same pure
aggregation `/q-cost-status` uses) with strict input hygiene:

- **Commander requests** — exact count of assistant-message entries
  (turns), usage-independent.
- **Commander token components and gross** — per-run sums of assistant
  usage `input`, `output`, `cacheRead`, `cacheWrite`; gross is exactly
  `input + output + cacheRead + cacheWrite` (Pi's token convention;
  `totalTokens` is never used).
- **Commander cost** — sum of assistant `usage.cost.total`, rounded to 9
  decimals (same convention as the P3 analyzer).
- **Compactions** — exact count of `compaction` session entries.
- **Per-tool and total inline text bytes** — UTF-8 bytes of toolResult
  inline text (string `content` or `content[]` items of type `text`),
  grouped per toolName; byte counting is identical to
  `toolResultTextBytes`.
- **Successful inline bytes** — the same byte counting restricted to
  toolResult messages **not marked `isError: true`**; successful entries
  and bytes are counted separately. Total inline bytes are reported
  separately and are never replaced by the successful figure.
- **Prompt hash** — SHA-256 of the extracted first user-message text; it
  must equal `milestone_prompt_sha256` or the run fails closed. The text
  is hashed only and never rendered or persisted.
- **Session hash** — SHA-256 of the raw session file bytes; it must equal
  the session's `expected_session_sha256` or the run fails closed.
- **Identity facts** — per-run provider/model keys (`provider/model`,
  `responseModel ?? model`), last `thinking_level_change` value, session
  basename, label, cohort. Every assistant message must carry exactly the
  pinned environment model key and the recorded thinking level must equal
  the pinned level.

Input hygiene is strict and fail-closed (the benchmark must not silently
normalize corrupt data): malformed JSONL, a message entry without a
message object, missing user message, missing prompt text, missing
assistant usage, and any present-but-invalid usage fact (non-number,
non-finite, negative, or non-integer token components) reject the whole
analysis with no partial output. Absent usage components contribute zero
(buildCostBreakdown semantics).

### 3.4 Target arithmetic (frozen)

**P0 references — reported, never a comparison denominator.** The pinned
P0 long-session facts (§2.1) are reported, but every strict P0-based
aspirational target (§10.2) is **ALWAYS NOT_MEASURABLE** with a fixed
basis-incomparable reason:

- P0 is one long-lived commander session (187 requests, 23,603,500 gross
  tokens) — a different scale and basis from the short 3-session cohorts,
  so comparing a short cohort sum to the P0 session is not a comparable
  measurement;
- P0 recorded no isError split — its tool-result byte fact (3,276,725
  bytes) is the total of all tool results, so no successful-bytes basis
  exists against P0 and the P0 total is never used as a successful-bytes
  denominator.

These targets carry `reduction_ratio: null` and the fixed reason. No
ACHIEVED/MISSED classification is ever derived from comparing short-cohort
sums against P0, and the reason text never repeats or conflicts with the
structured NOT_MEASURABLE status (each rendered P0 line carries exactly one
status).

**Comparable-milestone arithmetic (the only measured targets).** The same
three aspirational thresholds are computed between **exactly the three
pinned P3 pre sessions** (baseline cohort: `pre-1..pre-3`) and **exactly
the three fresh final-current sessions** (current cohort:
`final-current-1..final-current-3`) — equal-size cohort totals:

| Target (§10.2) | Pre cohort field | Current cohort field | Threshold |
| --- | --- | --- | --- |
| Commander requests | `requests` | `requests` | **≥ 25%** |
| Successful tool-result inline bytes | `successfulTextBytes` | `successfulTextBytes` | **≥ 80%** |
| Commander gross tokens | `gross` | `gross` | **≥ 40%** |

- Reduction ratio per target: `(pre − current) / pre` with the pinned P3
  pre cohort as denominator.
- Classification: `ACHIEVED` when the ratio meets the threshold,
  `MISSED` when it does not, `NOT_MEASURABLE` when the pre denominator is
  zero (never PASS; a zero/invalid denominator can never yield a positive
  outcome). Every classification carries an explicit machine reason with
  the exact pre/current values and threshold.
- Comparisons use exact integer arithmetic
  (`(pre − current) × 1000 ≥ thresholdBasis × pre`); all ratio quantities
  are non-negative integers, so boundary cases (exactly 25%, 80%, 40%)
  are exact.
- These targets are **aspirational and non-release-blocking** (plan
  §10.2): the P9 verdict is governed by the §10.1 matrix only, and targets
  are reported as measured-or-not. Every comparable reason is labelled
  historical comparable-cohort arithmetic — non-causal, not strict P0
  measurement.

### 3.5 Fail-closed conditions (any one rejects the whole analysis, exit 1)

Missing/unreadable/oversized manifest or unsafe manifest basename; invalid
manifest JSON or schema; unknown manifest keys; wrong schema version; a
milestone prompt hash other than the frozen hash; an environment other
than the pinned `openai-codex/gpt-5.6-sol` / thinking `high`; P0 reference
facts other than the pinned facts (including gross-identity violations);
a P3 reference that does not reproduce the frozen rule exactly (rule
string, ratio, verdict); session labels, basenames, paths, model keys,
thinking levels or tool names that are not bounded safe identifiers;
duplicate labels; any cohort shape other than exactly the three pinned
baseline sessions (`pre-1..pre-3` with their pinned hashes) and exactly
the three final-current sessions; a baseline session hash other than its
pinned preserved P3 hash; absolute/drive/UNC/NUL/`..` session paths;
session realpath outside the manifest directory (symlink escapes);
duplicate realpaths; missing/unreadable/non-regular/oversized session
files; malformed JSONL; missing user message or prompt text; missing
assistant usage; invalid usage facts (non-finite/negative/non-integer/
over-bound); session raw-byte hash mismatch; prompt-hash mismatch;
assistant model key or recorded thinking level different from the expected
environment. Every one of these rejects the whole analysis with no partial
output.

### 3.6 Privacy boundary (hard)

Output — JSON and human rendering — contains only: manifest labels, session
basenames, hashes (session, prompt), counts, numeric facts, model keys,
thinking level, pinned reference facts, and the fixed protocol path. It
never contains message bodies, tool arguments, raw tool-result content,
thinking text, secrets, or absolute input paths. Error messages use
basenames only. The analyzer never inspects tool arguments at all and
byte-counts result text without storing or rendering it (same boundary as
the P0 attribution, `docs/security.md`).

---

## 4. Cohort requirements

- **Baseline cohort (pinned preserved P3 pre sessions):** exactly the
  three preserved P3 pre sessions (§2.4), labelled `pre-1`, `pre-2`,
  `pre-3`, cohort `baseline`. Each carries its pinned preserved P3
  raw-byte SHA-256; the analyzer enforces byte-identity and rejects any
  other baseline label, count or hash. The preserved P3 **current**
  sessions (`current-1..current-3`) are historical evidence only and are
  NOT part of the P9 baseline. The pinned P3 reference (§2.3) is reported
  alongside.
- **Current cohort (final-current, fresh):** exactly three newly executed
  sessions of the same fixed milestone prompt, labelled
  `final-current-1`, `final-current-2`, `final-current-3`, cohort
  `current`, with the **same provider/model and thinking level** as the P3
  environment (`openai-codex` / `gpt-5.6-sol`, thinking high), normal
  cache behavior, and **every run retained** — no run may be excluded for
  any reason, including outlier tool activity (mirroring the P3 record's
  retention of `current-3`). Their expected raw-byte SHA-256 values are
  resolved at collection time and declared in the manifest.
- Any cohort shape other than exactly 3 baseline + 3 current sessions
  fails closed.

---

## 5. Frozen limitations (must be read with any result)

- **No causal claim.** The analyzer reports machine facts and pinned
  arithmetic; it attributes nothing. Target ratios are arithmetic facts on
  the declared bases, not proof that any optimization caused them.
- **P0 is not a comparison basis.** P0 is a long-lived commander session
  (187 requests, 23.6M gross tokens); the comparable-milestone cohorts are
  short fresh sessions. Every strict P0-based target is therefore **ALWAYS
  NOT_MEASURABLE** (§3.4), and no classification is ever derived from
  comparing short cohort sums against P0. The pinned P3 pre sessions are
  the matched-milestone historical reference for the comparable
  arithmetic; the P3 0.0 request reduction stays reported.
- **P0 total bytes are not a successful-bytes denominator.** P0 recorded
  no isError split (§2.1): its byte fact is the total of all tool results,
  so the successful-bytes target has no matched basis against P0 and is
  always NOT_MEASURABLE. The comparable successful-bytes arithmetic
  (pre vs current) uses only the successfully byte-counted tool results of
  the two short cohorts.
- **Small cohorts.** n = 3 pinned P3 pre sessions (baseline) and n = 3
  fresh final-current sessions (current); the preserved P3 current
  sessions are not part of the P9 baseline. No statistical power is
  claimed.
- **Environment-specific.** P3 was captured on Pi 0.83.0 / Node v26.4.0 /
  npm 12.0.2 (`environment.txt`); re-measurement on other versions is not
  directly comparable.
- **Prompt identity is extracted-text based** (§2.2), not a
  `milestone-prompt.txt` file-byte hash.
- **Targets are aspirational** (§10.2): missing a target never blocks
  release; only the §10.1 matrix governs the P9 verdict.

---

## 6. P9 execution steps (commander-owned)

1. Collect the fresh final-current cohort (exactly three sessions) under
   `.pi/workbench/runs/commander-token-p9-benchmark/sessions/` using the
   fixed milestone prompt, same provider/model/thinking; retain every run.
2. Write the manifest at
   `.pi/workbench/runs/commander-token-p9-manifest.json` with the pinned
   references (§2), the exact environment
   (`openai-codex/gpt-5.6-sol`, thinking `high`), the three pinned
   baseline sessions with their preserved hashes, and the three
   final-current sessions with their collection-time hashes (§3.2);
   resolve the `<fresh-session-file>` and
   `<resolved-at-collection-time>` placeholders at execution time.
3. Run the offline analyzer:
   `npm run commander:benchmark -- .pi/workbench/runs/commander-token-p9-manifest.json --json`.
4. Verify the machine output: every declared run retained; baseline
   session hashes reproduce the pinned P3 pre hashes and every prompt
   hash reproduces the frozen milestone hash; the P0 reference targets are
   NOT_MEASURABLE with their fixed reasons; the comparable-milestone
   classifications and reasons are self-consistent; the JSON is
   deterministic for the same inputs.
5. Map the machine facts to the §10.1 quality matrix and the §10.2
   aspirational targets (P0 references reported as always NOT_MEASURABLE;
   comparable arithmetic reported as measured-or-not), record the
   benchmark evidence (including the P3 0.0 request reduction), and issue
   the Sol verdict. Final `check`/gates and the verdict remain
   commander-owned (plan §4.3).

---

## 7. Explicit non-claims

This protocol doc:

- records **no** P9 result, no target outcome, no phase PASS, no release
  verdict, no plan status change, and no publication claim — the plan's
  §13 status lines are untouched by this document;
- does not alter or weaken the frozen P3 rule or the recorded P3 FAIL
  (0.0 request reduction), which P9 must report;
- does not claim that the aspirational targets are release-blocking;
- leaves P6 NOT_SCHEDULED (capability-gated) and makes no P6 design or
  capability claim;
- makes no claim about worker budgets/defaults, caching, or any §4
  immutable constraint beyond restating them;
- is a harness contract for Sol's measurement — it is not acceptance
  evidence and cannot be cited as a PASS by any worker report.
