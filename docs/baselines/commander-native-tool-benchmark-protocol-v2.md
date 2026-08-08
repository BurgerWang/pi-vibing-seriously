# Commander Native Tool Optimization — NRO Benchmark Protocol v2 (pre-collection freeze)

| Field | Value |
| --- | --- |
| Record | NRO protocol-v2 — **pre-collection frozen contract only** |
| Status | **NO v2 cohort has been collected — this protocol is prepared and frozen offline only** |
| Schema/protocol version | `schema_version: 2` **and** `protocol_version: 2` for **both** the v2 collection record and the v2 manifest |
| v1 preserved | The v1 NRO protocol, evidence, and result record are **immutable**: the v1 record is an **N4 FAIL / DO NOT ADOPT** verdict and is **never reinterpreted or promoted** by anything in this protocol |
| Paid collection | **Fresh paid collection requires a later separate explicit user authorization**; this document authorizes nothing |
| This phase | Offline implementation and verification may proceed, but **collection, prepare, and formal analyze are not run in this phase** |
| Implementation status | **N2b (`grep output: "files"`) and N3 (`find` count/max_depth) remain NOT_RUN** |
| Owner | GPT-5.6 Sol commander (requirements, review, gates, final verdict) |

This document normatively freezes the **pre-collection** protocol-v2
contract for a **fresh independent** NRO benchmark cohort. It is
prepared and frozen offline only: **no v2 cohort has been collected**,
no v2 session, attempt, evidence directory, manifest, or result record
exists, and none is created by this document. Dynamic values (session
filenames, the executed manifest, analyzer output, run IDs) are
resolved at execution time by a later, separately authorized phase and
are never pre-filled here.

---

## 1. Purpose and status

Protocol v2 measures whether the native `read`/`grep`/`find` overrides
reduce commander-session token consumption without reducing correctness,
on a **fresh cohort** collected under a **fresh protocol version**
(schema_version 2). This document freezes the v2 method **before** any
v2 collection so the final result cannot be shaped after the fact:

- **What is frozen here:** the schema/protocol version, the arms and
  collection discipline (fixed ABBA interleave, exactly 20 valid runs
  per arm, exactly 40 valid sessions, zero compactions, every started
  raw retained, max 60 successfully-started paid attempts, dev/final
  separation), the frozen v2 inputs, the four content pins, the
  correctness rubric (six fact checks), the exact-ID read-attribution
  policy, the manifest and collection-record schemas, the four
  efficiency thresholds and their exact arithmetic, the fail-closed
  conditions, and the limitations that must be read with any result.
- **What is not here:** any measured value, any ACHIEVED/MISSED
  outcome, any PASS/FAIL verdict, any plan status change, any
  publication claim, and any collection, prepare, or formal analyze
  run.
- **Status:** **no v2 cohort has been collected; this protocol is
  prepared and frozen offline only**. Offline implementation and
  verification may proceed, but **collection, prepare, and formal
  analyze are not run in this phase**. Fresh paid collection requires a
  later separate explicit user authorization.
- **Implementation status:** **N2b and N3 remain NOT_RUN** — nothing in
  this document changes, re-labels, or re-runs any slice status.
- **Ownership:** requirements, review, final gates, and the final
  verdict are commander-owned; this protocol doc is a harness contract,
  not acceptance evidence.

## 2. Preservation of v1 (immutability contract)

- The v1 NRO protocol, its evidence, its manifest, and its result
  record are **immutable**. The v1 result record is an **N4 FAIL /
  DO NOT ADOPT** verdict and is **never reinterpreted, re-litigated,
  or promoted** by protocol v2: no v2 artifact, report, or analysis may
  cite v1 evidence as support, and no v1 artifact is modified, moved,
  renamed, overwritten, or re-analyzed.
- The **current v1 cohort cannot be re-analyzed under v2**: v1
  sessions, attempts, manifests, and evidence are v1-only and are never
  an input to any v2 analysis. **Only a fresh v2 cohort can support a
  future decision** under this protocol.
