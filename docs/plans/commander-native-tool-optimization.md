# Commander Native Tool Optimization — NRO Implementation Plan

| Field | Value |
| --- | --- |
| Status | **PRE-FINAL FROZEN (third pre-final revision, 2026-08-06) — NO final validation collection, NO N4 result, savings NOT_MEASURED** — protocol, harness, implementation, and the final-control adapter are frozen pre-final; the FINAL collector implementation, its wiring (package script `commander:nro:final` + DEV-only uncached recipe `commander-native-tool-final-collect`), and its hermetic tests now exist and await Commander verification; no final session or attempt has been collected, and no token savings are claimed or measured anywhere in this document |
| Effort | **NRO — "Native read/grep/find Override"** — a **new independent effort** with its own protocol, harness, thresholds, slices, and verdict. It is **not** a phase of, extension of, or re-run of the Commander Token Optimization plan (`docs/plans/commander-token-optimization.md`, phases P0–P9) and it does not reuse or redefine the P9 protocol or P9 baseline |
| P9 preserved | The frozen P9 result is **preserved unchanged** and remains authoritative: Sol verdict **P9 PASS** / **FINAL RELEASE-QUALITY EXIT PASS under §10.1** in `docs/baselines/commander-token-p9.md` is a **release-quality verdict, not a token-savings claim**. All three strict P0 targets stay **NOT_MEASURABLE**; all three supplemental comparable targets stay **MISSED** (requests −25%, successful inline bytes −68.40533204169568%, gross −18.08644111793718%); the historical P3 request-savings **FAIL (8→8, reduction 0.0)** stays recorded; combined Slice B stays NOT PASS as an optimization exit; no publish/tag/commit/release occurred. This plan neither rewrites nor supersedes `docs/baselines/commander-token-p9.md`, `docs/baselines/commander-token-p9-protocol.md`, `docs/plans/commander-token-optimization.md`, or `docs/plans/worker-token-budget-repair.md` |
| Plan date | 2026-08-06 (creation; no earlier plan is superseded) |
| Revision | Rev. 4 — **third pre-final revision (2026-08-06): final-control arm implementation clarification + max-attempt cap**: control and treatment now both load the **SAME current runtime source**; control alone runs it through the dedicated final adapter (`scripts/commander-native-tool-final-control-extension.ts`) that suppresses exactly the three canonical NRO registrations (`read`/`grep`/`find`) so the Pi built-ins remain; the literal pre-N1 checkout (`aa2301763d95`) is rejected because the current working tree differs from that committed tree in other uncommitted runtime changes and would confound the only-permitted-difference rule; max final paid attempts are frozen at **60** (counting each provider/model process once successfully spawned/started, whether or not it produces raw session JSONL; 40 valid + bounded retry headroom), and an exhausted cap (reported by the collector's bounded CLI/run result, not by the strict collection record) yields a truthful partial final collection that is not analyzable/adoption evidence. 20+20 ABBA×10, all four content pins, thresholds/statistics, attempt retention, dev/final separation, P9/P3 preservation, and NOT_MEASURED status are unchanged; no final collection occurred and no N4 result exists (Rev. 3 was the pre-final NRO final-cohort refreeze 30/arm → 20/arm) |
| Repository | pi-dev-workbench (`/home/hanbaoji/Projects/pi-vibing-seriously`) |
| Git state at creation | `main` @ `aa2301763d95` — the commit itself is a reproducible (clean) committed pre-N1 tree; the CURRENT working tree carries other uncommitted runtime changes on top of it. Informational snapshot only; every execution must re-check live git state; never treat this as evidence |
| Owner | GPT-5.6 Sol commander (requirements, architecture, review, gates, verdict) |
| Executor | Fresh bounded workers, one bounded slice per delegation (worker spend profile per `docs/plans/worker-token-budget-repair.md`; every writing slice requires actual-diff review and Commander final verification, §12). Commander never writes project files: the NRO result record is written only by a fresh worker documentation-recording slice (§12, N5) |
| Scope | Reduce commander-session token consumption from Pi **native** `read`/`grep`/`find` tool results — the dominant inline-byte source in the completed audit (§2) — via same-name native tool overrides, without reducing correctness, evidence, security, mode semantics, abort/error semantics, or final verification. Documentation + phased implementation; see §3–§8 |

This document is self-contained: a brand-new Pi session can execute it without
access to any earlier conversation. It records the audit evidence (re-derived
from persisted analyzer output, §2), the requirements/goals/non-goals (§3–§4),
the Pi-grounded architecture decision (§5), the detailed V1 design (§6), the
stable-prefix / mode / security / compatibility / rollout analysis (§7), the
concrete proposed impact paths (§8), the complete test matrix (§9), the new
independent benchmark protocol (§10), the pre-registered adoption criteria
(§11), the worker-first slices (§12), the stop/rollback conditions and open
risks (§13), and the honest current verdict (§14).

---

## 1. Relationship to the frozen P9 result (preservation contract)

P9 is closed and frozen. This plan changes nothing about it:

- `docs/baselines/commander-token-p9.md` records Sol's verdict **P9 PASS** /
  **FINAL RELEASE-QUALITY EXIT PASS under §10.1**, expressly **not** a
  token-savings or optimization-success claim; its §5.2 target table reports
  every strict P0 target NOT_MEASURABLE and every comparable target MISSED.
- The P9 measurement basis (three pinned P3 `pre` sessions vs three disclosed
  supplemental `final-current` sessions, analyzer run `20260806-120523-gy65`)
  is **not reused as a denominator, control arm, or reference** by the NRO
  benchmark (§10). The NRO protocol is a **new** protocol with a **new** frozen
  fixture, **new** arms (control = the SAME current runtime through the
  dedicated final-control adapter; treatment = overrides), and
  **new** thresholds (§11). Nothing in NRO can change, re-run, or re-interpret
  the frozen P9 verdict or the P3 0.0 FAIL.
- The P9 numbers cited in §2 are used **only as an audit of where inline bytes
  went** (opportunity sizing). All causal interpretations are labeled cautious:
  the cohort comparison is historical comparable-cohort arithmetic, n = 3,
  high per-session variance, and **no** workbench change is attributed as a
  cause of the measured increase.

## 2. Evidence-backed motivation (completed audit)

The audit re-derives per-tool facts from the persisted analyzer JSON of run
`20260806-120523-gy65` (exit 0; full JSON at
`.pi/workbench/runs/20260806-120523-gy65/stdout.log`), the same machine facts
summarized in `docs/baselines/commander-token-p9.md` §4–§5. Per-tool sums below
are simple additions of the analyzer's per-run `perTool` blocks; no new
measurement was performed for this plan. "Inline bytes" = successful
tool-result text bytes (in every P9 session, total == successful — zero
error-marked tool results).

### 2.1 Cohort totals (machine facts, analyzer JSON)

| Quantity (cohort totals) | baseline (pre-1..3) | current (final-current-1..3) | Delta |
| --- | --- | --- | --- |
| Requests | 8 | 10 | +2 |
| Gross tokens | 92,456 | 109,178 | +16,722 |
| Successful inline bytes | 99,099 | 166,888 | **+67,789** |

### 2.2 Per-tool breakdown, current cohort (derived from analyzer JSON)

| Tool | Entries | Bytes | Share of 166,888 |
| --- | --- | --- | --- |
| `read` | 13 | **161,387** | **96.7%** |
| `grep` | 9 | 3,795 | 2.3% |
| `find` | 3 | 1,706 | 1.02% |
| Total | 25 | 166,888 | 100% |

Per-run `read` bytes: final-current-1 53,213; final-current-2 63,148;
final-current-3 45,026 (sum 161,387). Baseline `read` bytes: pre-1 44,957;
pre-2 4,288; pre-3 44,957 (sum 94,202).

### 2.3 Read dominates the cohort byte increase

| Fact | Value | Derivation |
| --- | --- | --- |
| Cohort byte increase | +67,789 | 166,888 − 99,099 (analyzer cohort totals) |
| `read` byte increase | +67,185 | 161,387 − 94,202 (per-run `perTool` sums above) |
| `read` share of the increase | **99.1%** | 67,185 / 67,789 |
| `find` share of current bytes | 1.02% | 1,706 / 166,888 |

### 2.4 The largest current session concentrates in `read`

| Run | Requests | Tool results | Inline bytes | Gross |
| --- | --- | --- | --- | --- |
| final-current-2 | 4 | 9 | 64,917 | 43,395 |
| pre-2 | 2 | 5 | 5,584 | 13,655 |

final-current-2 alone carries 63,148 of its 64,917 bytes in 5 `read` results
(analyzer JSON), i.e. most of the single-session byte growth is `read` output.

### 2.5 Cautious reading (mandatory)

- **Observational, non-causal.** These are historical comparable-cohort
  arithmetic facts (P9 record §5.2, §9); n = 3 per cohort; per-session variance
  is large (final-current-2 vs final-current-3 differ by 17,758 bytes). No
  workbench change is attributed as the cause of the increase, and no
  optimization effect is implied.
- **Opportunity sizing only.** The audit shows that (a) `read` results are the
  dominant inline-byte source in the current cohort (96.7%), (b) the cohort
  byte growth is ~entirely `read` (99.1%), and (c) `find` is a ~1% lever.
  Whether a deterministic preview and count modes actually reduce tokens is
  **NOT_MEASURED** and can only be established by the NRO benchmark (§10–§11).

## 3. Requirements (immutable constraints)

Every NRO slice binds to all of the following; a change violating any is
rejected at review regardless of measured savings.

1. **Correctness preserved.** All content the model legitimately needs remains
   obtainable, byte-exactly, through deterministic continuation (§6.1 facts),
   with the built-in's own 50KB-per-line read limitation preserved verbatim on
   the legacy continuation path (§6.1, oversized-line exception).
2. **No hidden truncation.** Every result that does not contain the complete
   requested content states exact omission/continuation facts in the result
   itself; nothing is silently cut, and a preview is never presented as a
   complete read.
3. **Read-only behavior.** The overrides never mutate files, caches, session
   state, or ledgers; they are pure readers like the built-ins they replace.
4. **Path/security/mode semantics unchanged.** Path resolution (relative to
   cwd, absolute, leading-`@` normalization), the protected-path guard
   (`extensions/workbench-runtime/core/path-policy.ts`, matched by exact tool
   name `read`/`grep`/`find` in the `tool_call` guard), AUDIT/VERIFY read
   blocking, and DEV allowances behave exactly as today (§7.2).
5. **Abort/error semantics preserved.** `signal.aborted` → `"Operation
   aborted"` rejection; missing/unreadable file errors, `offset` beyond end of
   file, and all legacy error text are byte-identical to the built-ins on the
   legacy path.
6. **Exact omission/continuation facts.** `complete`, `returned_lines`,
   `returned_bytes`, `total_lines`, `total_bytes`, `omitted_lines`,
   `omitted_bytes`, `next_offset`, `line_truncated` are deterministic
   functions of (file bytes, caps), stated in the result text; same input →
   same facts.
7. **No nested LLM summaries.** Tool execution performs no model calls, no
   summarization, and no content rewriting; previews are deterministic textual
   truncations plus facts, never LLM-generated prose.
8. **Worker semantics unchanged.** Worker budget profiles, context safety,
   delegation lifecycle, write authority, and worker-policy tests remain
   untouched (`docs/plans/worker-token-budget-repair.md` stays in force).
   Because the extension loads in worker sessions too, the overrides apply
   there as well; worker correctness is preserved by the same deterministic
   facts (§7.3), and worker-task contracts must not assume one-call complete
   reads of oversized files.
9. **Stable-prefix discipline.** Static registration only; no dynamic facts in
   tool metadata; exactly one intentional fingerprint transition (§7.1).
10. **P9 frozen artifacts untouched.** No edit to
    `docs/baselines/commander-token-p9*.md`, the P9/P3 manifests or session
    files, `scripts/commander-token-benchmark.ts`, or the P9 analyzer output.

## 4. Goals and non-goals

### 4.1 Goals

- **G1 (primary):** reduce commander-session inline bytes originating from
  native `read` results — the 96.7% share identified in §2 — via a
  deterministic preview with exact continuation facts.
- **G2:** reduce `grep` bytes via an exact, compact `count` mode for
  existence/occurrence questions (which today return full match lines).
- **G3:** reduce `find` bytes via a `count` mode and `max_depth` filter — only
  if evidence supports it (find is ~1.02% of measured bytes; §6.3).
- **G4:** preserve or improve task correctness — measured, not assumed (§9
  rows, §10 metrics).
- **G5:** achieve the pre-registered optimization thresholds (§11.2) on an
  independent benchmark, or report the miss honestly.

### 4.2 Non-goals

- Rewriting, extending, or re-running P9 or its protocol; redefining any P9/P3
  target, ratio, or verdict.
- Changing tool names, active-mode lists, `WORKBENCH_TOOL_NAMES` (stays at 11),
  write-authority allowlists, worker semantics, or delegation behavior.
- Adding new LLM behavior inside tools (no nested summaries, no agent turns).
- Enforcing behavior purely by prompt prose (prose assists, never enforces;
  §5.2).
- Hard stops, caches, daemons, or non-static registration.
- Any change to `docs/plans/commander-token-optimization.md` or
  `docs/plans/worker-token-budget-repair.md` statuses.

## 5. Architecture decision (grounded in installed Pi documentation)

### 5.1 The decision

Register **same-name overrides** of the Pi built-in `read`, `grep`, and `find`
tools from the workbench extension, where each override **delegates the legacy
behavior** to the installed Pi tool-definition factories
`createReadToolDefinition(cwd)`, `createGrepToolDefinition(cwd)`,
`createFindToolDefinition(cwd)` exported by `@earendil-works/pi-coding-agent`,
and adds the V1 behavior (§6) only on explicitly designed paths. The override
re-declares the built-in `promptSnippet`/`promptGuidelines` verbatim (Pi does
not inherit them) and preserves the built-in result-shape contract (§7.3):
legacy branches return the built-in content/`details` byte-for-byte, and new
branches keep `details` within the built-in details types (facts live in the
result text), so the built-in renderers and session logic keep working.

### 5.2 Grounding in the installed Pi docs and examples

Installed package:
`/home/hanbaoji/.local/share/npm/lib/node_modules/@earendil-works/pi-coding-agent/`

- **`docs/extensions.md`, §"Overriding Built-in Tools"** (around lines
  2022–2052): "Extensions can override built-in tools (`read`, `bash`, `edit`,
  `write`, `grep`, `find`, `ls`) by registering a tool with the same name.
  Interactive mode displays a warning when this happens." — the same-name
  mechanism is a first-class, documented Pi capability.
