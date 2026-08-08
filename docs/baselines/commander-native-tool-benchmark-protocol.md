# Commander Native Tool Optimization — NRO Benchmark Protocol (N0 freeze)

| Field | Value |
| --- | --- |
| Record | NRO-N0 benchmark protocol — **frozen method and limitations only; no dynamic NRO result** |
| Plan | `docs/plans/commander-native-tool-optimization.md` (durable contract; NRO protocol in §10, adoption criteria in §11, slices in §12) |
| Effort | **NRO — "Native read/grep/find Override"** — a **new independent effort** with its own protocol, harness, thresholds, slices, and verdict. It is **not** a phase of, extension of, or re-run of the Commander Token Optimization plan (`docs/plans/commander-token-optimization.md`, P0–P9) and it does not reuse or redefine the P9 protocol, P9 baseline, or any P9 artifact |
| P9 preserved | The frozen P9 result is **preserved unchanged and remains authoritative** (`docs/baselines/commander-token-p9.md`); nothing in this protocol reuses, re-reads, re-interprets, or re-runs any P9/P3 artifact, constant, session, or manifest. This protocol has its own frozen fixture, its own prompt, its own manifest/analyzer, its own arms, and its own thresholds (§10, §11 of the plan) |
| Frozen | 2026-08-06 (the N0 slice; content pins §3.2 resolved and recorded at this fixture freeze, before any dev or validation collection — §3.3) |
| Harness | `scripts/commander-native-tool-benchmark.ts` (offline CLI, `prepare` + `analyze` subcommands); machine facts only |
| Status | **PROTOCOL FREEZE ONLY — no NRO result, no verdict, no plan status change, no CHANGELOG entry, no publication claim is made by this document**; the NRO result record (`docs/baselines/commander-native-tool-benchmark.md`) does not exist yet and is written only by the N5 worker slice (§12 of the plan); the plan status stays NOT_MEASURED |
| Refreeze (second) | 2026-08-06 — **second pre-final protocol revision (user-approved)**: the final cohort is refrozen from the initial 30/arm target to exactly 20/arm (40 total, ABBA repeated 10 times), approved **after the DEV pilot and before any final-validation collection**, for cost; the DEV pilot stays `phase: "dev"` and was not promoted or used as final/adoption evidence (§3.4) |
| Refreeze (third) | 2026-08-06 — **third pre-final protocol revision (user-approved)**: the final control arm is clarified to load the **SAME current runtime source** as treatment through the dedicated final-control adapter (`scripts/commander-native-tool-final-control-extension.ts`) that suppresses exactly the three canonical NRO registrations so the Pi built-ins remain — the literal pre-N1 checkout `aa2301763d95` is rejected because the current working tree differs from that committed tree in other uncommitted runtime changes and would confound the only-permitted-difference rule — and max final paid attempts are frozen at **60** (counting each provider/model process once successfully spawned/started, whether or not it produces raw session JSONL; 40 valid + bounded retry headroom); approved **after the DEV pilot and the 20+20 refreeze, before ANY final-validation collection**; an exhausted cap yields a truthful partial final collection that is not analyzable/adoption evidence (§3.5) |
| Owner | GPT-5.6 Sol commander (N4 measurement, correctness audit, adoption verdict) |
| Evidence root | `.pi/workbench/runs/commander-native-tool-benchmark/` (gitignored; created exclusively by the `prepare` subcommand at collection commit time) |

This document freezes the NRO benchmark method **before** any final NRO
measurement. It is the harness contract the offline CLI implements and the
protocol Sol executes at N4. It records no dynamic NRO result: every numeric
value below is either a frozen structural constant or a frozen/reference pin.
Dynamic values (session filenames, the executed manifest, the analyzer
output, run IDs) are resolved at execution time and are never pre-filled
here.

---

## 1. Purpose and status

NRO measures whether the same-name native `read`/`grep`/`find` overrides
(plan §5–§6) reduce commander-session token consumption without reducing
correctness. This protocol freezes the measurement method so the final
result cannot be shaped after the fact:

- **What is frozen here:** the arms, the collection discipline (fixed
  ABBA interleave, exactly 20 valid runs per arm, zero compactions, all
  attempts retained, max final paid attempts, dev/final separation), the fixture contract, the
  prompt identity, the correctness rubric, the manifest schema, the fact
  semantics, the four adoption thresholds and their exact arithmetic, the
  fail-closed conditions, the privacy boundary, and the limitations that
  must be read with any result.
- **What is not here:** any measured value, any ACHIEVED/MISSED outcome,
  any PASS/FAIL verdict, any plan status change, any publication claim.
- **Ownership:** N4 measurement, the correctness audit, and the final
  verdict are commander-owned (plan §12, slice N4 — never a writing
  slice). Workers never run final gates and never claim PASS; this
  protocol doc is the harness contract, not acceptance evidence.

## 2. Independence from P9 (preservation contract)

- The NRO protocol is **new and self-contained**: it does not reuse,
  extend, or redefine `docs/baselines/commander-token-p9-protocol.md`;
  P9 artifacts (its manifest, its six sessions, its P0/P3 reference
  facts, its analyzer output) are **never an input** to the NRO harness
  or analysis.
- The P9 measurement basis (three pinned P3 `pre` sessions vs three
  `final-current` sessions) is **not reused as a denominator, control
  arm, or reference** by NRO (§4). The NRO control arm loads the **SAME
  current runtime source** as the treatment arm through a dedicated
  final-control adapter that suppresses exactly the three canonical NRO
  registrations, so the Pi built-in `read`/`grep`/`find` remain in
  effect — a different, NRO-owned arm definition (§3.5, §4.1).
- NRO has **new** thresholds (§10) that are not the P9 §10.2
  aspirational percentages (25/80/40) — only the plan's §11.2 table.
- Nothing in NRO can change, re-run, or re-interpret the frozen P9
  verdict or the P3 0.0 request FAIL, which stay recorded.

## 3. Frozen protocol constants

### 3.1 Structural constants (frozen at N0)