- v2 output names are **independent** — no overwrite, reuse, or alias
  of any v1 artifact (§3.1): a distinct v2 collection root, a distinct
  v2 evidence root, a distinct v2 manifest name, and a distinct v2
  staging prefix. A future v2 collector/prepare must refuse any
  pre-existing or racing output with exclusive-create semantics
  (mirroring the v1 commit discipline, §5).
- The v1 protocol document (`docs/baselines/commander-native-tool-
  benchmark-protocol.md`) remains the binding v1 contract; this
  document neither amends nor supersedes it. The v1 content pins are
  reproduced here **only** because the v2 prompt, fixture, and
  non-treatment bundle are byte-copies of the v1 inputs (§3.2) — that
  is a property of the frozen v2 inputs, not a reuse of v1 evidence.

## 3. Frozen protocol constants

### 3.1 Structural constants (frozen pre-collection)

| Constant | Value | Meaning |
| --- | --- | --- |
| `schema_version` | **2** | Strict schema version of the v2 manifest **and** the v2 collection record (§5); any other value fails closed |
| `protocol_version` | **2** | Normative protocol version carried by **both** v2 records (§5); any other value fails closed |
| `protocol_doc` | `docs/baselines/commander-native-tool-benchmark-protocol-v2.md` | This document; the only accepted `protocol_doc` value in v2 records |
| Runs per arm | **20** | Exactly 20 valid sessions per arm; any other count fails closed |
| Total sessions (final) | **40** | Exactly 40 valid sessions (20 control + 20 treatment) |
| Interleave | **ABBA** | Fixed collection order: positions 1..40 follow ABBA repeated 10 times — position 1 control, 2 treatment, 3 treatment, 4 control, 5 control, … |
| Max paid attempts | **60** | Hard cap on successfully-started paid attempts (§4.5) |
| p90 rank | **18/20** | Gross p90 = nearest-rank 90th percentile: rank `ceil(0.9 × 20)` = the **18th smallest of 20** |
| Zero compactions | required | Every valid v2 session must record zero `compaction` entries |
| Environment | `openai-codex/gpt-5.6-sol`, thinking `high`, Pi `0.83.0`, Node `v26.4.0` | Same pinned environment as v1 |
| Preview facts marker | `nro-read-facts:` | The exact machine-readable facts line a read preview must emit (§6.3) — frozen here so the analyzer and the override share one contract |
| Fixture marker exclusion | forbidden | No v2 fixture file may contain the substring `nro-read-facts:` |
| Attempt labels | `attempt-1..attempt-N` | Chronological, gapless; a gap fails closed (dropped attempt) |
| Session labels | `control-01..control-20`, `treatment-01..treatment-20` | Zero-padded per-arm occurrence numbers |
| Attribution policy | `tool_call_id_exact_v2` | The v2 exact-ID read-attribution policy identity (§6.4) |
| Correctness policy | `six_fact_semantic_v2` | The v2 six-fact semantic rubric policy identity (§7) |
| v2 collection root | `.pi/workbench/runs/commander-native-tool-v2-final-collection/` | Distinct v2 final-collection output root (future v2 collector, exclusive create) |
| v2 evidence root | `.pi/workbench/runs/commander-native-tool-benchmark-v2/` | Distinct v2 evidence directory (future v2 prepare, exclusive create) |
| v2 manifest | `.pi/workbench/runs/commander-native-tool-benchmark-v2-manifest.json` | Distinct v2 strict manifest name (exclusive create) |
| v2 staging prefix | `.nro-v2-prepare-staging-` | Distinct v2 prepare staging prefix (never collides with the v1 prefix) |
| v2 inputs | `fixtures/commander-native-tool-benchmark-v2/inputs/` | The frozen v2 inputs tree (§3.3) |

### 3.2 Content pins (resolved at the v2 freeze — before any collection)

The following pins are **protocol constants**, resolved and recorded at
the v2 fixture-freeze step **before any v2 collection**. An unresolved
or drifted pin makes future v2 `prepare` and `analyze` **fail closed**
(`PROTOCOL_NOT_FROZEN` or a pin-drift error) — no v2 evidence may be
committed or analyzed against an unfrozen protocol.