- Same section: "**Rendering:** Built-in renderer inheritance is resolved per
  slot. Execution override and rendering override are independent. If your
  override omits `renderCall`, the built-in `renderCall` is used. If your
  override omits `renderResult`, the built-in `renderResult` is used." — the
  override can omit renderers and keep the built-in UI.
- Same section: "**Prompt metadata:** `promptSnippet` and `promptGuidelines`
  are not inherited from the built-in tool. If your override should keep those
  prompt instructions, define them on the override explicitly." — hence the
  verbatim re-declaration requirement.
- Same section: "**Your implementation must match the exact result shape**,
  including the `details` type. The UI and session logic depend on these
  shapes for rendering and state tracking." — hence the delegation design and
  the compatibility test rows (§9).
- **`docs/extensions.md`, §"ExtensionAPI Methods" → `pi.registerTool(definition)`**
  (around lines 1337–1341): registration "works both during extension load and
  after startup … New tools are refreshed immediately in the same session …
  without `/reload`" — supports static registration inside the extension
  factory (our only allowed form, §7.1).
- **`docs/extensions.md`, §"tool_result"** (lines 814–823): "Fired after tool
  execution finishes and before `tool_execution_end` plus the final tool
  result message events are emitted. **Can modify result.**" and "`tool_result`
  handlers chain like middleware" (partial patches of `content`/`details`/
  `isError`/`usage`). Because handlers modify the result *before* the final
  `toolResult` message events are emitted, a middleware that compacts results
  does not inherently make the persisted session diverge from what the model
  sees — relevant to the §5.3 rejection rationale.