| Constant | Value | Meaning |
| --- | --- | --- |
| `schema_version` | 1 | Strict manifest schema version (§7) |
| Runs per arm | **20** | Exactly 20 valid sessions per arm (frozen; the user-approved pre-final refreeze of 2026-08-06 reduced the initial 30/arm target to the plan-permitted floor 20/arm — §3.4; any other count fails closed) |
| Total sessions (final) | 40 | 20 control + 20 treatment |
| Interleave | **ABBA** | Fixed collection order, frozen: positions 1..40 follow the ABBA pattern repeated 10 times — position 1 control, 2 treatment, 3 treatment, 4 control, 5 control, … |
| Collection phases | `dev`, `final` | Dev evidence is never reported; only a final manifest is eligible for verdict arithmetic (§4.4) |
| Zero compactions | required | Every final session must record zero `compaction` entries |
| Milestone prompt identity | extracted first user-message text | SHA-256 of the raw bytes of the frozen `milestone-prompt.txt`; every session's extracted first user-message text must hash to it (§6.1) |
| Environment | `openai-codex/gpt-5.6-sol`, thinking `high`, Pi `0.83.0`, Node `v26.4.0` | Pinned per plan §10 (same provider/model/thinking, same Pi version per `package.json`, same Node version per the P9 `environment.txt` — both independent of P9's protocol) |
| Preview facts marker | `nro-read-facts:` | The exact machine-readable facts line the N1 read override must emit (§8.4) — frozen here so the analyzer and the override share one contract |
| Fixture marker exclusion | forbidden | No fixture file may contain the substring `nro-read-facts:` (freeze rule; prevents false preview detection) |
| Attempt labels | `attempt-1..attempt-N` | Chronological, gapless; a gap fails closed (dropped attempt) |
| Session labels | `control-01..control-20`, `treatment-01..treatment-20` | Zero-padded per-arm occurrence numbers (the N-th session of an arm is `NN`), frozen |
| Max final paid attempts | **60** | Hard cap on final-phase paid attempts — each provider/model process counts once successfully spawned/started, whether or not it produces raw session JSONL (40 valid sessions + bounded retry headroom); reaching it ends final collection with a truthful partial collection that is not analyzable/adoption evidence (§3.5, §4.6) |

### 3.2 Content pins (resolved at fixture freeze — before any collection)

The following pins are **protocol constants, resolved and recorded at
the fixture freeze** (a Sol-approved freeze step that also froze the
fixture, prompt, rubric, and non-treatment bundle record; the harness
hard-codes the same four values). An unresolved or drifted pin makes
`prepare` and `analyze` **fail closed with `PROTOCOL_NOT_FROZEN`** (or
a pin-drift error) — no evidence may be committed or analyzed against
an unfrozen protocol.

| Pin | Definition | Resolved value (frozen at fixture freeze) |
| --- | --- | --- |
| `milestone_prompt_sha256` | SHA-256 of the raw bytes of the frozen `milestone-prompt.txt` (no trailing newline) | `1af10ebb1abfec5aba9744841980da66c9ee8e12720d589caa623350fb608a40` |
| `fixture_manifest_sha256` | Deterministic fixture-manifest hash over the frozen fixture tree (§5.2) | `062b3c92a8a36825394f0fa80b94808f2457ca5b63e8bbf9a70ff24339c216b6` |
| `rubric_sha256` | SHA-256 of the raw bytes of the frozen `rubric.json` | `dccfd406a69f7582a5fc44daad420d8e177c993cf3a7110ae11c6686beab74ed` |
| `non_treatment_sha256` | Deterministic content-manifest hash over the frozen non-treatment bundle: `AGENTS.md` + everything under `skills/` + `prompts/` + `templates/` (same hash function as §5.2; captured at freeze time and re-captured in every collection record, §4.5) | `7cbb545284d1f69aea04248b41a9466cb3aa53a39e8a6456291d410c59d28738` |

### 3.3 Pin resolution discipline

The content pins were resolved **once**, at the fixture freeze
(2026-08-06, values recorded in §3.2), which happened **before the
first dev collection and before any final validation collection**, after
Commander approval. Post-hoc changes to pins, denominators, statistics,
or thresholds are forbidden (plan §11); any needed change requires a new
protocol version approved before any new collection.

### 3.4 Pre-final protocol revision (second refreeze, 2026-08-06)

This protocol was refrozen **once** as a second pre-final revision,
**after the DEV pilot and before ANY final-validation collection**:

- **Reason:** user-approved cost reduction of the final cohort from the
  initial 30/arm target to the plan-permitted floor of exactly 20/arm
  (plan §10 collection discipline; the 30/arm target is superseded only
  for the NRO final cohort size).
- **Timing:** approved on 2026-08-06, after the reviewed DEV pilot
  collection (`.pi/workbench/runs/commander-native-tool-dev-pilot-collection/`,
  a dev-phase pilot) and **before any final validation collection** — no
  final session was collected under either N. Consistent with §3.3 and
  plan §11, the change was approved by the user before any new
  collection.
- **DEV pilot:** remains `phase: "dev"` — development evidence only,
  never promoted to, or used as, final or adoption evidence; the
  analyzer reports dev manifests with all four verdicts `NOT_MEASURED`
  (§4.4).
- **Scope of the change:** only the final cohort size — 30+30 → 20+20
  (40 sessions total, ABBA repeated 10 times, positions 1..40, labels
  through 20). All four content pins (§3.2), the environment, the
  fixture, the prompt, the rubric, the ABBA semantics, every threshold
  and statistic definition (§10), the fail-closed conditions, and the
  limitations stay exactly as frozen at N0.

### 3.5 Pre-final protocol revision (third refreeze, 2026-08-06)

This protocol was refrozen a **third** time as a pre-final revision,
**after the DEV pilot and the second (20+20) refreeze and before ANY
final-validation collection**:

- **Final-control arm implementation (clarified and frozen):** control
  and treatment now both load the **SAME current runtime source**
  (`extensions/workbench-runtime/index.ts` default export, unchanged).
  The control arm alone runs that runtime through the dedicated
  final-control adapter (`scripts/commander-native-tool-final-control-
  extension.ts`), which suppresses exactly the three canonical NRO
  registrations (`read`, `grep`, `find` — the `NATIVE_OVERRIDE_NAMES`,
  imported by identity from `extensions/workbench-runtime/core/native-
  tool-policy.ts`) so the Pi built-in tools remain in effect for those
  three names; the treatment arm loads the runtime directly. Every
  other registration and API behavior is delegated unchanged, so the
  arms differ ONLY in the three tools' override metadata/schema/
  behavior — the only-permitted difference. The DEV-pilot control
  approximation (`scripts/commander-native-tool-control-extension.ts`,
  `dev-pilot-control-approximation`) is never used for final collection;
  the final adapter is a separate, independently labeled module.
- **Why the literal pre-N1 checkout was rejected:** `aa2301763d95` (the
  informational git snapshot in the plan) is itself a **reproducible
  committed (clean) pre-N1 tree** — the commit is not dirty. The
  CURRENT working tree carries other uncommitted runtime changes on top
  of that commit, so the old committed runtime and the current
  treatment runtime would differ in more than the three overrides — a
  literal checkout would confound the only-permitted-difference rule.
  The same-runtime-source control isolates the treatment to exactly the
  three registrations.
- **Max final paid attempts frozen at 60:** at most **60 paid
  final-phase attempts** (40 valid sessions + bounded retry headroom of
  20; §3.1/§4.6), counting **each provider/model process once it is
  successfully spawned/started — whether or not it produces raw session
  JSONL** (the cap is not a count of produced raw sessions only). An
  exhausted cap ends final collection with a **truthful partial final
  collection** — every produced attempt and session is retained and
  recorded (§4.3/§4.5), with the exhausted status reported by the
  collector's bounded CLI/run result rather than declared by the strict
  collection record (§4.5) — but such a collection is **not analyzable
  and not adoption evidence** (the strict analyzer and `prepare` fail
  closed on under-collection, §4.4/§9.3) and can never be promoted,
  re-labeled, or re-analyzed as valid evidence.
- **Scope of the change:** the control-arm mechanism and the attempt
  cap only. All four content pins (§3.2), **20+20 with ABBA repeated 10
  times**, the environment, the fixture, the prompt, the rubric, every
  threshold and statistic definition (§10), attempt retention, dev/final
  separation, and the limitations stay exactly as frozen at N0.
- **No collection occurred:** no final session or attempt exists under
  any revision; this revision records no dynamic NRO result and nothing
  here is acceptance evidence.

## 4. Arms and collection discipline

### 4.1 Arms (treatment = the only permitted difference)

- **Control arm:** the **same current runtime source** as the treatment
  arm (`extensions/workbench-runtime/index.ts` default export,
  unchanged), loaded through the dedicated final-control adapter
  (`scripts/commander-native-tool-final-control-extension.ts`) that
  suppresses exactly the three canonical NRO registrations (`read`,
  `grep`, `find` — the `NATIVE_OVERRIDE_NAMES`, imported by identity
  from the runtime policy module) so the Pi built-in tools remain in
  effect for those three names — pristine built-in `read`/`grep`/`find`
  on the SAME current runtime (§3.5).
- **Treatment arm:** the same current runtime source loaded directly,
  with the N1/N2 (and N3, if approved) overrides registered (plan §7).
- Both arms run the **same frozen fixture content and cwd** (cwd = the
  frozen fixture root, §5), the **same milestone prompt text**, the
  **same provider/model/thinking** (pinned environment, §3.1), the
  **same Pi version**, the **same Node version**, and **identical
  non-treatment inputs** (the frozen bundle, §3.2). Tool **names and
  order are identical across arms**; the only permitted difference is the
  three tools' override metadata/schema/behavior — that difference **is**
  the treatment and is recorded as such in the collection record and
  manifest. A literal pre-N1 checkout is **not** the control arm: it
  would differ in other uncommitted runtime changes and confound the
  only-permitted-difference rule (§3.5).
- The analyzer asserts arm equality of every non-treatment input by hash:
  the fixture tree hash (§9), the per-session prompt hash, the per-session
  model/thinking identity, the manifest environment, and the
  non-treatment bundle pin — any deviation fails closed.

### 4.2 Collection order (frozen ABBA)

The 40 final session positions are fixed: position `i` (1-based) belongs
to `control` when `(i − 1) % 4 ∈ {0, 3}` and to `treatment` otherwise.
Equivalently, the first four positions are control, treatment, treatment,
control, repeated 10 times. Session labels are assigned by per-arm
occurrence: the N-th control session is `control-0N`, the N-th treatment
session is `treatment-0N`. The analyzer machine-verifies the full
bijection between labels, positions, and arms (§9). Sessions are **fresh
sessions only** (never resumed); the collection record attests this and
the raw session hashes pin the exact bytes.

### 4.3 All attempts retained (deviations)

Every collection attempt that is not a valid session — wrong prompt hash,
aborted, errored, compaction present, environment drift, non-terminal end —
is **preserved in the deviations record** (`collection-deviations.json`)
with its raw SHA-256, extracted prompt SHA-256, category, and bounded
terminal facts, and is declared in the manifest's `attempts` array with
gapless `attempt-N` labels. A dropped attempt (a gap in the labels or a
collection-record entry absent from the manifest) fails closed. An
"attempt" that is machine-observably a valid final session fails closed
(`ATTEMPT_NOT_INVALID`) — attempts can never be used to hide valid runs.

### 4.4 Dev vs final separation

- **Dev collections** (`phase: "dev"`): runs collected during N1–N3
  development. They are development evidence only and are **never
  reported**: the analyzer records their machine facts but the four
  §11.2 verdicts are always `NOT_MEASURED` with a fixed dev-phase reason.
- **Final validation collections** (`phase: "final"`): collected only
  after the protocol and implementation are frozen and
  Commander-approved. Only a final manifest is eligible for verdict
  arithmetic; a final manifest must contain exactly 40 sessions (20 per
  arm, ABBA order) and every session must satisfy final validity
  (prompt hash, environment, zero compactions, terminal stop) — any
  violation fails closed. Mixing dev sessions into a final manifest is
  structurally impossible (phase is manifest-level) and is a protocol
  violation if attempted.
- Under-collection (fewer than 20 valid runs in either arm of a final
  manifest) invalidates the benchmark and fails closed.

### 4.5 Collection record (immutable collection log)

The commander produces an immutable collection record (JSON,
`collection-record.json`, schema_version 1) at collection time — the
chronological log of every retained attempt and session. Its strict
schema:

```json
{
  "schema_version": 1,
  "phase": "final",
  "non_treatment_sha256": "<frozen non-treatment bundle hash captured at collection time>",
  "entries": [
    { "kind": "session", "arm": "control", "path": "sources/run-01.jsonl" },
    { "kind": "session", "arm": "treatment", "path": "sources/run-02.jsonl" },
    { "kind": "attempt", "arm": "treatment", "path": "sources/attempt-a.jsonl" }
  ]
}
```

- Entries are in chronological order; paths are **relative to the
  collection record's directory** (absolute/drive/UNC/NUL/`..` paths are
  rejected); at most 1000 entries.