| Pin | Definition | Resolved value (frozen) |
| --- | --- | --- |
| `milestone_prompt_sha256` | SHA-256 of the raw bytes of the frozen `milestone-prompt.txt` (no trailing newline) | `1af10ebb1abfec5aba9744841980da66c9ee8e12720d589caa623350fb608a40` |
| `fixture_manifest_sha256` | Deterministic fixture-manifest hash over the frozen v2 fixture tree (same function as v1 §5.2) | `062b3c92a8a36825394f0fa80b94808f2457ca5b63e8bbf9a70ff24339c216b6` |
| `rubric_sha256` | SHA-256 of the raw bytes of the frozen schema-2 `rubric.json` | `6c223da4c117f4af857be20f1dab43b495f62eced638bfd4a9a2db80e0026046` |
| `non_treatment_sha256` | Deterministic content-manifest hash over the frozen non-treatment bundle: `AGENTS.md` + everything under `skills/` + `prompts/` + `templates/` | `7cbb545284d1f69aea04248b41a9466cb3aa53a39e8a6456291d410c59d28738` |

The v2 milestone prompt and the v2 fixture tree are **byte-copies of
the v1 inputs**, so their pins reproduce the v1 pins exactly; the v2
non-treatment bundle is the same frozen bundle, so its pin equals the
v1 pin. The schema-2 rubric is a **genuine v2 revision** (schema_version
2; the `unicode` pattern accepts both spaced and unspaced comma forms,
§7), so its pin **differs from the v1 rubric pin**. Post-hoc changes to
pins, denominators, statistics, or thresholds are forbidden; any needed
change requires a new protocol version approved before any new
collection.

### 3.3 Frozen v2 inputs

The frozen v2 inputs tree is `fixtures/commander-native-tool-benchmark-
v2/inputs/` with exactly four direct children:

- `fixture/` — the frozen fixture tree, a **byte-copy of the v1
  fixture tree** (same relative file list, every file byte-identical;
  no symlinks); its deterministic manifest hash equals the frozen
  `fixture_manifest_sha256`;
- `milestone-prompt.txt` — the frozen milestone prompt, a **byte-copy
  of the v1 prompt** (no trailing newline); its SHA-256 equals the
  frozen `milestone_prompt_sha256`;
- `environment.txt` — exactly the four frozen lines in fixed order:
  `model_key: openai-codex/gpt-5.6-sol`, `thinking_level: high`,
  `pi_version: 0.83.0`, `node_version: v26.4.0` (no extra content; a
  **byte-copy of the v1 environment file**);
- `rubric.json` — the frozen **schema-2 rubric** (§7), whose raw-byte
  SHA-256 equals the frozen `rubric_sha256` and differs from the v1
  rubric pin.

Future v2 `prepare` preflights this tree against all four pins before
any write; any drift fails closed.

## 4. Arms and collection discipline

### 4.1 Arms (treatment = the only permitted difference)

- **Control arm:** the **same current runtime source** as the treatment
  arm (`extensions/workbench-runtime/index.ts` default export,
  unchanged), loaded through the dedicated final-control adapter that
  suppresses exactly the three canonical NRO registrations (`read`,
  `grep`, `find`) so the Pi built-in tools remain in effect for those
  three names — the same current-runtime control mechanism frozen in
  v1.
- **Treatment arm:** the same current runtime source loaded directly,
  with the N1/N2 overrides registered (and N3 only if it is ever
  implemented and approved).
- Both arms run the same frozen v2 inputs and cwd (cwd = the frozen v2
  fixture root), the same milestone prompt text, the same pinned
  environment, and identical non-treatment inputs. Tool names and order
  are identical across arms; the only permitted difference is the three
  tools' override metadata/schema/behavior. **No other treatment
  changes are permitted**: the treatment arm differs from control in
  nothing except those overrides.
- The v2 analyzer asserts arm equality of every non-treatment input by
  hash (fixture tree, per-session prompt hash, model/thinking
  identity, manifest environment, non-treatment bundle pin); any
  deviation fails closed.