- **`examples/extensions/tool-override.ts`** (same package): the official
  complete example overriding built-in `read` by registering `name: "read"`
  with the same `path`/`offset`/`limit` schema, delegating to a local
  implementation, and relying on the built-in renderer when no custom
  renderers are provided.
- **`docs/extensions.md`, §"Output Truncation"** (around lines 2111–2123): tools MUST
  truncate their own output; built-in limits are 50KB and 2000 lines
  (`DEFAULT_MAX_BYTES = 50 * 1024`, `DEFAULT_MAX_LINES = 2000`,
  `GREP_MAX_LINE_LENGTH = 500` in `dist/core/tools/truncate.js`), with
  `truncateHead`/`truncateTail`/`truncateLine` utilities exported.
- **Installed package exports** (the installed
  `@earendil-works/pi-coding-agent`): `dist/core/tools/index.js` exports
  `createReadToolDefinition`, `createGrepToolDefinition`,
  `createFindToolDefinition` (plus `createReadTool`/`createGrepTool`/
  `createFindTool` and the `ReadOperations`/`GrepOperations`/
  `FindOperations` interfaces), and the `.d.ts` files declare the exact
  schemas and details types used in §6:
  - `dist/core/tools/read.d.ts` — schema `{ path: string; offset?: number;
    limit?: number }`; `ReadToolDetails { truncation?: TruncationResult }`;
    options `autoResizeImages` (default true) and pluggable `ReadOperations`.
  - `dist/core/tools/grep.d.ts` — schema `{ pattern; path?; glob?; ignoreCase?;
    literal?; context?; limit? }`; `GrepToolDetails { truncation?;
    matchLimitReached?; linesTruncated? }`.
  - `dist/core/tools/find.d.ts` — schema `{ pattern; path?; limit? }`;
    `FindToolDetails { truncation?; resultLimitReached? }`.
- Project-internal grounding: the existing pure-policy / Pi-adapter split
  (`extensions/workbench-runtime/core/*` is Pi-free and unit-tested with
  `node:test`; `extensions/workbench-runtime/index.ts` is the only Pi adapter)
  is the pattern the NRO follows (§8). The stable-prefix contract
  (`docs/cache/stable-prefix-contract.md`) and
  `docs/worker-delegation.md` §"Stable-prefix and cache behavior" pin the
  static-metadata discipline the overrides must respect (§7.1).

### 5.3 Why not the alternatives (primary-design rejection rationale)

| Alternative | Rejected because |
| --- | --- |
| **New tool names** (e.g. `read_preview`, `grep_count`) | Adds prompt metadata and tool-list entries (more prefix bytes), requires mode allowlist/write-authority inventory changes, changes the tool-name set the model sees (breaking the "same tool names/order" arm equality of §10), and — decisively — does **not** change the behavior of the `read`/`grep`/`find` calls the model already makes, which are the byte source (§2). The model would still call `read` for file contents. A new name cannot shrink existing-tool results. |
| **Prose-only policy** (guidelines admonishing the model to be economical) | Pure prose has no mechanism: it is model-stochastic and unverifiable. The project already measured the ceiling of a prose batching guideline: P3's static batching policy produced a frozen **0.0 request reduction (FAIL)** (`docs/baselines/commander-token-p3.md`), preserved in the P9 record. A mechanism (deterministic preview + facts, exact counts) is the primary design; prose is only one assist (§6.4). |
| **`tool_result`-only truncation** (compacting result text in a middleware handler) | Not the primary design; it is not rejected as necessarily unsafe. Per docs/extensions.md §"tool_result" (lines 814–823), handlers fire after tool execution and **before** the final `toolResult` message events are emitted and **can modify the result**, so a handler that emits exact omission facts can compact results safely without the persisted session diverging from what the model sees, and `tool_result`-only truncation does not necessarily hide truncation. It is not the primary design because it cannot (a) **expose schema-visible modes** — the schema is fixed before the call, so grep `output="count"` / find `max_depth` cannot exist or be learned by the model; (b) **influence first-call planning** — it runs only after the model already chose the parameters that produced the large result; (c) offer **mode-specific result-shape/continuation ergonomics** — the result keeps the legacy shape with no compact per-mode format and no tool-produced deterministic `next_offset`-style continuation affordance. The same-name override (§5.1) provides all three; truncation happens inside the tool result, explicitly, with facts (§3.2). |

## 6. Detailed V1 design

All new parameters are **optional** and every legacy parameter shape remains
valid. For grep and find, an omitted new selector (`output`, `count_kind`,
`max_depth`) resolves to the legacy built-in behavior for that call. For read
there is exactly one deliberate behavior change: a text read **without**
`offset`/`limit` on a file larger than the preview caps returns the
deterministic preview (§6.1) instead of the built-in's 50KB/2000-line head
truncation; any read with explicit `offset` and/or `limit` always takes the
legacy path. All caps below are **proposed static starting values**, fixed at
implementation time in the pure policy module and frozen before N1 validation
collection — never derived from dynamic state.

### 6.1 `read` — deterministic preview with exact facts

- **Schema (unchanged):** `{ path: string; offset?: number; limit?: number }`.
- **Legacy path (byte-compatible):** a call with explicit `offset` and/or
  `limit` executes exactly as the built-in `read` does today — the override
  delegates to the captured `createReadToolDefinition(cwd)` execution path,
  preserving the 2000-line/50KB built-in truncation, the `offset` beyond-end
  error, the leading-`@` normalization, image handling, and abort semantics
  verbatim, byte-for-byte (content and `details`). A call **without**
  `offset`/`limit` on a file whose full content fits inside the preview caps
  returns that full content — byte-identical to the built-in's content — with
  the deterministic facts trailer appended (`complete: true`), per the
  preview path below.
- **Preview path:** a **text** file read **without** `offset`/`limit` whose
  content exceeds the caps is returned as a deterministic preview of the
  **first** `min(240 lines, 12 KiB)` — whichever is hit first — cut at line
  boundaries, plus an explicit facts block. Proposed static starting caps:
  **240 lines / 12 KiB** (configurable constants in the policy module; changes
  are reviewed changes). The 12 KiB byte cap applies to the returned content
  lines **excluding** the fixed-format facts trailer, and it counts each
  returned line's representation bytes (a prefix-represented line counts its
  prefix plus marker), so `returned_bytes ≤ 12 KiB` always holds: the cap is a
  true bound, never exceeded by an arbitrarily long line, and never requiring
  a mid-line cut.
- **Oversized single line (documented cap exception, never silently lost):** a
  line whose UTF-8 byte length exceeds the per-line representation cap
  (`PREVIEW_MAX_LINE_UTF8_BYTES`, proposed static starting value 2048, fixed
  at implementation) is represented by the longest UTF-8-safe prefix such
  that the prefix plus the fixed inline truncation marker stays within the
  cap — cut after the last whole code point, never splitting a code point —
  with `line_truncated: true` in the facts. This is the one explicit
  exception to the line-boundary cut rule and it never silently loses
  content: the facts state the omitted byte count, and `next_offset` points
  at the truncated line itself, so legacy pagination (explicit
  `offset`/`limit`) deterministically retrieves the full line — subject to
  the built-in 50KB/2000-line semantics of that legacy read, including the
  built-in first-line-exceeds-limit notice for lines over 50KB.