- `non_treatment_sha256` is captured at collection time and must equal
  the frozen pin (arm equality by construction; any drift fails closed).
- For `phase: "final"`, the session entries (in order) must be exactly
  40 and their arms must match the frozen ABBA pattern at each session
  position; the `prepare` subcommand enforces this and the manifest
  inherits the derived labels/order.
- The `prepare` subcommand copies the record byte-for-byte into the
  evidence directory (retained as the paper trail for "all attempts
  retained").
- The strict record has **no status/cap field** — it truthfully
  contains only the chronological, representable entries produced
  (sessions and attempts), and it never declares cap exhaustion or any
  other run-level status; an exhausted cap is reported by the
  collector's bounded CLI/run result (§4.6).
- **Representability (byte-exact retention):** every produced **unique
  bounded regular JSONL** is byte-exact retained and recorded. A
  started paid attempt that produces **zero** raw JSONL, **multiple**
  raw JSONL files, or **no unique bounded regular JSONL** (a duplicate,
  non-regular, symlink, or over-bounded output) is **unrepresentable**
  in the strict record: collection hard-fails **immediately with exit
  1**, preserves the existing truthful partial record and attempt
  directory, and **never continues or fabricates an entry** (§4.6,
  §11.2).

### 4.6 Max final paid attempts (hard cap)

Final-phase collection is bounded by the frozen cap of **60 paid
attempts** (40 valid sessions + 20 retry headroom; §3.1/§3.5). The cap
counts **each provider/model process once it has been successfully
spawned/started**, in chronological order — **whether or not it
produces raw session JSONL**. A started paid process that produces no
raw session JSONL still counts against the cap; the cap is **not** a
count of produced raw sessions only. Reaching the cap ends final
collection with a **truthful partial final collection**: every produced
attempt and session is retained and recorded exactly as under the
normal discipline (§4.3, §4.5). The strict collection record schema
(§4.5) has **no status/cap field** — it truthfully contains only the
chronological representable entries produced; the **exhausted status is
reported by the collector's bounded CLI/run result**, not declared by
the record. A started paid attempt whose output is unrepresentable in
the strict record (zero, multiple, or no unique bounded regular JSONL)
hard-fails immediately with exit 1, preserving the existing truthful
partial record and attempt directory, and never continues or fabricates
an entry (§4.5, §11.2). Such a partial collection is **not analyzable
and not adoption evidence** — the analyzer and `prepare` fail closed on
under-collection (§4.4, §9.3) — and it is never promoted, re-labeled,
or re-analyzed as valid evidence; completing the cohort requires a new
protocol revision approved before any new collection (§3.3).

## 5. Frozen fixture contract

### 5.1 Fixture content

The frozen fixture is a synthetic tree under
`commander-native-tool-benchmark/fixture/` (inside the evidence
directory, §11). It contains, per plan §10: small files, files **above
the preview caps** (240 lines / 12 KiB, plan §6.1), a Unicode file, an
image, a `.gitignore`, and nested directories. The milestone task (with
the prompt, §6) is defined over this tree, including a **complete-read
obligation exercised through pagination** (the task requires facts that
are only obtainable by reading a file larger than the preview caps —
either explicitly with `offset`/`limit` or by following the preview
facts). The fixture is frozen byte-for-byte before any collection; its
content never contains the substring `nro-read-facts:`.

### 5.2 Fixture-manifest hash (deterministic)

The fixture-manifest hash is computed as: walk the tree (regular files
and directories only; symlinks and any other entry type fail closed),
collect every file's relative POSIX path and raw-byte SHA-256, sort by
relative path (code-unit order), then SHA-256 over the concatenation of
`"<relativePath>:<sha256>\n"` per file. Bounds: the tree is at most
64 MiB total and 10,000 files; every relative path is at most 512 UTF-8
bytes and contains no control characters. The same hash function defines
the non-treatment bundle hash (§3.2).

## 6. Milestone prompt and correctness rubric

### 6.1 Prompt identity

The frozen milestone prompt is the exact content of
`milestone-prompt.txt` (no trailing newline) inside the frozen inputs.
`milestone_prompt_sha256` = SHA-256 of that file's raw bytes. Every
session's **extracted first user-message text** (concatenated text parts
of the first user message, exactly the P3/P9 extraction definition) must
hash to this value or the run fails closed (`PROMPT_MISMATCH`). The
prompt text is never rendered or persisted by the harness except as the
frozen file itself.