### 4.2 Collection order (frozen ABBA)

The 40 final session positions are fixed: position `i` (1-based)
belongs to `control` when `(i − 1) % 4 ∈ {0, 3}` and to `treatment`
otherwise — ABBA repeated 10 times over positions 1..40. Session labels
are assigned by per-arm occurrence (`control-01..control-20`,
`treatment-01..treatment-20`). The analyzer machine-verifies the full
bijection between labels, positions, and arms. Sessions are **fresh
sessions only** (never resumed); the collection record attests this and
the raw session hashes pin the exact bytes.

### 4.3 All started raws retained (representability)

Every collection attempt that is not a valid session — wrong prompt
hash, aborted, errored, compaction present, environment drift,
non-terminal end — is preserved with its raw SHA-256, extracted prompt
SHA-256, category, and bounded terminal facts, is recorded in the
privacy-safe deviations record `collection-deviations.json` inside the
v2 evidence root, and is declared in the v2 manifest's `attempts`
array with gapless `attempt-N` labels. A
dropped attempt (a gap in the labels or a collection-record entry
absent from the manifest) fails closed. An "attempt" that is
machine-observably a valid final session fails closed — attempts can
never hide valid runs.

**Representability (byte-exact retention):** every produced unique
bounded regular JSONL is byte-exact retained and recorded. A started
paid attempt that produces **zero** raw JSONL, **multiple** raw JSONL
files, or **no unique bounded regular JSONL** (a duplicate, non-regular,
symlink, or over-bounded output) is **unrepresentable** in the strict
record: collection **hard-fails** immediately with exit 1, preserves
the existing truthful partial record and attempt directory, and never
continues or fabricates an entry (§4.5).

### 4.4 Dev/pilot evidence is never adoption evidence

Dev-phase and pilot collections (v1 DEV pilot included) are
development evidence only and are **never reported and never promoted**:
a dev/pilot manifest records machine facts at most, all four verdicts
stay `NOT_MEASURED`, and dev artifacts never become v2 final evidence.
Mixing dev sessions into a final manifest is structurally impossible
(phase is manifest-level) and is a protocol violation if attempted.
Under-collection (fewer than 20 valid runs in either arm of a final
manifest) invalidates the benchmark and fails closed.

### 4.5 Max paid attempts (hard cap)

Final-phase collection is bounded by the frozen cap of **60
successfully-started paid attempts** (40 valid sessions + 20 retry
headroom). The cap counts each provider/model process **once it has
been successfully spawned/started**, in chronological order — whether
or not it produces raw session JSONL. Reaching the cap ends final
collection with a **truthful partial final collection**: every produced
attempt and session is retained and recorded exactly as under the
normal discipline (§4.3). The strict collection record has **no
status/cap field** — the exhausted status is reported by the future
collector's bounded CLI/run result, never declared by the record. A
partial collection is **not analyzable and not adoption evidence** —
`prepare` and `analyze` fail closed on under-collection — and it is
never promoted, re-labeled, or re-analyzed as valid evidence;
completing the cohort requires a new protocol revision approved before
any new collection.

## 5. Collection record and manifest (schema_version 2, protocol_version 2)

A future v2 collection produces **two** strict records, **both** with
`schema_version: 2` **and** `protocol_version: 2`, under **independent
paths** that never overwrite or reuse v1 artifacts (§2, §3.1):

- the **v2 collection record** `collection-record.json` inside the v2
  collection root (`.pi/workbench/runs/commander-native-tool-v2-final-
  collection/`) — the chronological log of every retained attempt and
  session, written and re-validated by the future v2 collector;