- **Facts (in the result text, always when a preview truncates; also present
  when `complete: true`):** `complete` (bool), `returned_lines`,
  `returned_bytes`, `total_lines`, `total_bytes`, `omitted_lines`,
  `omitted_bytes`, `next_offset`, `line_truncated` (bool; false unless the
  last returned line is prefix-represented). `returned_lines`/`returned_bytes`
  count the returned content lines only (facts trailer excluded);
  `omitted_lines` = `total_lines − returned_lines` plus 1 when
  `line_truncated` is true; `omitted_bytes` = `total_bytes − returned_bytes`
  (the truncated line's remainder is omitted content). `next_offset` is the
  1-indexed line at which the first not-fully-returned content begins —
  `returned_lines + 1` when the cut is at a line boundary, or the truncated
  line's own number when `line_truncated` is true — and is valid only when
  `complete` is false. **Details compatibility:** `details` may carry only a
  valid `ReadToolDetails.truncation` shape (a `TruncationResult`
  deterministically derived from the same facts, so the inherited built-in
  renderer shows its standard truncation warning); no additional details keys
  are ever added — all model-facing continuation facts live in the result
  text. Determinism: same file bytes + same caps → same preview and same
  facts; byte accounting is UTF-8-exact and code-point-safe.
- **Images pass through:** image MIME detection, auto-resize, and the
  attachment content (`{ type: "image", data, mimeType }` plus the text note)
  are delegated to the legacy implementation unchanged; previews never apply
  to binary/image content.
- **Complete-read obligations (SKILL.md / AGENTS.md / Pi docs / plans and
  baselines under review / run logs under review):** honored through **legacy
  pagination**, which remains byte-exact: the guideline (§6.4) instructs
  "when the complete content of a file is required, use explicit `offset`/
  `limit` (or follow `next_offset` until `complete: true`)". The tool itself
  has **no path-based special cases** (no dynamic behavior, no allowlist);
  completeness is always machine-visible through the facts, so the model can
  detect and continue deterministically. The NRO session analyzer can
  machine-verify that obligation reads ended at `complete: true` (§10 metrics:
  follow-up pagination, incomplete-result misuse).
- **Rationale for the caps:** the audit's `read` results average ≈ 12,414
  bytes per call in the current cohort (161,387 / 13), just above the
  proposed 12 KiB (12,288-byte) cap; the cap bounds the dominant call type
  while keeping ~240 lines of real content for orientation, and the facts
  make continuation exact.

### 6.2 `grep` — exact count mode

- **Schema (additive, all optional):** `output?: "matches" | "count"` (default
  `"matches"`); `count_kind?: "matches" | "lines"` (default `"matches"`).
  `"files"` is a **staged** second-tier value (staging paragraph below) — not
  in the V1.0 schema, to keep the V1 fingerprint single and the count
  semantics minimal.
- **Default (`output` omitted or `"matches"`):** legacy-compatible — delegates
  to the built-in `createGrepToolDefinition(cwd)` path: matching lines with
  file paths and line numbers, `context`, `limit`, `glob`, `ignoreCase`,
  `literal`, `.gitignore` respect, the 500-char line cap, and
  `matchLimitReached`/`linesTruncated` details — byte-compatible.
- **`output: "count"`:** exact and compact. The result is a single small text
  line carrying the selected count plus the distinct-file count — e.g.
  `count kind=lines value=7 files=3` — and `details` is **left undefined**
  (no additive keys on the built-in `GrepToolDetails`; §7.3), so the three
  granularities are always distinguished:
  - `count_kind: "matches"` — total occurrences across all matching files
    (ripgrep `--count-matches` semantics; for `literal`, occurrences of the
    literal; for regex, all matches, not just one per line).
  - `count_kind: "lines"` — total matching lines (ripgrep `--count`
    semantics).
  - `files` in the result line — distinct files with at least one match,
    derived from the same per-file count scan (the number of counted files).
- **Backend and exactness:** `createGrepToolDefinition` delegates **only** the
  legacy matches branch; the built-in factory exposes **no** count mode, so
  count mode uses a **dedicated abort-aware adapter** that runs the same
  installed ripgrep engine with the same flag semantics as the built-in
  matches path — the identical argument-vector family (`--color=never`,
  `--hidden`, `--ignore-case` when `ignoreCase`, `--fixed-strings` when
  `literal`, `--glob <glob>` when `glob`, then `-- <pattern> <searchPath>`;
  `.gitignore` respected by the same engine defaults and the same binary
  resolution) — with the matches-specific flags replaced by the count flags
  (`--count` or `--count-matches`, per-file count lines summed). Direct
  argument-vector execution only: no shell, no `pi.exec`. Count mode **must
  not** apply the legacy match `limit` cap — the count is exact over the full
  scan. A parity test corpus (§9 rows 10–11, 21) machine-compares count vs
  matches-mode outcomes on the same engine. If the scan is interrupted
  (timeout/abort), the result **fails explicitly** — never a partial count
  (§13 risk R2).
- **Staging:** `output: "files"` (distinct file list only, no lines) is
  staged behind N2's count evidence: it reuses the same backend
  (`--files-with-matches`) and is expected to shrink typical "where is X
  used?" results from full match lines to paths; it ships only if the N2
  validation cohort shows count-mode usage is real and the added schema
  surface is justified.

### 6.3 `find` — count and depth filter (lower priority)

- **Schema (additive, all optional):** `output?: "paths" | "count"` (default
  `"paths"`); `max_depth?: number`.
- **Default (`output` omitted or `"paths"`):** legacy-compatible — delegates
  to `createFindToolDefinition(cwd)`: glob matching, `path`, `limit` (default
  1000), `.gitignore` respect, relative paths, `resultLimitReached` details.
- **`output: "count"`:** exact number of matching paths (scan without the
  result cap; only the number is returned) — `details` **left undefined** (no
  additive keys on the built-in `FindToolDetails`; §7.3).
- **`max_depth`:** excludes matches deeper than N path segments below the
  search directory (fd `--max-depth N` semantics over the same glob result
  set).
- **Backend and exactness:** `createFindToolDefinition` delegates **only** the
  legacy branches (plain `paths` calls without `max_depth`); the built-in
  factory exposes **no** count/depth mode, so `output: "count"` and any call
  carrying `max_depth` use a **dedicated abort-aware fd/glob adapter** that
  replicates the built-in default fd semantics — the same flag family
  (`--glob --color=never --hidden`, the same `--no-require-git` decision,
  the same `--full-path` + leading `**/` normalization for path-containing
  patterns) and `.gitignore` via the same engine defaults — with
  `--max-depth N` added when `max_depth` is set, and the result cap omitted
  only for `output: "count"` (a depth-filtered `paths` call keeps the legacy
  cap and `resultLimitReached` behavior). Direct argument-vector execution
  only: no shell, no `pi.exec`. Parity tests (§9 rows 15, 21) machine-compare
  count/`max_depth` outcomes against the legacy delegated results on the
  fixture corpus.
- **Priority gate:** find is ~1.02% of measured current bytes (§2.2), so N3
  proceeds **only if** N1/N2 evidence (§11) shows the read/grep levers are
  insufficient or find results grow materially in the NRO control cohort.
  Until then, find stays at the legacy path with the design recorded here.

### 6.4 Guideline (assist, never the only enforcement)

One short static `promptGuidelines` bullet added to the `read` override's
re-declared metadata (and mirrored in the `grep` bullet), e.g.: *"Use read
with explicit offset/limit (or follow next_offset until complete: true) when a
file's complete content is required (SKILL.md, AGENTS.md, Pi docs, plans,
baselines, run logs); prefer grep output=count for existence/occurrence
questions."* Static text, no dynamic facts, part of the single fingerprint
transition (§7.1). Enforcement is the deterministic preview + facts + count
mode; the bullet only steers call choice.

## 7. Stable-prefix, mode/security, compatibility, and rollout analysis

### 7.1 Stable prefix and caching

- **Same names, same order, same active lists:** the overrides keep the names
  `read`/`grep`/`find`; `AUDIT_TOOLS`/`DEV_TOOLS`/`VERIFY_TOOLS`/
  `MANAGED_TOOLS` in `extensions/workbench-runtime/core/mode-policy.ts`, the
  write-authority sets in `core/write-authority.ts`, and the path-policy
  `PATH_ARG_TOOLS` set in `core/path-policy.ts` are **unchanged** (exact-name
  matching keeps working, §7.2). The resolved tool list (names and order) in
  the system prompt is unchanged.
- **One intentional fingerprint transition:** the three tools' schema +
  description/prompt metadata change once, when N1/N2 land, so the DEV/AUDIT/
  VERIFY `modePrefixFingerprint` (system prompt + tool names/order/schema per
  mode) transitions exactly once; after reload, same-mode fingerprints stay
  stable (per `docs/cache/stable-prefix-contract.md` and the
  `docs/worker-delegation.md` stable-prefix section, which document the same
  discipline for the `workbench_*` catalog). The transition is expected and
  must be recorded in the stable-prefix docs and tests (§8), like the
  documented prior transitions.
- **Static registration only:** the three overrides are registered as static
  top-level `pi.registerTool({...})` blocks inside the extension factory —
  never in a loop, never conditionally, never per-turn (the source-scan
  assertions in `tests/p6-b-stable-prefix.test.ts` already enforce this shape
  for the workbench tools and are extended to the overrides, §8).