### 6.2 Correctness rubric

The rubric is the frozen `rubric.json` inside the frozen inputs
(schema_version 1): a list of machine-checkable assertions on the
**final assistant message text** (the milestone-task answer). Strict
shape: `{ "schema_version": 1, "checks": [ { "id": "<bounded-safe-id>",
"pattern": "<regex>" } ] }` — at least one check, at most 32 checks,
unique bounded ids, patterns at most 512 UTF-8 bytes and compilable as a
JavaScript regular expression (search semantics). A run's correctness is
`passed = true` exactly when **every** pattern matches the final
assistant text. The rubric is executed by the analyzer and frozen with
the fixture (its raw-byte hash is pinned; the manifest carries the
frozen checks). The fixture freeze step designs the milestone task so
that the rubric requires facts about the fixture — including facts whose
collection exercises the complete-read pagination obligation.

## 7. Manifest schema (strict, schema_version 1)

The analyzer reads exactly one strict manifest. Unknown keys, a wrong
schema version, a wrong `protocol_doc`, a wrong phase, any pin drift, an
unsafe/over-bound identity string, malformed sessions or attempts,
duplicate labels, duplicate realpaths, count/label/arm/order drift, and
path escapes are all rejected fail-closed (§9). Every session entry
carries `expected_session_sha256` (collection-time raw-byte hash,
enforced). Manifest placement at collection commit time:
`.pi/workbench/runs/commander-native-tool-benchmark-manifest.json`
(paths inside the manifest are relative to the manifest file's
directory).