- the **v2 manifest** `commander-native-tool-benchmark-v2-manifest.json`
  at `.pi/workbench/runs/` — committed by future v2 `prepare` into the
  v2 evidence root `.pi/workbench/runs/commander-native-tool-benchmark-
  v2/` with exclusive-create semantics (a non-recursive `mkdir` for the
  evidence root and an exclusive `open("wx")` for the manifest; any
  pre-existing or racing output is refused, `EXISTING_OUTPUT`; only
  ENOENT means absent; ownership-tracked rollback removes only this
  invocation's own outputs).

Strict rules for **both** records (all fail closed):

- `schema_version` exactly **2** and `protocol_version` exactly **2**;
  `protocol_doc` exactly the v2 protocol path; `phase` exactly `dev` or
  `final`.
- **Strict unknown-key rejection**: every object is parsed with an
  exact allowed-key set; any unknown key rejects the whole record.
- **All four pins in both records**: `milestone_prompt_sha256`,
  `fixture_manifest_sha256`, `rubric_sha256` (in the manifest's
  `rubric.sha256` and the record's frozen-inputs declaration), and
  `non_treatment_sha256` must each equal its frozen pin (§3.2) — the
  v2 collection record carries the frozen non-treatment bundle hash
  captured at collection time, and the v2 manifest carries all four
  pins plus the frozen environment and the frozen six rubric checks.
- `environment` exactly the pinned environment (four bounded safe
  fields: `model_key`, `thinking_level`, `pi_version`, `node_version`).
- Final-phase sessions: exactly 40 (`control-01..control-20`,
  `treatment-01..treatment-20`, each exactly once); `order_index`
  exactly 1..40 in array order; declared arm equals the frozen ABBA arm
  at the position; the label number equals the arm's occurrence number.
- Attempts: labels exactly `attempt-1..attempt-N` in array order
  (gapless); arms valid; categories in the frozen set; paths safe and
  distinct from every session path; every session/attempt carries its
  `expected_session_sha256` (collection-time raw-byte hash).
- Paths inside the records are relative to the record's directory;
  absolute/drive/UNC/NUL/`..` paths are rejected; at most 1000 entries.

Manifest shape (frozen):

```json
{
  "schema_version": 2,
  "protocol_version": 2,
  "protocol_doc": "docs/baselines/commander-native-tool-benchmark-protocol-v2.md",
  "phase": "final",
  "milestone_prompt_sha256": "1af10ebb1abfec5aba9744841980da66c9ee8e12720d589caa623350fb608a40",
  "environment": {
    "model_key": "openai-codex/gpt-5.6-sol",
    "thinking_level": "high",
    "pi_version": "0.83.0",
    "node_version": "v26.4.0"
  },
  "fixture": {
    "path": "commander-native-tool-benchmark-v2/fixture",
    "manifest_sha256": "062b3c92a8a36825394f0fa80b94808f2457ca5b63e8bbf9a70ff24339c216b6"
  },
  "non_treatment_sha256": "7cbb545284d1f69aea04248b41a9466cb3aa53a39e8a6456291d410c59d28738",
  "rubric": {
    "sha256": "6c223da4c117f4af857be20f1dab43b495f62eced638bfd4a9a2db80e0026046",
    "checks": [ { "id": "build", "pattern": "build:\\s*alpha-42\\b" } ]
  },
  "sessions": [
    { "label": "control-01", "arm": "control", "order_index": 1, "path": "commander-native-tool-benchmark-v2/sessions/control-01/<file>.jsonl", "expected_session_sha256": "<collection-time hash>" }
  ],
  "attempts": [
    { "label": "attempt-1", "arm": "control", "path": "commander-native-tool-benchmark-v2/attempts/attempt-1/<file>.jsonl", "expected_session_sha256": "<hash>", "prompt_sha256": "<hash or null>", "category": "prompt_mismatch" }
  ]
}
```

## 6. Session fact semantics

### 6.1 Aggregation

The v2 analyzer reuses the same pure aggregation as v1
(`buildCostBreakdown` / `toolResultTextBytes` semantics): requests
(exact count of assistant-message entries), token components and gross
(`input + output + cacheRead + cacheWrite`), cost (rounded to 9
decimals, descriptive only), compactions (exact count), per-tool and
total inline text bytes, successful inline bytes (toolResult messages
not marked `isError: true`), session raw-byte SHA-256, and wall time
(descriptive only). Input hygiene is strict and fail-closed: malformed
JSONL, missing user message/prompt text/assistant usage/thinking level,
and any present-but-invalid usage fact reject the whole analysis with
no partial output.

### 6.2 Environment identity and final validity

Every assistant message must carry exactly the pinned model key and the
recorded thinking level must equal the pinned `high` — enforced for
final sessions (`MODEL_MISMATCH` / `THINKING_MISMATCH`), recorded (not
enforced) for dev sessions. The manifest environment (pinned Pi/Node
versions) is enforced at manifest level. A **final session** must
record **zero compactions**, must not be aborted or errored, and must
end with a terminal assistant `stop` response; the extracted first
user-message text must hash to the frozen prompt pin — otherwise the
analysis fails closed.

### 6.3 Preview facts marker (frozen contract)

A read preview's facts block must be emitted as a line of the exact
frozen form — **all nine fields, in this order, single spaces**:

```
nro-read-facts: complete=<true|false> returned_lines=<n> returned_bytes=<n> total_lines=<n> total_bytes=<n> omitted_lines=<n> omitted_bytes=<n> next_offset=<n> line_truncated=<true|false>
```

The analyzer detects the block by searching for the substring
`nro-read-facts:` in a read toolResult's inline text and parses to the
end of that line. **The marker must occur exactly once** in a read
result's inline text; a second occurrence anywhere (same line, later
line, or a later concatenated `content[]` text item) is itself
`FACTS_MALFORMED`. A present-but-malformed marker (wrong token count,
unknown key, duplicate key, non-boolean flag, non-integer or over-bound
count) **fails closed**. `complete=false` marks a **preview result**;
`complete=true` marks a complete read. Legacy continuation reads
(explicit `offset`/`limit`) return the built-in result with no facts
block — expected, frozen semantics.

### 6.4 Read attribution: exact-ID policy (`tool_call_id_exact_v2`)

Read results associate to read calls **strictly by exact `toolCallId`**
(never FIFO order, never position). The v2 attribution policy identity
is `tool_call_id_exact_v2`; the pure policy module implements it, and
the v2 analyzer derives pagination facts only through it:

- Read tool calls and read results must carry **valid bounded IDs**: a
  non-empty string of at most 512 UTF-8 bytes; read call paths must be
  non-empty bounded strings (at most 512 UTF-8 bytes) without control
  characters. A missing, empty, over-bounded, or non-string ID — or an
  invalid path — **fails closed** (`INVALID_CALL_ID`,
  `INVALID_RESULT_ID`, `INVALID_CALL_PATH`).
- **Duplicate call IDs** (a second read call reusing a seen id),
  **unknown result IDs** (a result whose id matches no read call),
  **duplicate consumed results** (a second result for an already
  matched id) — all **fail closed**.
- **Provider-error assistant entries never shift attribution**: an
  assistant entry that carries no read tool calls (for example a
  provider-error message) is ignored entirely and never affects any
  association, ordering, or aggregate.
- **Orphan read calls**: a read call with no matching result by the
  end of the session is counted in the diagnostic aggregate
  `orphan_read_calls` and **does not shift any association and does
  not, solely for its orphan status, fail the analysis**. Orphans are
  reported; they never attribute another result to another call.
- **Error results**: a matched result with `isError: true` **consumes
  its id** (the call is matched), increments the aggregate
  `error_read_results`, and contributes **no marker parse, no
  continuation, no preview/obligation/completion fact, and no
  inline-text bytes**. A later retry of the same read needs a **fresh
  ID** — reusing the consumed id fails closed
  (`RESULT_ALREADY_CONSUMED` / `DUPLICATE_CALL_ID`).
- Malformed or duplicate preview-facts markers fail closed
  (`FACTS_MALFORMED`, §6.3). All failure messages are generic and
  privacy-safe (ids, paths, arguments, and bodies are never rendered).

### 6.5 Continuation, obligations, and misuse (machine contract)

Derived per run over the session entries in order, using only the read
tool calls' `path`/`offset`/`limit` fields and the read results' inline
text (arguments are inspected for these fields only and never
rendered):

- **Continuation read** — a successful read call carrying a finite
  integer `offset` and/or `limit`, issued only after an earlier
  successful preview result (`complete=false`) on the **same path**; a
  later successful result for that call counts its inline bytes as
  **continuation bytes**.
- **Obligation** — a successful preview result (`complete=false`), one
  obligation per marker, attributed by exact ID to its read call's
  path.
- **Paginated obligation** — an obligation followed by at least one
  later successful continuation read of the same path.
- **Reached complete** — an obligation followed by a later successful
  read result of the same path carrying the marker with
  `complete=true`.
- **Completion fractions** — `obligationsPaginated / obligations` and
  `reachedComplete / obligations` (both `null` when there are no
  obligations).
- **Incomplete-result misuse (machine sign)** — `obligations > 0` and
  `obligationsPaginated < obligations` (an obligation that lacks any
  later successful continuation): the machine misuse flag. Quoting/
  editing-beyond-preview signs are audited manually against the frozen
  rubric at the final verdict; the analyzer computes the pagination
  sign only.

## 7. Correctness rubric (six fact checks, `six_fact_semantic_v2`)

The rubric is the frozen schema-2 `rubric.json` (§3.3): strict shape
`{ "schema_version": 2, "checks": [ { "id": "<bounded-safe-id>",
"pattern": "<regex>" } ] }` — exactly the **six frozen checks in frozen
order**, unique bounded ids, patterns at most 512 UTF-8 bytes and
compilable as JavaScript regular expressions (search semantics). The
correctness policy identity is `six_fact_semantic_v2`; the v2 policy
module evaluates the checks over the **final assistant message text**.

The six checks and their **exact expected values** (frozen order):

| # | id | Expected fact |
| --- | --- | --- |
| 1 | `build` | `build: alpha-42` |
| 2 | `unicode` | `unicode: α, 水, 🚀` — explicitly accepting **both** `α, 水, 🚀` and `α,水,🚀` (optional whitespace around the commas); missing, wrong, or **reordered** values are rejected |
| 3 | `token` | `token: delta-77` |
| 4 | `needle_occurrences` | `needle_occurrences: 140` |
| 5 | `needle_lines` | `needle_lines: 135` |
| 6 | `needle_files` | `needle_files: 4` |

A run's correctness is `passed = true` exactly when **every** check
matches. Any wrong value, missing fact, reordered unicode sequence, or
absent required line fails exactly that check and the overall result.
The v2 manifest carries the frozen six checks and the frozen rubric
pin; a drifted or malformed rubric fails closed. **All 20 treatment
runs must pass the rubric** — the treatment-arm correctness release
blocker (§8) is 20/20.

## 8. Adoption thresholds and release blockers

The four efficiency thresholds keep the v1 metric definitions, verdict
labels, and exact-integer arithmetic; the frozen v2 values — **unchanged
from v1** — are:

| # | Id | Metric (per valid run) | Threshold | Exact comparison |
| --- | --- | --- | --- | --- |
| 1 | `bytes_median_reduction` | successful inline bytes median reduction | **≥ 50%** | `(Σc − Σt) × 1000 ≥ 500 × Σc` |
| 2 | `gross_median_reduction` | gross tokens median reduction | **≥ 20%** | `(Σc − Σt) × 1000 ≥ 200 × Σc` |
| 3 | `requests_median_non_increase` | requests median | **treatment ≤ control** | `Σt ≤ Σc` |
| 4 | `gross_p90_regression` | gross p90 tail guard | **≤ 105% of control** | `20 × t ≤ 21 × c` |

where `Σc`/`Σt` are the middle-two sums of the control/treatment arm
(median of an even-sized sorted list = mean of the two middle values;
n = 20 per arm, always even) and `c`/`t` are the control/treatment
gross p90 values (nearest rank, the **18th smallest of 20**). All
comparisons use exact integer arithmetic. Status `ACHIEVED` when the
threshold is met (boundary included), `MISSED` when not, and
`NOT_MEASURED` — never PASS — for a zero denominator, an arm with no
runs, or any dev/pilot manifest. Threshold ratios are descriptive
arithmetic facts; they attribute nothing.

**Release blockers (a final verdict requires all):** (1) the
correctness matrix passes and the treatment-arm rubric is **20/20**
(§7); (2) security/mode semantics unchanged — the guard still fires by
exact name and no write path is added; (3) no hidden truncation — every
truncated result carries exact facts and the analyzer-verified
no-hidden-truncation/misuse condition is clean; (4) **edit/write tool
calls are zero** across the cohort (no editing task exists in the
milestone task; any edit/write tool call is recorded and blocks); (5)
commander-owned no-cache `check` and gates pass on the final diff. The
thresholds are adoption criteria, not release gates, and cannot
override the release blockers.

All results under this protocol are **descriptive only**: the analyzer
reports machine facts and pinned arithmetic, makes **no causal claim**
and no statistical-**significance** claim, and never reports a
distributional or significance statement of any kind.

## 9. Execution constraints (this phase)

- **Offline implementation and verification may proceed** — including
  this protocol freeze, the pure constants module, the hermetic tests,
  and the v2 policy modules already landed — but **collection,
  prepare, and formal analyze are not run in this phase**.
- **Fresh paid collection requires a later separate explicit user
  authorization**: no v2 collection may start until a distinct,
  later, explicit user authorization for a v2 paid collection exists.
  This document authorizes nothing and is never cited as collection
  authorization.
- **N2b and N3 remain NOT_RUN**; no slice status changes here.
- **DEV/pilot evidence is never adoption evidence** (§4.4); the
  current v1 cohort **cannot be re-analyzed under v2** (§2); **only a
  fresh v2 cohort can support a future decision** under this protocol.

## 10. Frozen limitations (must be read with any result)

- **No causal claim.** Threshold ratios are arithmetic facts on the
  declared bases, not proof that the overrides caused them.
- **Preview facts dependency.** Preview/pagination metrics depend on
  the frozen marker contract (§6.3) being implemented exactly by the
  read override.
- **Misuse is partially machine-derived.** Only the pagination sign of
  incomplete-result misuse is machine-computed (§6.5); quoting/editing
  signs are audited manually at the final verdict.
- **Fresh-session attestation.** "Fresh sessions only" is attested by
  the collection record and raw-byte hashes; the analyzer cannot detect
  a resumed session from the JSONL alone.
- **Small-cohort statistics.** n = 20 per arm, medians and p90 only;
  no distributional or significance claims.
- **Attempt-cap exhaustion.** Final-phase collection is hard-capped at
  60 successfully-started paid attempts (§4.5); an exhausted cap yields
  a truthful partial final collection that is not analyzable and not
  adoption evidence.
- **Unrepresentable attempts hard-fail.** A started paid attempt that
  produces zero, multiple, or no unique bounded regular JSONL cannot be
  represented in the strict record; collection hard-fails immediately,
  preserving the existing truthful partial record and attempt directory
  (§4.3/§4.5).
- **Environment-specific.** Results apply to the pinned Pi 0.83.0 /
  Node v26.4.0 / provider-model environment only.
- **Non-treatment bundle.** The bundle hash is captured at freeze and
  collection time; it enforces that both arms ran against identical
  non-treatment content — it is not a measurement input.
- **No v2 cohort exists yet.** Every limitation above applies to a
  future cohort; there is nothing measured under v2 today.

## 11. Explicit non-claims

This protocol doc:

- records **no** v2 result, no target outcome, no adoption verdict, no
  plan status change, and no publication claim;
- does **not** alter, weaken, reinterpret, or promote the v1 N4 FAIL /
  DO NOT ADOPT record, and reuses no v1 evidence, manifest, session,
  or result (§2);
- makes no token-savings claim of any kind — nothing is measured under
  v2 yet;
- does not claim the four §8 thresholds are release gates;
- is not collection authorization — fresh paid collection requires a
  later separate explicit user authorization (§9);
- is a harness contract for a future commander-owned measurement — it
  is not acceptance evidence and cannot be cited as a PASS by any
  worker report.