- **No dynamic facts in metadata:** descriptions, `promptSnippet`,
  `promptGuidelines`, and schemas contain no cwd, date, mode, path, run id, or
  token facts (mirroring the built-in static strings quoted in §5.2). The
  `cwd` captured by `createReadToolDefinition(cwd)` is execution-time closure,
  not metadata.
- **Cache behavior:** caching remains enabled; nothing disables or bypasses
  prompt caching. The one-time prefix transition invalidates the affected
  mode prefix once (a cache miss for the first request after reload), then the
  prefix is stable — this is a documented, one-time cost, not ongoing churn.

### 7.2 Mode and security semantics

- The layer-2 hard guard (`pi.on("tool_call")` in
  `extensions/workbench-runtime/index.ts` → `mode-policy.ts` +
  `path-policy.ts`) intercepts by **exact tool name before execution**, so the
  override cannot bypass AUDIT/VERIFY protected-path read blocks or VERIFY/
  AUDIT hard denials; the guard continues to see `toolName === "read"` etc.
- Defense in depth: the pure policy module re-uses `matchProtectedPath` for
  the preview/count entry points in tests (§9 row "security"), and the
  override itself performs no writes, no `pi.exec`, and no shell — the
  grep/find new-mode adapters execute the installed rg/fd binaries directly
  with explicit argument vectors, abort-aware and read-only (§6.2, §6.3).

### 7.3 Compatibility

- **Legacy and resumed calls remain valid:** old session files reference
  `read`/`grep`/`find` by name with legacy params; names are unchanged and
  every legacy parameter shape remains valid, so replay/resume stays valid;
  the only behavior change for a legacy-shaped call is the deliberate read
  preview on an unbounded oversized text read (§6.1), which is replay-safe
  because the preview is deterministic and its facts are in the result text.
  P8 persist-first recovery (`workbench_recover_tool_result`) matches by tool
  name + call id and is unaffected.
- **Result-shape compatibility:** on the legacy path the override returns the
  built-in content and `details` verbatim, byte-for-byte (delegation). On new
  paths the result carries **no additive details keys**: grep/find count
  results keep `details` undefined with all facts in the result text, and the
  read preview sets `details` only to a valid `ReadToolDetails.truncation`
  shape (`TruncationResult`) deterministically describing the preview — never
  additional keys; every model-facing continuation fact lives in the result
  text (§6.1–§6.3, §9 byte-compatibility rows).
- **Renderer inheritance:** no custom `renderCall`/`renderResult` for the
  three overrides in V1, so built-in renderers (syntax highlighting, line
  numbers, truncation warnings) keep working per docs/extensions.md.
- **`sourceInfo`:** overridden tools report the extension as their source
  instead of `builtin` in `pi.getAllTools()`; any test asserting built-in
  provenance for `read`/`grep`/`find` is identified and deliberately adjusted
  (§8) — an expected, documented consequence.