```json
{
  "schema_version": 1,
  "protocol_doc": "docs/baselines/commander-native-tool-benchmark-protocol.md",
  "phase": "final",
  "milestone_prompt_sha256": "1af10ebb1abfec5aba9744841980da66c9ee8e12720d589caa623350fb608a40",
  "environment": {
    "model_key": "openai-codex/gpt-5.6-sol",
    "thinking_level": "high",
    "pi_version": "0.83.0",
    "node_version": "v26.4.0"
  },
  "fixture": {
    "path": "commander-native-tool-benchmark/fixture",
    "manifest_sha256": "062b3c92a8a36825394f0fa80b94808f2457ca5b63e8bbf9a70ff24339c216b6"
  },
  "non_treatment_sha256": "7cbb545284d1f69aea04248b41a9466cb3aa53a39e8a6456291d410c59d28738",
  "rubric": {
    "sha256": "dccfd406a69f7582a5fc44daad420d8e177c993cf3a7110ae11c6686beab74ed",
    "checks": [ { "id": "fact-1", "pattern": "<regex>" } ]
  },
  "sessions": [
    { "label": "control-01", "arm": "control", "order_index": 1, "path": "commander-native-tool-benchmark/sessions/control-01/<file>.jsonl", "expected_session_sha256": "<collection-time hash>" }
  ],
  "attempts": [
    { "label": "attempt-1", "arm": "control", "path": "commander-native-tool-benchmark/attempts/attempt-1/<file>.jsonl", "expected_session_sha256": "<hash>", "prompt_sha256": "<hash or null>", "category": "prompt_mismatch" }
  ]
}
```

Strict rules (all fail closed):

- `schema_version` exactly 1; `protocol_doc` exactly the frozen protocol
  path; `phase` exactly `dev` or `final`.
- `milestone_prompt_sha256`, `non_treatment_sha256`, `fixture.manifest_sha256`,
  `rubric.sha256`, every `expected_session_sha256`, every attempt
  `prompt_sha256` (or `null`): 64-hex SHA-256 strings (null only allowed
  for an attempt prompt hash); each must equal its frozen pin.
- `environment` exactly the pinned environment (four bounded safe
  fields: `model_key`, `thinking_level`, `pi_version`, `node_version`).
- `fixture.path`: non-empty, at most 512 UTF-8 bytes, no NUL; resolved
  relative to the manifest directory and contained by realpath (§9).
- `rubric.checks`: 1..32 checks, unique bounded safe ids, bounded
  compilable patterns.
- Final phase sessions: exactly 40 (`control-01..control-20`,
  `treatment-01..treatment-20`, each exactly once); `order_index`
  exactly 1..40 in array order; declared arm equals the frozen ABBA arm
  at the position; the label number equals the arm's occurrence number
  at that position. Dev phase sessions: at least one; labels follow the
  same `arm-0N` convention by per-arm occurrence; `order_index`
  strictly increasing from 1; no ABBA/count constraints.
- Attempts: labels exactly `attempt-1..attempt-N` in array order
  (gapless — a dropped attempt fails closed); arms valid; categories in
  the frozen set (§8.6); paths safe and distinct from every session
  path.

## 8. Session fact semantics

### 8.1 Aggregation (buildCostBreakdown reuse)

The analyzer reuses `buildCostBreakdown` and `toolResultTextBytes` from
`extensions/workbench-runtime/core/cost-breakdown.ts` — the same pure
aggregation `/q-cost-status` uses — with strict input hygiene:

- **Requests** — exact count of assistant-message entries (turns),
  usage-independent.