- **Interactive override warning:** Pi's interactive mode displays a warning
  when an extension overrides a built-in (docs/extensions.md §"Overriding
  Built-in Tools"). This is informational; the workbench accepts it once at
  load. Fail-closed concerns: if override registration throws, the extension
  factory must fail before any partial registration (no half-registered tool);
  the underlying built-ins remain available in any session where the extension
  is not loaded (e.g. other projects), so the fallback state is the legacy
  behavior itself.
- **Worker sessions:** the extension loads in worker children too, so the
  overrides apply there; worker tasks use the same facts-based continuation.
  No worker budget/profile/delegation semantics change (§3.8); the worker-task
  contract template is checked for assumptions about one-call complete reads
  (§8, §9) and adjusted only in wording, never in delegation semantics.

### 7.4 Rollout

N1 (read) lands first as its own reviewed slice; N2 (grep) second; N3 (find)
only on evidence; N4 is Commander-owned measurement/verdict and N5 is the
worker documentation-recording slice that writes the result record (§12). Each slice
is independently revertible by reverting its reviewed diff (overrides removed
→ built-ins restored automatically). No release/publish action is part of any
slice.

## 8. Impact paths — original/proposed inventory and current realization status

**This section is the original/proposed impact inventory recorded at plan
creation, annotated with the current realization status — it is an
inventory, not a claim that the paths do not exist.** As of this revision,
the N0/N1/N2 implementation paths below are **landed and reviewed** (the
policy module, the rg count adapter, the three static override blocks, the
NRO tests, the adjusted source-scan tests, the N0 harness/fixture, and the
NRO docs), as are the collector/control/wiring paths (§8.1); **N2b (staged
`grep output: "files"`) and N3 (find count/max_depth) remain NOT_RUN**, and
the N5 result record is not yet written (no N4 verdict exists). Status
labels are factual repository snapshots, never acceptance evidence; exact
allowed paths are fixed per delegation by Sol at delegation time, never
inferred from this plan.

Pure policy (Pi-free, `node:test`-testable, mirroring `core/*`):

- `extensions/workbench-runtime/core/native-tool-policy.ts` (landed, N1/N2) —
  pure module: preview caps (240 lines / 12 KiB, per-line representation cap)
  and the deterministic facts computation; grep count semantics and
  `count_kind` resolution; static metadata
  constants (`NATIVE_OVERRIDE_NAMES = ["read","grep","find"]` in fixed order,
  and `NATIVE_OVERRIDE_METADATA` carrying the verbatim built-in
  `promptSnippet`/`promptGuidelines` plus the one new guideline bullet §6.4).
  The originally proposed find count/max_depth semantics are **NOT_RUN**
  (staged N3; the find override exposes no count/depth parameters).
- `extensions/workbench-runtime/core/native-search-adapter.ts` (landed, N1/N2) —
  Pi-free, abort-aware direct-execution adapter for the installed rg binary
  (explicit argument vector; no shell, no `pi.exec`), replicating the
  built-in flag semantics (§6.2); parity-tested against the delegated
  built-in results. The rg count adapter is implemented and wired
  (`runGrepCount`); the originally proposed fd adapter is **NOT_RUN**
  (staged with N3 and not present).

Pi adapter (the only Pi-touching layer, `extensions/workbench-runtime/index.ts`):

- three static `pi.registerTool({...})` blocks (landed, N1/N2) wrapping
  `createReadToolDefinition` / `createGrepToolDefinition` / `createFindToolDefinition`
  with the §6 branching (legacy branches delegate to the captured built-in
  definitions; new branches call the policy module and the search adapter);
  no loops, no conditionals, no dynamic metadata. The `read` preview
  override (N1), the `grep` count override (N2), and the `find` exact legacy
  pass-through (N1; the staged N3 count/depth additions are NOT exposed) are
  all registered.

Tests (landed; the NRO test files and the adjusted source-scan tests exist):

- `tests/native-tool-policy.test.ts` (landed) — pure policy: preview facts,
  determinism, caps, count semantics, Unicode, line-boundary truncation.
- `tests/native-tool-wiring.test.ts` (landed) — adapter: legacy-path
  byte-compatibility vs captured built-in definitions on a fixture corpus;
  new-path behavior; rg adapter parity (§9 rows 10–11, 15, 21); abort/error
  parity; guard still fires by exact name.
- `tests/commander-native-tool-benchmark.test.ts` (landed, with the N0
  harness) — analyzer and prepare-script tests (see §10).
- **Deliberate adjustments of existing source-scan tests** (landed,
  required because the three fixed native overrides add three `registerTool`
  blocks without changing `WORKBENCH_TOOL_NAMES`):
  - `tests/p6-b-stable-prefix.test.ts` — the assertion "one registerTool per
    catalog tool" now expects the 11 catalog tools **plus exactly the three
    fixed native overrides**, with order/static-metadata assertions for the
    overrides and the `NATIVE_OVERRIDE_NAMES` constant as the source of
    truth; the "no registerTool in a loop" and "exactly one setActiveTools
    call site" scans stay as-is.
  - `tests/diff-review-wiring.test.ts` — the stub assertion
    `[...stub.tools.keys()]` now expects the 11 catalog tools in order plus
    the three native overrides in fixed positions.
  - Any test asserting built-in `sourceInfo`/provenance for `read`/`grep`/
    `find` — landed as a no-op: no such assertion existed (none was found
    during N1, so none required updating).
  - `tests/mode-policy.test.ts`, `tests/p5-path-policy.test.ts`,
    `tests/write-authority.test.ts`, `tests/p8-recovery-wiring.test.ts` —
    **unchanged** (name-based semantics preserved); re-run as regression
    evidence, not rewritten.
- `WORKBENCH_TOOL_NAMES` **stays at 11**: the native overrides are not
  `workbench_*` tools, are not added to the catalog, and do not enter the
  write-authority/lease lists.

Docs (landed unless noted):

- `docs/cache/stable-prefix-contract.md` (landed) — records the one
  intentional fingerprint transition and the three-override
  static-metadata facts.
- `docs/worker-delegation.md` (stable-prefix section; landed) — same
  transition note.
- `docs/compatibility.md` (landed) — inventory: 11 `workbench_*` custom
  tools unchanged + three fixed native-name overrides with their additive
  optional-parameter deltas and the result-shape rules of §7.3.
- `docs/security.md` (landed) — notes that the guard remains name-based and
  the overrides add no write path (additive only).
- `docs/baselines/commander-native-tool-benchmark-protocol.md` (landed, N0)
  and `docs/baselines/commander-native-tool-benchmark.md` (**NOT_WRITTEN** —
  the N5 result record is written by the N5 worker slice from the N4
  verdict, §12; no N4 verdict exists) — see §10.

Benchmark harness (landed, N0):

- `scripts/commander-native-tool-benchmark.ts` (landed) — offline analyzer +
  prepare script over the NRO manifest (schema_version 1; §10), wired as
  package scripts `commander:nro:prepare` and `commander:nro:benchmark` and
  controlled recipes `commander-native-tool-benchmark-prepare` and
  `commander-native-tool-benchmark`.
- Frozen fixture — landed: the frozen fixture inputs live at
  `fixtures/commander-native-tool-benchmark/inputs/` (environment.txt,
  fixture content, milestone prompt, rubric), mirroring the P9 discipline
  **without reusing its artifacts**; the `commander:nro:prepare` wiring
  commits byte-exact copies plus the strict manifest under
  `.pi/workbench/runs/commander-native-tool-benchmark/` with
  exclusive-create semantics at collection-preparation time (the committed
  evidence directory does not pre-exist).

### 8.1 Realized collector/control/wiring paths (beyond the original inventory)

The following paths were added after the original inventory as the
reviewed N0/N1/N2 and wiring slices landed; they exist in the repository
(implementation status per §14):

- `scripts/commander-native-tool-dev-pilot.ts` (landed, reviewed) — DEV
  pilot collector, wired as package script `commander:nro:pilot` and
  DEV-only controlled recipe `commander-native-tool-dev-pilot-collect`
  (up to 12 paid attempts; pilot artifacts are never final/adoption
  evidence).
- `scripts/commander-native-tool-control-extension.ts` (landed) — the
  dev-pilot control approximation (never used for final collection), and
  `scripts/commander-native-tool-final-control-extension.ts` (landed) — the
  dedicated final-control adapter suppressing exactly the three canonical
  NRO registrations so the Pi built-ins remain.
- `scripts/commander-native-tool-final-collect.ts` (landed; awaiting/
  subject to Commander verification) — the FINAL collector, wired as
  package script `commander:nro:final` and DEV-only uncached controlled
  recipe `commander-native-tool-final-collect` (fixed 40 valid sessions,
  ABBA×10, 20 per arm, frozen 60 paid-attempt cap).
- Tests (landed): `tests/commander-native-tool-dev-pilot.test.ts`,
  `tests/commander-native-tool-final-collect.test.ts`,
  `tests/commander-native-tool-control-extension.test.ts`,
  `tests/commander-native-tool-final-control-extension.test.ts`, and
  `tests/commander-native-tool-freeze.test.ts` (frozen-constant guard).

**Explicitly never touched:** `docs/baselines/commander-token-p9.md`,
`docs/baselines/commander-token-p9-protocol.md`,
`docs/baselines/commander-token-p3.md`, `docs/baselines/commander-token-p0.md`,
`docs/plans/commander-token-optimization.md`,
`docs/plans/worker-token-budget-repair.md`, `scripts/commander-token-benchmark.ts`,
`scripts/commander-token-p9-prepare.ts`, the P3/P9 manifest and session files,
`package-lock.json`, and `.pi/workbench/gates.yaml`.

**Touched only for the exact benchmark/pilot/final controlled CLI wiring:**
`package.json` (exactly the four `commander:nro:*` package scripts —
`prepare`, `benchmark`, `pilot`, `final`) and `.pi/workbench/recipes.yaml`
(exactly the four controlled NRO recipes —
`commander-native-tool-benchmark-prepare`, `commander-native-tool-benchmark`,
`commander-native-tool-dev-pilot-collect`,
`commander-native-tool-final-collect`). No other content of these two files
is modified by NRO; `package-lock.json` and `.pi/workbench/gates.yaml`
remain untouched.

## 9. Complete test matrix

Every row is release-blocking at the N4 verdict (and targeted at the slice
indicated). Expected behavior is verified by Commander-run recipes/gates and
actual-diff review, never by worker prose.

| # | Scenario | Required behavior | Slice |
| --- | --- | --- | --- |
| 1 | read legacy parity | read with explicit offset/limit, images, `@`-paths, missing file, offset beyond end, abort: results/errors byte-identical to the captured built-in definition on the fixture corpus; small no-offset/limit text reads: full content byte-identical with the deterministic facts trailer appended | N1 |
| 2 | read preview determinism | Same file + caps → identical preview text and identical facts; independent of cwd/session/date | N1 |
| 3 | read preview facts | complete/returned_lines/returned_bytes/total_lines/total_bytes/omitted_lines/omitted_bytes/next_offset/line_truncated all exact; complete=false ⇒ next_offset points at the first not-fully-returned content (returned_lines+1, or the truncated line's number when line_truncated=true); following next_offset (legacy pagination) reaches complete=true with no line skipped and no content silently lost (a truncated line's continuation re-reads that line in full) | N1 |
| 4 | read caps | ≥240-line or ≥12 KiB text file without offset/limit → preview at first cap hit; returned_bytes ≤ 12 KiB (facts trailer excluded); line-boundary cut only, with the documented oversized-line prefix representation (line_truncated=true, next_offset points at the truncated line) | N1 |
| 5 | read no hidden truncation | Every preview result's content states the facts (§6.1); details carries only the valid ReadToolDetails.truncation shape; renderer warning appears via inherited renderResult; no additional details keys | N1 |
| 6 | read images | Image files (jpg/png/gif/webp/bmp) → identical attachment content + note as built-in; preview never applies | N1 |
| 7 | read complete-read obligations | SKILL.md/AGENTS.md/plan/baseline/log reads: model can detect incomplete and continue via offset/limit or next_offset; analyzer verifies obligation reads terminated at complete=true in benchmark sessions | N1, N4 |
| 8 | read Unicode | UTF-8 byte accounting exact; no surrogate split; multi-byte and RTL content deterministic; caps code-point-safe at line boundaries | N1 |
| 9 | grep legacy parity | Default/matches output byte-compatible with built-in (paths, line numbers, context, limit, matchLimitReached/linesTruncated) | N2 |
| 10 | grep count exactness | output=count via the dedicated rg adapter equals the uncapped matches-mode ground truth (occurrences/lines/files); never capped by the legacy limit; never partial on timeout — explicit failure instead | N2 |
| 11 | grep count semantics parity | count respects regex/literal/ignoreCase/glob/path/.gitignore identically to matches mode (machine-compared corpus) | N2 |
| 12 | grep count compactness | Count result is a single small line carrying value and files=N; details undefined; no match lines inlined | N2 |
| 13 | grep files staging | output=files (if staged) returns distinct paths only, matches --files-with-matches ground truth | N2b |
| 14 | find legacy parity | Default/paths output byte-compatible with built-in (glob, path, limit, .gitignore, resultLimitReached) | N3 |
| 15 | find count / max_depth | output=count exact via the dedicated fd adapter; max_depth filter matches manual depth ground truth; plain paths calls without max_depth still delegate to the built-in | N3 |
| 16 | Runtime wiring | Stub registration: 11 catalog tools in order + exactly read/grep/find overrides in fixed positions; no loop/conditional registration; exactly one setActiveTools call site | N1 |
| 17 | Security/modes | AUDIT/VERIFY protected-path read still blocked by name; DEV allowed; VERIFY/AUDIT hard denials unchanged; override executes no writes, no pi.exec, and no shell (adapters use explicit argument vectors) | N1 |
| 18 | Abort/errors | signal abort → "Operation aborted" rejection parity on legacy and new paths; count timeout → explicit error, never partial number | N1, N2 |
| 19 | Stable prefix | No dynamic facts in the three overrides' metadata; fingerprint transitions exactly once per mode; static metadata scan (like P6-B) passes for the overrides | N1 |
| 20 | Unicode/truncation edge | CRLF files, trailing-newline files, empty files, huge single line (bounded UTF-8-safe prefix representation, line_truncated, next_offset escalation), BOM: deterministic facts and byte counts | N1 |
| 21 | .gitignore | read unaffected; grep count and find count/paths respect .gitignore exactly as legacy | N2, N3 |
| 22 | Compatibility/legacy | Old-session param shapes still valid; P8 recovery replay unaffected; sourceInfo provenance documented; worker-task contract wording check (no semantics change) | N1 |
| 23 | Benchmark integrity | NRO analyzer fail-closed on manifest/env/hash deviations; all attempts retained; dev vs final validation separation enforced (§10) | N0, N4 |

## 10. New independent benchmark protocol (NRO-N0)

**Independent, not P9:** this protocol does not reuse, extend, or redefine
`docs/baselines/commander-token-p9-protocol.md`. It has its own frozen
fixture, its own manifest/analyzer, its own arms, and its own thresholds
(§11). P9 artifacts are never an input. The protocol is written and frozen
**before** any validation collection (N0), and the analyzer is
machine-fail-closed like the P9 analyzer.

**Arms (treatment = the only difference):**

- **Control arm:** the **same current runtime source** as the treatment
  arm (`extensions/workbench-runtime/index.ts` default export,
  unchanged), loaded through the dedicated final-control adapter
  (`scripts/commander-native-tool-final-control-extension.ts`) that
  suppresses exactly the three canonical NRO registrations (`read`,
  `grep`, `find` — the `NATIVE_OVERRIDE_NAMES`, imported by identity
  from the runtime policy module) so the Pi built-in tools remain in
  effect for those three names — pristine built-in `read`/`grep`/`find`
  on the SAME current runtime (protocol §3.5). A literal pre-N1
  checkout is NOT the control arm: it would differ in other uncommitted
  runtime changes and confound the only-permitted-difference rule.
- **Treatment arm:** the same current runtime source loaded directly,
  with the N1/N2 (and N3, if approved) overrides registered.
- Both arms run the **same frozen fixture content and cwd**, the **same
  milestone prompt text**, the **same provider/model/thinking** (pinned
  `openai-codex/gpt-5.6-sol`, thinking `high`), the **same Pi version**
  (0.83.0, per `package.json` and the P9 `environment.txt`), the **same Node
  version** (v26.4.0), the **same skills/AGENTS.md/prompt-template content**
  (byte-hashed per arm and asserted equal), and **identical non-treatment
  prompt inputs**. Tool **names and order** are identical across arms; the
  only permitted difference is the three tools' override metadata/schema/
  behavior — that difference **is** the treatment and is recorded as such.
  The analyzer asserts arm equality of every non-treatment input by hash and
  fails closed on any deviation (mirroring P9 §3.5 fail-closed discipline,
  without reusing its constants).
- The fixture (proposed): a synthetic tree under
  `.pi/workbench/runs/commander-native-tool-benchmark/fixture/` with a mix of
  small files, files above the preview caps, a unicode file, an image, a
  `.gitignore`, and nested dirs — frozen byte-for-byte (manifest hashes).

**Collection discipline:**

- **Randomized/interleaved ordering** (e.g. random permutation or fixed
  ABBA-style interleave frozen in the protocol), fresh sessions only, **zero
  compactions** per session (fail-closed).
- **All attempts retained:** invalid attempts (wrong prompt hash, aborted,
  env drift) are preserved in a deviations record with their raw/prompt
  hashes — exactly the P9 discipline of disclosure, applied to new artifacts.
- **Exactly 20 valid runs per arm — 40 total, fixed ABBA** (protocol §3.4:
  the user-approved pre-final refreeze of 2026-08-06 fixed the
  already-permitted floor 20/arm as the exact final N, chosen after the
  DEV pilot and before any final validation collection for cost; the
  initial 30/arm target is superseded only for the NRO final cohort
  size; under-collection invalidates the benchmark).
- **Max final paid attempts: 60** (40 valid + bounded retry headroom —
  frozen; protocol §3.1/§4.6): the cap counts **each provider/model
  process once successfully spawned/started, whether or not it produces
  raw session JSONL** — it is not a count of produced raw sessions
  only. An exhausted cap ends final collection with a truthful partial
  final collection (all attempts retained; the exhausted status is
  reported by the collector's bounded CLI/run result, not declared by
  the strict collection record) that is **not analyzable/adoption
  evidence** — under-collection fails closed and completing the cohort
  requires a new protocol revision approved before any new collection.
- **Development vs final validation separated:** runs during N1–N3 development
  are development evidence only, never reported; the final validation cohort
  is collected only after the protocol and implementation are frozen and
  Commander-approved, and is the only evidence for §11.

**Metrics (per valid run, machine-derived):**

- Correctness: milestone-task output assertions (machine-checkable rubric
  frozen with the fixture — e.g. the task must produce specific facts about
  the fixture, including a complete-read obligation exercised through
  pagination).
- Requests; token components (input/output/cacheRead/cacheWrite); gross;
  successful inline bytes; per-tool calls and bytes (read/grep/find split,
  as in §2).
- Cost (descriptive); wall time.
- **Follow-up pagination:** count and bytes of continuation reads
  (offset/limit or next_offset) after previews; fraction of obligation reads
  that reached `complete: true`.
- **Incomplete-result misuse:** machine-observable signs that the model acted
  on a preview as if complete (e.g. quoting/editing content beyond
  `returned_lines`, or failing to paginate an obligation read) — audited per
  session against the frozen rubric.

## 11. Pre-registered adoption criteria

Frozen before validation collection; **post-hoc changes to denominators,
statistics, or thresholds are forbidden** — any needed change requires a new
protocol version approved before any new collection.

### 11.1 Release-blocking (N4 verdict requires all)

1. Correctness matrix (§9 rows 1–8, 16–18, 22) passes with recipe/gate
   evidence; benchmark correctness rubric passes in the treatment arm.
2. Security/mode semantics unchanged (§9 rows 17; §7.2) — guard still fires by
   exact name; no write path added.
3. No hidden truncation (§9 rows 3–5): every truncated result carries exact
   facts; analyzer-verified across the validation cohort.
4. Compatibility (§9 row 22): legacy/resumed calls, P8 recovery, legacy-path
   byte parity, worker semantics unchanged.
5. Commander-owned no-cache `check` and gates pass on the final diff (run
   after the N5 recording slice has synced; fresh run IDs resolved at
   execution time — never pre-filled).

### 11.2 Optimization thresholds (median across valid runs per arm, final validation cohort)

| Metric | Threshold | Note |
| --- | --- | --- |
| Successful inline bytes | **median reduction ≥ 50%** | with **≥ 80%** as the aspirational evidence milestone (the Commander Token Optimization plan's §10.2 target, kept aspirational) |
| Gross tokens | **median reduction ≥ 20%** | |
| Requests | **median non-increase** (treatment median ≤ control median) | guards against preview-induced extra rounds |
| Gross p90 | **no more than 5% regression** (treatment p90 ≤ 1.05 × control p90) | guards the tail |

- The Commander Token Optimization plan's aspirational targets — 25%
  (requests) / 80% (bytes) / 40% (gross), its §10.2 — remain **aspirational**
  and are reported separately as measured-or-not; they are not the NRO
  adoption thresholds.
- All statistics are computed by the frozen analyzer over the declared valid
  runs; no run may be dropped after collection; medians/p90s are the only
  statistics used for adoption.

## 12. Worker-first implementation slices

Every **writing** slice is **one fresh bounded worker delegation** (fresh
worker, one coherent vertical slice, source + tests + docs where applicable)
followed by **actual-diff review** (whole-diff scope check + hash binding —
every changed path vs. the delegation's parent-approved paths, never skipped)
and **Commander final verification** (Commander-run no-cache `check` and
gates; workers never run final gates and never claim PASS). Commander never
writes project files: the result record is written by a fresh worker
documentation-recording slice (N5), not by any Commander-owned phase. Exact
allowed paths are fixed per delegation by Sol at delegation time.

| Slice | Content | Notes |
| --- | --- | --- |
| **N0** | Benchmark protocol doc + analyzer/prepare harness + harness tests (`docs/baselines/commander-native-tool-benchmark-protocol.md`, `scripts/commander-native-tool-benchmark.ts`, `tests/commander-native-tool-benchmark.test.ts`) | Protocol frozen before any validation collection; writing slice like any other |
| **N1** | `read` preview: pure policy module + adapter override + tests + stable-prefix/compatibility docs updates and the deliberate source-scan test adjustments (§8) | The only slice that changes the read tool surface; legacy path byte-parity is the hard gate |
| **N2** | `grep` count (and staged `files` mode if evidence supports it) | Count exactness + semantics parity are the hard gates |
| **N3** | `find` count/max_depth — **only if** N1/N2 validation evidence supports it (§6.3) | Otherwise recorded as not performed, not a failure |
| **N4** | **Commander-owned measurement/verdict** (never a writing slice): final validation collection (bounded by the frozen 60 paid-attempt cap — §10), analyzer run, correctness audit, adoption-criteria verdict against §11; no document is written — the verdict facts are handed to N5 | Never a worker slice |
| **N5** | **Worker documentation-recording slice**: one fresh bounded worker records the N4 verdict into `docs/baselines/commander-native-tool-benchmark.md` (exact file paths and content contract fixed by Sol at delegation); then actual-diff review, then fresh post-sync Commander no-cache `check`/gates on the final diff | The only slice that writes the result record |

## 13. Stop/rollback conditions and open risks

**Stop conditions** (halt the slice stream and return to Sol):

- Legacy-path byte-parity failure (any fixture file where the override result
  differs from the captured built-in) → stop, fix at root, re-review (N1/N2/N3).
- Hidden-truncation or facts inconsistency (preview without facts, wrong
  `next_offset`, non-deterministic facts) → stop.
- Guard bypass (protected path readable in AUDIT/VERIFY through an override)
  → stop, revert the offending slice.
- Prefix churn: more than the one intentional fingerprint transition, or any
  dynamic fact in override metadata → stop (stable-prefix tests fail).
- Worker semantics drift (worker-budget/worker-policy tests red, or
  worker-task contracts changed in delegation semantics) → stop, revert.
- Benchmark integrity failure (arm inequality, dropped attempts, dev runs in
  the validation cohort, under-collection) → stop; recollect only under a
  re-frozen protocol. Attempt-cap exhaustion (protocol §4.6) likewise ends
  final collection with a truthful partial collection that is never
  analyzable/adoption evidence.

**Rollback:** each slice lands as its own reviewed delegation, so rollback is
that slice's git diff reverted and re-reviewed (including the N5 result-record
diff); removing the overrides restores the built-ins automatically. Data is
additive-only; no migration; P9/P3 artifacts are never touched by rollback
either.

**Open risks (recorded, not resolved):**

- **R1 — Preview-induced extra rounds:** a preview that omits needed content
  may cause an extra pagination call, raising requests/gross and eroding the
  byte savings. Mitigation: the §11.2 request non-increase and p90 gross caps
  are exactly this guard; the facts make continuation single-step exact.
- **R2 — Exact count CPU cost:** full-scan exact counts over large trees can
  be slow or hit timeouts. Mitigation: count uses the same installed ripgrep
  engine through the dedicated abort-aware adapter (same scanning cost as an
  uncapped grep), bounded by abort/timeout with an explicit failure (never a
  partial number); if unboundable without semantic loss, count mode is cut
  (stop condition).
- **R3 — Result-shape compatibility:** a subtle `details`/content divergence
  on a path not covered by the corpus could break renderers or the P8
  recovery/tool-result machinery. Mitigation: corpus breadth, byte-parity
  tests, facts-in-text with `details` undefined (or a valid
  `ReadToolDetails.truncation` shape only) — no additive details keys
  anywhere, inherited renderers.
- **R4 — Prefix churn and cache:** the one-time fingerprint transition costs
  one cache miss per affected mode; any further metadata drift would churn
  the prefix. Mitigation: static-metadata source scans (§9 row 19) and the
  stable-prefix docs update (§8).
- **R5 — Model stochasticity:** single-run comparisons are meaningless;
  adoption uses medians/p90s over exactly 20 valid runs per arm (the frozen
  final N) with all attempts retained and the frozen 60 paid-attempt cap
  (§10); no cherry-picking; dev/validation separation enforced.
- **R6 — Prose-guideline irrelevance:** the §6.4 bullet may be ignored by the
  model. Accepted: the mechanism (preview facts, count mode) does not depend
  on the bullet; the bullet is assist-only by design.

## 14. Current verdict (honest)

- **Design status:** **PRE-FINAL FROZEN (Rev. 4), pending final
  validation.** The NRO protocol (frozen at N0), the harness, the N1/N2
  implementation, and the dedicated final-control adapter
  (`scripts/commander-native-tool-final-control-extension.ts`) exist and
  have been reviewed; the FINAL collector implementation, its wiring
  (package script `commander:nro:final` + DEV-only uncached recipe
  `commander-native-tool-final-collect`), and its hermetic tests
  (`tests/commander-native-tool-final-collect.test.ts`) now exist and
  are awaiting/subject to Commander verification; the protocol was
  refrozen a second time (20+20, ABBA×10) and a third time (final-control
  arm + 60-attempt cap) — both **before any final-validation
  collection**. This document is not self-approved: it becomes
  Sol-reviewed/approved only if and when Sol accepts the final diff.
- **Implementation:** **N0, N1, and N2 landed and reviewed** — the
  protocol doc, the analyzer/`prepare` harness and its tests, the `read`
  preview override, and the `grep` count mode (policy modules, adapter
  wiring, and tests) exist; **N2b (staged `grep output: "files"`) and N3
  (find) are NOT_RUN**. The DEV pilot collection was run and reviewed
  (dev-phase evidence only, never reported; the dev-pilot control
  approximation is never used for final collection). The **FINAL
  collector implementation, wiring, and hermetic tests now exist**
  (`scripts/commander-native-tool-final-collect.ts`, package script
  `commander:nro:final`, DEV-only uncached recipe
  `commander-native-tool-final-collect`, and
  `tests/commander-native-tool-final-collect.test.ts`) and are
  awaiting/subject to Commander verification; **no final session or
  attempt has been collected** under any revision and the final
  validation collection has not been run.
- **Savings:** **NOT_MEASURED** — no token-savings claim of any kind is
  made; the audit (§2) is opportunity sizing only, and the frozen P9
  result (a release-quality verdict with all targets NOT_MEASURABLE/
  MISSED, §1) is preserved unchanged.
- **Records:** **no final collection exists, no N4 result exists, and no
  N5 result record** (`docs/baselines/commander-native-tool-benchmark.md`)
  has been written; no publish, tag, commit, or release occurred (the
  NRO work lives in the uncommitted working tree on top of the
  reproducible committed tree `aa2301763d95`). This wiring slice adds
  the package script, the controlled recipe, and the hermetic wiring
  tests only; it is **not** collection, **not** final acceptance, and
  claims no check/gate result.
- **Next steps (Commander-owned):** review this diff; then Commander
  runs the no-cache verification (`typecheck`/`unit-test`) and gates
  **without running the paid collection**; only after a separate
  explicit user authorization may the paid final validation collection
  run (fixed 40 valid sessions, ABBA×10, 20 per arm, bounded by the
  frozen 60 paid-attempt cap — protocol §4.6); the N4 verdict and the
  post-sync `check`/gates remain Commander-owned and are never
  pre-claimed; the result record is written only by the fresh N5 worker
  slice under actual-diff review.