- **Token components and gross** — per-run sums of assistant usage
  `input`, `output`, `cacheRead`, `cacheWrite`; gross is exactly
  `input + output + cacheRead + cacheWrite` (Pi's token convention).
- **Cost** — sum of assistant `usage.cost.total`, rounded to 9 decimals
  (descriptive only; never a threshold input).
- **Compactions** — exact count of `compaction` entries.
- **Per-tool and total inline text bytes** — UTF-8 bytes of toolResult
  inline text (string `content` or `content[]` text items), grouped per
  toolName (toolName-sorted), identical byte semantics to
  `toolResultTextBytes`.
- **Successful inline bytes** — the same byte counting restricted to
  toolResult messages **not marked `isError: true`**; successful
  entries/bytes counted separately; totals reported separately.
- **Session hash** — SHA-256 of the raw session file bytes; must equal
  `expected_session_sha256`.
- **Wall time** — milliseconds between the first and last session-entry
  timestamps (both must be valid ISO timestamps and the diff must be
  non-negative and ≤ 30 days; otherwise `null`); descriptive only.

Input hygiene is strict and fail-closed: malformed JSONL, a message
entry without a message object, missing user message, missing prompt
text, missing assistant usage, missing recorded thinking level (final
phase), and any present-but-invalid usage fact (non-number, non-finite,
negative, non-integer token components, over-bound) reject the whole
analysis with no partial output. Absent usage components contribute zero
(buildCostBreakdown semantics). Tool names must be bounded safe
identifiers.

### 8.2 Per-session environment identity

Every assistant message must carry exactly the pinned model key
(`provider/(responseModel ?? model)`) and the recorded (last)
`thinking_level_change` value must equal the pinned thinking level —
enforced for final sessions (`MODEL_MISMATCH` / `THINKING_MISMATCH`),
recorded (not enforced) for dev sessions. The manifest environment
(pinned Pi/Node versions) is enforced at manifest level.

### 8.3 Terminal facts and final validity

Bounded terminal facts: last entry type, last message role, last
assistant `stopReason` (from the fixed known sets), `terminalStop`,
`aborted`, `errored`. A **final session** must record zero compactions,
must not be aborted or errored, and must end with a terminal assistant
`stop` response — otherwise the analysis fails closed
(`COMPACTION_PRESENT` / `ABORTED` / `ERRORED` / `NOT_TERMINAL_STOP`).

### 8.4 Preview facts marker (frozen contract with the N1 override)

The read override's facts block (plan §6.1) must be emitted as a line of
the exact frozen form (all nine facts, in this order, single spaces):

```
nro-read-facts: complete=<true|false> returned_lines=<n> returned_bytes=<n> total_lines=<n> total_bytes=<n> omitted_lines=<n> omitted_bytes=<n> next_offset=<n> line_truncated=<true|false>
```

The analyzer detects a facts block by searching for the substring
`nro-read-facts:` in a **read** toolResult's inline text and parsing to
the end of that line. A read result carrying the marker with
`complete=false` is a **preview result**; `complete=true` marks a
complete read. A marker that is present but malformed (unknown key,
missing key, non-boolean flag, non-integer or over-bound count) fails
closed (`FACTS_MALFORMED`). Legacy continuation reads (explicit
`offset`/`limit`) return the built-in result with no facts block (plan
§6.1) — that is the expected, frozen semantics.

### 8.5 Pagination, obligations, and misuse (machine contract)

Derived per run over the session entries in order, using only the read
tool calls' `path`/`offset`/`limit` arguments and the read results'
inline text (arguments are inspected for these three fields only and are
never rendered):

- **Continuation read** — a read tool call carrying an explicit `offset`
  and/or `limit` whose path had at least one earlier preview result.
- **Obligation** — a preview result (`complete=false`). Its path is the
  path of the read call that produced it (matched by FIFO order of read
  calls and results; unknown when no call is attributable).
- **Paginated obligation** — an obligation followed by at least one
  continuation read of the same path.
- **Reached complete** — an obligation followed by a read result of the
  same path carrying the marker with `complete=true` (only observable
  when the model performs such a read; legacy pagination results carry
  no marker by design — §8.4).
- **Completion fractions** — `obligationsPaginated / obligations` and
  `reachedComplete / obligations` (both `null` when there are no
  obligations).
- **Incomplete-result misuse (machine sign)** — `obligations > 0` and
  `obligationsPaginated < obligations` (an obligation read that was not
  paginated). Quoting/editing-beyond-preview signs are audited manually
  against the frozen rubric at N4 (plan §10); the analyzer computes the
  pagination sign only.

### 8.6 Attempt classification (frozen priority)

An attempt's category is derived deterministically from its own entries
(prompt hash, environment scan, compactions, terminal facts) in this
exact priority order:

1. extracted prompt hash differs from the pin (non-null hash) →
   `prompt_mismatch`
2. any assistant model key differs from the pin, or the recorded
   thinking level differs → `env_drift`
3. at least one compaction → `compaction_present`
4. terminal `aborted` → `aborted`
5. terminal `errored` → `errored`
6. no terminal assistant `stop` response → `nonterminal`
7. otherwise the attempt is machine-observably valid →
   `ATTEMPT_NOT_INVALID` fail closed (final phase); dev phase records
   `unclassified`.

Attempts are parsed with strict JSONL and usage validation but without
the user/assistant presence requirements (broken sessions are the point
of an attempt); a session with no user message has a `null` prompt hash.
The declared category and prompt hash in the manifest must equal the
derived ones (`CATEGORY_MISMATCH`).

## 9. Analyzer contract

### 9.1 CLI

```
tsx scripts/commander-native-tool-benchmark.ts analyze <manifest.json> [--json]
```

- `<manifest.json>` may be absolute on the command line; **session,
  attempt, and fixture paths inside the manifest are relative to the
  manifest file's directory**; absolute paths, drive/UNC paths, NUL
  bytes, and `..` segments are rejected; realpath containment refuses
  symlink escapes; duplicate realpaths are refused.
- `--json` emits the deterministic JSON report; without it the bounded
  human rendering is emitted. Exit codes: `0` success, `1` any
  fail-closed error (stderr only, **no partial stdout**), `2` usage
  error.
- Read-only: the analyzer reads only the manifest, the declared session
  and attempt files, and the declared fixture tree (to re-verify its
  manifest hash). It performs **no file writes**, no model call, no
  network access, no provider/cache/session state access.
- Deterministic: identical inputs → identical JSON and identical human
  rendering; no timestamps or random values in the report.

### 9.2 Report contents

Per run: label, arm, order index, session basename and hash, prompt
hash and match, requests, input/output/cacheRead/cacheWrite, gross,
cost, compactions, tool-result entries (total/successful), total and
successful inline text bytes, per-tool calls and bytes, model keys,
thinking level, wall time, terminal facts, correctness (per-check and
overall), pagination facts (previews, continuation reads and bytes,
obligations, paginated obligations, reached-complete, completion
fractions, unpaginated previews), and the incomplete-result misuse flag.
Per arm: run count, medians (requests, gross, successful inline bytes),
gross p90, and cohort totals. Attempts are reported with their bounded
facts and verified categories. The report ends with the four frozen
verdicts (§10). The fixture verification result is reported.

### 9.3 Fail-closed conditions (any one rejects the whole analysis, exit 1)

Missing/unreadable/oversized manifest or unsafe manifest basename;
invalid JSON or schema; unknown keys; wrong schema version; wrong
`protocol_doc`; any unresolved content pin (`PROTOCOL_NOT_FROZEN`); pin
drift (prompt, environment, fixture, non-treatment, rubric); malformed
or unbounded rubric; unsafe/over-bound labels, basenames, paths, model
keys, thinking levels, tool names, check ids, arm values, or phases;
duplicate labels; duplicate realpaths; final-phase count/label/arm/order
drift (not exactly 40 sessions, not exactly 20 per arm, wrong labels,
wrong arm at an ABBA position, wrong label–position bijection, gaps or
duplicates in `order_index`); attempt label gaps (`attempt-N` missing);
session/attempt path escapes or missing/unreadable/non-regular/
oversized files; malformed JSONL; missing user message or prompt text;
missing assistant usage; invalid usage facts; session raw-byte hash
mismatch; prompt-hash mismatch; model or thinking mismatch; compaction
present; aborted/errored/non-terminal final sessions; attempt categories
that do not reproduce the frozen derivation; a machine-observably valid
attempt; fixture-tree hash mismatch or an unsafe fixture entry (symlink,
non-regular, over bounds, control characters). Every one rejects the
whole analysis with no partial output.

### 9.4 Privacy boundary (hard)

Output — JSON and human rendering — contains only: manifest labels,
session basenames, hashes (session, prompt, fixture, pins), counts,
numeric facts, model keys, thinking level, arm names, categories,
verdicts, the fixed protocol path, and the manifest-declared relative
fixture path. It **never** contains message bodies, tool arguments, raw
tool-result content, preview facts values, thinking text, secrets, or
absolute input paths. Error messages use basenames only (control
characters replaced, bounded). Tool arguments are inspected for the
three read fields only (§8.5) and result text is byte-counted and
marker-parsed without being stored or rendered.

## 10. Target arithmetic (frozen §11.2 adoption criteria)

Statistics are computed by the frozen analyzer over the declared valid
runs of the final validation cohort only; no run may be dropped after
collection; medians and p90 are the only statistics used for adoption.

**Definitions (frozen):** median of an even-sized sorted list = the mean
of the two middle values (n = 20 per arm, always even). Gross p90 =
nearest-rank 90th percentile: rank `ceil(0.9 × n)` (1-based), i.e. the
18th smallest of 20. All comparisons use exact integer arithmetic on the
middle-two sums (median × 2) or on the p90 values.

| # | Id | Metric (per valid run) | Threshold | Exact comparison |
| --- | --- | --- | --- | --- |
| 1 | `bytes_median_reduction` | successful inline bytes median reduction | **≥ 50%** | `(Σc − Σt) × 1000 ≥ 500 × Σc` |
| 2 | `gross_median_reduction` | commander gross tokens median reduction | **≥ 20%** | `(Σc − Σt) × 1000 ≥ 200 × Σc` |
| 3 | `requests_median_non_increase` | requests median non-increase | **treatment ≤ control** | `Σt ≤ Σc` |
| 4 | `gross_p90_regression` | gross p90 tail guard | **≤ 105% of control** | `20 × t ≤ 21 × c` |

where `Σc`/`Σt` are the middle-two sums of the control/treatment arm and
`c`/`t` the control/treatment gross p90 values. Ratios are reported for
display: reduction `(Σc − Σt) / Σc` (= `(median_c − median_t) /
median_c`) for #1–#3 and `t / c` for #4.

- Status `ACHIEVED` when the threshold is met (boundary included),
  `MISSED` when not.
- Status `NOT_MEASURED` — never PASS — when the control reference value
  is zero (zero denominator: `Σc = 0` or `c = 0`) or an arm has no
  runs; every `NOT_MEASURED` carries the fixed zero-denominator reason.
- Dev-phase manifests: all four verdicts are `NOT_MEASURED` with the
  fixed dev-phase reason (development evidence is never reported).
- The plan's §11.2 note stays in force: the Commander Token Optimization
  plan's aspirational percentages (25/80/40) are not NRO thresholds.

## 11. Prepare contract

### 11.1 CLI and inputs

```
tsx scripts/commander-native-tool-benchmark.ts prepare --inputs <dir> --collection <file> [--runs-dir <dir>]
```

Purely offline: no model calls, no network, no shell, no provider/cache/
session state; the tool never touches repository source files. `--runs-dir`
defaults to `<cwd>/.pi/workbench/runs`. The frozen inputs directory
(`--inputs`) contains exactly:

- `fixture/` — the frozen fixture tree (§5),
- `milestone-prompt.txt` — the frozen prompt (§6.1),
- `environment.txt` — exactly four lines in this fixed order:
  `model_key: openai-codex/gpt-5.6-sol`, `thinking_level: high`,
  `pi_version: 0.83.0`, `node_version: v26.4.0` (no extra content;
  values bounded and safe; must equal the pinned environment),
- `rubric.json` — the frozen rubric (§6.2).

The collection record (`--collection`, §4.5) declares every retained
attempt and session in chronological order.

### 11.2 Commit semantics (exclusive create, ownership rollback)

1. **Preflight everything read-only first** — all content pins resolved
   (else `PROTOCOL_NOT_FROZEN`); the inputs dir verified against the
   pins (fixture manifest hash, prompt hash, environment equality,
   rubric hash); the collection record verified (schema, phase,
   non-treatment pin, ABBA arm order for final, safe relative paths,
   distinct realpaths, regular files, bounded size, strict JSONL);
   sessions derived with final validity checks when `phase: "final"`
   (prompt hash, environment, zero compactions, terminal stop) and
   attempts classified by the frozen priority (§8.6). Nothing is
   written until every input is fully validated.
2. **Stage** byte-exact copies under a staging directory inside the
   runs root (fixture tree, the four frozen inputs, the collection
   record, sessions under `sessions/<label>/`, attempts under
   `attempts/<label>/`, and `collection-deviations.json`), verifying
   every staged byte.
3. **Commit with exclusive primitives**: the evidence directory
   `commander-native-tool-benchmark/` is reserved with a **non-recursive
   `mkdir`** (EEXIST refuses any pre-existing or racing output, including
   a racing empty foreign directory); the strict manifest
   `commander-native-tool-benchmark-manifest.json` is created with an
   exclusive `open("wx")` (EEXIST refuses a pre-existing or racing
   foreign manifest). The generated manifest is round-tripped through
   the strict parser before anything is committed.
4. **Ownership-tracked rollback**: any failure removes the staging
   directory and **only** the outputs this invocation exclusively
   created — each removed only while it is still this invocation's
   (device+inode identity). Pre-existing or racing foreign outputs are
   never deleted or overwritten. There is never partial final evidence.
5. **Refusal**: an existing evidence directory or manifest is refused
   (`EXISTING_OUTPUT`); only ENOENT means absent — any other stat
   failure fails closed.

### 11.3 Outputs

- `commander-native-tool-benchmark/` — `fixture/`, `milestone-prompt.txt`,
  `environment.txt`, `rubric.json`, `collection-record.json` (byte-exact
  copy), `sessions/<label>/<file>.jsonl` (byte-exact copies),
  `attempts/<label>/<file>.jsonl` (byte-exact copies), and
  `collection-deviations.json` (privacy-safe deviations record:
  schema_version, protocol doc, phase, milestone prompt hash, per-attempt
  label/arm/runs-relative path/basename/raw hash/prompt hash/category/
  bounded terminal facts).
- `commander-native-tool-benchmark-manifest.json` — the strict manifest
  (§7) with collection-time session/attempt hashes and runs-relative
  paths.
- The CLI prints a bounded facts-only summary; on failure it prints
  nothing to stdout and exits 1 with the error code on stderr.

## 12. Execution steps (commander-owned N4)

1. **Completed at the fixture freeze (2026-08-06):** the content pins
   (§3.2) were frozen in a Sol-approved freeze step (fixture, prompt,
   rubric, non-treatment bundle) before any collection; the harness
   fails closed on any unresolved pin or pin drift.
2. Land N1/N2 (and N3 if approved) per plan §12; collect dev evidence
   during development (phase `dev`, never reported).
3. After the protocol and implementation are frozen and
   Commander-approved, collect the final validation cohort: exactly 40
   fresh sessions (20 per arm, frozen ABBA order, zero compactions,
   pinned prompt/environment, fresh sessions only), plus every invalid
   attempt, under a collection record. Final-phase collection is capped
   at **60 paid attempts** (§3.1/§4.6); an exhausted cap ends collection
   with a truthful partial final collection that is not analyzable/
   adoption evidence.
4. Run `prepare` to commit the evidence and manifest, then the offline
   analyzer:
   `tsx scripts/commander-native-tool-benchmark.ts analyze .pi/workbench/runs/commander-native-tool-benchmark-manifest.json --json`.
5. Verify the machine output: all 40 runs retained; fixture/session/
   prompt hashes reproduce the pins; environment facts match; zero
   compactions; attempts reported with matching categories; the four
   verdicts and reasons are self-consistent; the JSON is deterministic.
6. Map the machine facts to the plan's §11.1 release-blocking matrix and
   the §11.2 adoption thresholds, audit correctness/pagination/misuse
   against the frozen rubric (including the manual quoting-sign audit),
   and issue the Sol verdict. Final `check`/gates and the verdict remain
   commander-owned (plan §12); the result record is written only by the
   N5 worker slice.

### 12.1 FINAL collector implementation and invocation

The final validation cohort is collected by the dedicated FINAL
collector (implementation/wiring status note at the end of this
subsection):

- **Source paths:** collector `scripts/commander-native-tool-final-
  collect.ts` (no arguments: `--help`/`-h` exit 0; any other argument
  exits 2; a complete 40-valid collection exits 0; an exhausted cap or
  runtime hard-fail exits 1). It is independent of the DEV-pilot
  harness and never imports the DEV-pilot control approximation. The
  FINAL control adapter is `scripts/commander-native-tool-final-control-
  extension.ts` (control loads the SAME current runtime source as
  treatment through this adapter, suppressing exactly the three
  canonical NRO registrations); the treatment runtime is
  `extensions/workbench-runtime/index.ts` (loaded directly); the pi
  binary is `node_modules/.bin/pi`; the frozen inputs are
  `fixtures/commander-native-tool-benchmark/inputs/`.
- **Contract:** exactly 40 valid sessions in the frozen order (ABBA
  repeated ten times, 20 per arm); at most 60 paid attempts, each
  provider/model process counted once it is successfully started; an
  invalid attempt retries the same required arm.
- **Preflight/retention/record semantics:** read-only preflight before
  any output or call enforces the frozen pins, the exact non-treatment
  bundle hash, the Node and package Pi pins, and the required regular
  pi/FINAL-arm files; every produced raw is retained byte-exact under
  the exclusively-created output root
  `.pi/workbench/runs/commander-native-tool-final-collection/`
  (`sources/raw-<NN>-<arm>.jsonl`), and the strict `collection-record.json`
  (schema_version 1, phase `final`, frozen non-treatment pin,
  chronological entries, NO status/cap field) is atomically rewritten
  and re-validated after every attempt; the attempt-dir original is
  removed only after the retained source is byte-verified AND the
  updated record is committed and read back.
- **Invocation:** the package script `commander:nro:final` (= `tsx
  scripts/commander-native-tool-final-collect.ts`, no flags) and the
  controlled recipe `commander-native-tool-final-collect` (DEV-only,
  intentionally UNCACHED, no params, expected exits [0, 1], writes/
  artifacts ONLY under the final collection root, and a timeout sized
  for the frozen worst case of 60 × 30-minute per-attempt timeouts
  plus overhead — about 31 hours; collector timeouts/cap are
  unchanged).
- **Paid-collection authorization (hard):** the recipe performs PAID
  external provider/model calls (fixed 40 valid final sessions,
  ABBA×10, 20 per arm, max 60 successfully-started paid attempts,
  final evidence only) and may be run ONLY after a separate explicit
  user authorization.
- **Status note:** this subsection records implementation and wiring
  only — it is not collection or adoption evidence. No final session
  or attempt has been collected and no N4 result exists; savings stay
  NOT_MEASURED (plan §14).

## 13. Frozen limitations (must be read with any result)

- **No causal claim.** The analyzer reports machine facts and pinned
  arithmetic; it attributes nothing. Threshold ratios are arithmetic
  facts on the declared bases, not proof that the overrides caused them.
- **Preview facts semantics.** The analyzer's preview/pagination metrics
  depend on the frozen marker contract (§8.4) being implemented exactly
  by the N1 override; until N1 lands, sessions contain no marker and
  obligations are zero by construction.
- **Misuse is partially machine-derived.** Only the pagination sign of
  incomplete-result misuse is machine-computed (§8.5); quoting/editing
  signs are audited manually at N4 against the frozen rubric.
- **Fresh-session attestation.** "Fresh sessions only" is attested by
  the collection record and raw-byte hashes; the analyzer cannot detect
  a resumed session from the JSONL alone.
- **Small-cohort statistics.** n = 20 per arm, medians/p90 only; no
  distributional or significance claims.
- **Attempt-cap exhaustion.** Final-phase collection is hard-capped at
  60 paid attempts (§3.1/§4.6) — one count per provider/model process
  successfully spawned/started, whether or not it produces raw session
  JSONL. An exhausted cap yields a truthful partial final collection
  (every produced unique bounded regular JSONL retained and recorded)
  that is **not analyzable and not adoption evidence** — the exhausted
  status is reported by the collector's bounded CLI/run result (the
  strict collection record has no status/cap field), under-collection
  fails closed, and completing the cohort requires a new protocol
  revision approved before any new collection (§3.3).
- **Unrepresentable attempts hard-fail.** A started paid attempt that
  produces zero, multiple, or no unique bounded regular JSONL cannot be
  represented in the strict collection record; collection hard-fails
  immediately with exit 1, preserving the existing truthful partial
  record and attempt directory — no entry is ever fabricated and
  collection never continues past such a failure (§4.5/§4.6).
- **Environment-specific.** Results apply to the pinned Pi 0.83.0 /
  Node v26.4.0 / provider-model environment only.
- **Non-treatment bundle.** The bundle hash is captured at freeze and
  collection time; it enforces that both arms ran against identical
  non-treatment content — it is not a measurement input.
- **Thresholds are adoption criteria, not release gates.** The plan's
  §11.1 release-blocking matrix governs the N4 verdict; §11.2
  thresholds are the optimization-adoption criteria reported as
  measured-or-not.

## 14. Explicit non-claims

This protocol doc:

- records **no** NRO result, no target outcome, no adoption verdict, no
  plan status change, and no publication claim; the plan's §14 status
  lines are untouched by this document;
- does not alter or weaken the frozen P9 verdict or the P3 0.0 request
  FAIL, and reuses no P9/P3 artifact;
- makes no token-savings claim of any kind — savings remain
  **NOT_MEASURED** until the N4 measurement;
- does not claim that the §11.2 thresholds are release-blocking;
- makes no claim about worker budgets/defaults, caching, or any plan §3
  immutable constraint beyond restating them;
- is a harness contract for Sol's measurement — it is not acceptance
  evidence and cannot be cited as a PASS by any worker report.
