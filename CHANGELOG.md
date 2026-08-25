# Changelog

## [Unreleased] — Cache-prefix P0–P2

This section describes Unreleased source changes. No deployment, tag, package
publication, `/reload`, or measured live provider cache improvement is claimed.

### Added

- Strict cache-telemetry schema 1.3 correlates one context projection, one
  local `before_provider_request` observation, and one assistant
  `message_end`. Correlation code `1` is exact; codes `0`/`2`/`3`
  (unwired/multiple-or-stale-or-invalid/missing) fail closed to unknown actor
  and `historyProjection: null`.
- Numeric-only projection anatomy covers event/cause, hard caps, overflow at
  the decision, segment counts, raw/projected totals, stable/active slices,
  aged material, and retained suffix. The local wire observation always has
  `finalityCode: 0`: it is not an observation of the final provider wire.
- Trusted recoverable ingress covers exactly finalized recipe summaries,
  executed gate records, immutable comparisons, completed worker reports,
  finalized run pages, and run-id gate pages. Text at or below 4 KiB remains
  byte-exact with bounded metadata; larger text receives a deterministic 4 KiB
  recovery wrapper, and a low allocation falls back to the ordinary envelope
  over the original result without stale wrapper metadata. Allocation-aware
  gate pagination preserves every semantic row and cursor position.
- Durable ingress authority hashes source content and binds it to the stable
  size/device/inode/`mtimeNs`/`ctimeNs` snapshot of an in-project regular file
  no larger than 4 MiB. Collapsed history prefers this durable source pointer
  over receipt summaries. The same mechanism serves Commander, worker, and
  other roles; only their surrounding budgets differ.
- Reports and the offline benchmark expose whole-item LCP facts, separate
  Commander/worker cohorts, and disjoint prompt-input shares:
  `cacheRead / (input + cacheRead + cacheWrite)` and, only when its semantics
  are available, `cacheWrite / (input + cacheRead + cacheWrite)`. Numeric
  quality codes distinguish complete 1.3 evidence, mixed legacy data, partial
  or bounded sources, unverified usage, and unavailable/unverified write
  semantics. Responses write status `2` means normalized absence-or-zero—not
  provider-presence verification. Status `7` (`aggregate_overflow`) means the
  exact aggregate exceeds the safe numeric publication surface, so both shares
  remain `null`.
- Schema 1.3 validates the complete event/cause/overflow/segment matrix.
  Impossible projection anatomy degrades correlation to unknown rather than
  being persisted as actor evidence. Cache doctor also treats hostile or
  uninspectable telemetry objects as partial evidence without invoking Proxy
  traps or accessors.
- Commander native compaction now runs a content-free capacity preflight over
  Pi's actual `messagesToSummarize` and optional split-turn preparation. An
  envelope estimated below the warning threshold continues, a near-capacity
  estimate warns and continues, and a conservative estimate at or above model
  capacity is cancelled before its summary provider call with a bounded
  `/q-milestone-handoff <next step>` recovery notice. This engineering estimate
  is not a formal tokenizer-fit proof. A blocked event writes no compaction
  telemetry or supplement. Worker compaction remains cancelled before the
  preparation is read.

### Changed

- The pre-release single-slice local-commit draft is replaced by one structured
  `workbench_git` surface. `action=checkpoint` binds directly to sealed reviewed
  path bytes, batches every compatible semantic-ACCEPT slice into one commit,
  preserves unrelated dirty/staged work, and is not blocked by an unrelated
  newer pending/failed/diagnostic transaction or path-disjoint HEAD movement.
  Reviewed path drift, non-descendant history, intervening committed touches,
  invalid authority, conflicts, and in-progress Git operations still fail
  closed.
- `workbench_git action=push` adds explicit exact-HEAD ordinary publication for
  Sol in DEV. It pushes only current HEAD to the same named branch on an
  existing remote, never force-pushes or deletes refs, and verifies the remote
  ref after success. It grants no release, Gate, Formal, or production
  authority.
- Skill loading is development-first: five concise workflow/router skills stay
  model-visible, while nine orientation, CLI, release, and research specialists
  are explicit-only. Prompt templates select one primary workflow, references
  load conditionally, and ordinary build/debug paths use focused iteration plus
  one risk-proportionate final pass instead of unconditional full-suite runs.
- Generated AGENTS templates remain the complete fixed Sol → Luna policy
  authority; build and implementation resources retain a mandatory pointer
  without repeating the lease/review contract. The historical native-tool
  benchmark now verifies its frozen 70-row non-treatment manifest, so current
  skill improvements cannot rewrite or self-lock the old cohort.
- Commander/worker active-history hard caps increase to 192/128 KiB; `other`
  remains 64 KiB. With the unchanged 64/48 KiB turn reserves and sixteen
  384-byte segment slots, the fixed anchors become 122/74/10 KiB for
  Commander/worker/other. Crossing a turn reserve or 16-bundle suffix target
  alone remains byte-identical; only a true role hard-byte or 128-bundle
  crossing selects the protected suffix and seals aged material.
- At most 16 immutable segments remain in one epoch. A later true hard crossing
  performs the deterministic, model-free safety checkpoint: rebuild the
  anchor, clear the segment chain, and advance the epoch. Projection state v3
  and telemetry schema 1.3 remain unchanged; old v3 role-policy state is
  accepted and produces one deterministic `policy_changed` transition.
- Package specifications target Pi/pi-tui 0.84.2. Its public compaction types
  and implementation were rechecked at the official
  [v0.84.2 release](https://github.com/earendil-works/pi/releases/tag/v0.84.2)
  ([commit `914cf1472e715297caa30db4b9535d534a9eb718`](https://github.com/earendil-works/pi/commit/914cf1472e715297caa30db4b9535d534a9eb718));
  the repository dependency tree resolves Pi/pi-tui 0.84.2, but this
  Unreleased source entry makes no deployment, tag, package-publication,
  `/reload`, or live-qualification claim.
- The cache-design audit now records which principles were borrowed from
  [DeepSeek Harness at pinned commit `47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a):
  preserve an append-only reusable prefix, keep dynamic material late, and
  separate model-visible summaries from durable evidence. Provider MLA,
  server scheduling, and disk-KV ownership are explicitly non-transferable to
  this Pi client; no harness number is a workbench benchmark promise.

### Blocked

- Warm-prefix auxiliary compaction is
  `BLOCKED_BY_PI_0_84_2_PUBLIC_API`. Pi 0.84.2 still has no public post-summary
  payload transform or same-cache-domain guarantee, so the workbench does not
  duplicate private authentication, headers, streaming, retry, or provider-call
  logic. Allowed/warned requests use native Pi compaction; the new capacity
  preflight only cancels when its conservative envelope estimate reaches or
  exceeds the model context capacity.

## [0.10.0] — Context Output Control Plane

### Added

- A unified final-result envelope, deterministic per-turn reservations, and
  role-specific active-history projection for commander and worker requests.
- Strict continuation cursors, including explicit `wbcur2`/v2 high-resolution
  file snapshots (`mtimeNs`) while the exact `wbcur1` decoder remains
  compatible and conservatively stale on stronger sources; seek-based native
  read/run-log/gate pages, bounded details DTOs, numeric-only output-control
  status/telemetry, and a non-destructive legacy-session sanitizer with a hash
  manifest.
- Persisted comparison records, focused/stress/benchmark recipes, and the
  prerequisite-bound `ctx1` Context Output Safety gate.

### Changed

- Native `read` pages are limited to 12 KiB/240 file lines; run logs, diff
  review, compare, gates, list and inspect use whole-result limits rather than
  independently capped fields.
- Independent read-only tools may batch only when the runtime turn budget
  authorizes every call. Version, compatibility matrix, banner, schemas, and
  cache documentation now describe 0.10.0.
- Streaming calls now fail closed before execution unless the effective Pi
  registry proves an exact workbench-wrapped definition or pinned Pi built-in;
  foreign/SDK/collided tools cannot publish immutable oversized updates. Tool
  inventory and schema fingerprints remain unchanged. Exact provenance includes
  explicit temporary loading plus project- or user-scoped local package loading
  (`packages: [".."]` and the equivalent relative source written by
  `pi install -l .`). Package trust still requires the wrapped tool name, exact
  runtime entry, exact repository package root, exact package origin/metadata
  keys, and a bounded non-empty source; arbitrary foreign or collided packages
  remain denied.

### Fixed

- Active-history projection state v3 reserves the 64/48 KiB Commander/worker
  raw turn plus sixteen 384-byte segments inside the unchanged 96/64 KiB hard
  ceilings. The resulting anchor caps are 26/10 KiB and 96 bundles. The raw
  active suffix is capped at 16 bundles; each of at most 16 immutable segments
  projects no more than 384 tool-text bytes and one complete bundle. Seals
  1–16 preserve the epoch, anchor, old segments, and boundary markers and are
  expected tail rewrites. An attempt to create segment 17 triggers a
  checkpoint that rebuilds the anchor, clears the chain, and increments the
  epoch. Strict v1/v2 state is migration-only and carries monotonic epoch plus
  pressure—not topology. Under-cap legacy restore now emits one
  `legacy_migration` boundary without rewriting raw history, then persists
  inactive v3 so the boundary cannot repeat after reload.
- V3 history identity now hashes strings losslessly by exact UTF-16 code units,
  follows JSON property enumeration order, omits object `undefined`, and maps
  array holes/`undefined` to `null`. Array length, nesting, property count, and
  total work are bounded; Proxy, accessor, custom-`toJSON`, cyclic, non-plain,
  and over-budget input fails closed without invoking hostile code. The newest
  malformed matching or structurally unsafe session entry is authoritative and
  cannot revive an older valid projection.
- A fixed non-secret failure sentinel is now state-hash-protected in inactive
  v3 state. It survives JSONL restore, suppresses repeated failure transitions,
  and emits exactly one recovery boundary on the first healthy projection.
- Projected anchors and immutable segments end in deterministic bounded hidden
  markers whose safe boundary IDs derive only from provider-visible structural
  content. Public OpenAI explicit breakpoint injection is optional and limited
  to exact public `openai-responses` GPT-5.6 traffic with an existing cache key.
  It stays disabled for `openai-codex` pending live SSE and WebSocket probes;
  DeepSeek is a strict injection no-op while retaining the segmented-prefix
  benefit. No cache-hit improvement is claimed before deployment and verified
  provider usage.
- The documented cache strategy now follows the primary-source synthesis of an
  immutable fixed anchor, modular immutable segments, and rare checkpoints for
  both Commander and worker. OpenAI operational guidance is recorded explicitly:
  exact static-first/variable-last prefixes, a consistent `prompt_cache_key`,
  at most four new writes per request, the latest 50 read candidates, roughly
  15 requests/minute per key, and measurement through `cached_tokens` plus
  `cache_write_tokens`. Seventeen logical v3 markers do not imply seventeen
  writes on one request.
- Cache status distinguishes last-request from cumulative-session hit ratios;
  normal payload appends are no longer reported as prefix divergence, and
  project/session reports read a bounded chronological window across rotated
  and current telemetry with explicit data-quality handling. Cache doctor now
  scans that rotation set too, reports total telemetry bytes and source quality,
  and suppresses clean/no-drift conclusions for partial or truncated evidence.
- Cache report and offline benchmark now expose the numeric record facts
  `historyProjectionSegmentSeals`, `historyProjectionEpochTransitions`,
  `explicitBreakpointAppliedRequests`, and `explicitBreakpointVerifiedUsage`.
  The verified subset is now exactly successful (`messageStatus = ok`),
  semantically verified, eligible public OpenAI GPT-5.6 Responses traffic;
  errored requests remain visible as applied-shape facts but contribute no
  verified usage.
  Doctor checks `history_projection_events` and `explicit_breakpoint_usage`
  treat provider-reported `cacheRead = 0` as valid, skip default-disabled
  Codex/unsupported DeepSeek on complete evidence with no application record,
  expose numeric `erroredEligibleAppliedRequests`, and warn rather than report
  OK/authoritative usage when an eligible applied request ended in error. They
  also warn with an unavailable applied-subset ratio for partial, corrupt, or
  truncated evidence. The existing overall hit ratio remains a retained
  bounded-window metric when only oldest records were intentionally omitted.
  No measured cache improvement is inferred from these diagnostics.
- Formal context-output stress runs its fake provider in a temporary telemetry
  sink and proves repository telemetry files are unchanged. The 300 historical
  fake records already found in this checkout are deliberately left untouched;
  retention cleanup remains a separate operator decision.
- A strict nine-field `workbench-context-pressure-v1` entry records projection
  epoch/churn and raw-versus-projected diagnostics for a separately installed
  auto-compaction companion. Pi 0.83 context usage already measures raw session
  messages, so automatic thresholds use that usage alone and never add a
  raw-minus-projected delta. This package publishes the contract but does not
  deploy that companion extension. The v3 projection state does not change
  this diagnostic wire shape.

### Breaking

- The public tool metadata/schema fingerprint intentionally changes once;
  old cache prefixes are cold after reload. Unsafe legacy maxima are not
  retained. Internal full `record`/`report`/`gates_full` details are replaced
  by bounded DTOs and artifact pointers. Old sessions remain readable and can
  be migrated with `npm run session:sanitize`.

All notable changes to pi-dev-workbench are documented here.

## [Unreleased] — P8 Safe Nested Project Support

Adds an optional `project_dir` to `project.yaml` so a repository can point
stack detection and gate file-type checks at a nested directory while every
repository-root service stays put. No commit, tag or npm publish is
performed by this milestone.

### Added

- `project.yaml` `project_dir` (optional, default `.`): after config load
  the safe **effective project root** is resolved by
  `resolveEffectiveProjectRoot` (`core/config.ts`). POSIX absolute (`/x`)
  and Windows absolute (`C:\x`, `C:/x`, `\x`, `\\server\share`, `C:x`)
  values, paths that resolve outside the repository via `..`, missing paths
  and non-directories are rejected; the real (symlink-free) target must
  stay inside the real repository root (escaping symlinks rejected,
  inside-repository symlinks accepted). Every violation becomes a
  `project.yaml` `ConfigIssue` and the effective root falls back to the
  repository root — the effective root never points outside the repository
  and no outside content is ever read. `ProjectConfig` now exposes
  `projectDir` (raw) and `effectiveProjectRoot`.
- **Scope split:** stack detection (`core/inspect.ts`) reads only the
  effective project root's top level; git state and config-files-present
  stay repository-root based. Gate file-type content checks
  (`core/gate-engine.ts`): `kind: file` globs and the files read by
  `json` / `numeric` / `schema` checks resolve relative to the effective
  project root with realpath containment — always; the only
  repository-root exception is the built-in b0.4 check via internal
  catalog-only metadata (see Fixed below). Gate config, run persistence,
  recipe checks/execution, artifact run records and git stay
  repository-root based. Recipe `cwd` semantics are unchanged.
- `workbench_project_inspect` returns `effective_project_root` and its
  text output and the P4 renderer show the effective root explicitly
  (`core/render.ts` `InspectToolDetails.effective_project_root`).
- All three `templates/project/*/project.yaml` templates declare
  `project_dir: .` with a comment explaining the boundary; README,
  `docs/project-onboarding.md` and `docs/architecture.md` document the
  default/compatibility behavior.

### Fixed

- Cross-root defect in the built-in B0.4 check ("Required workbench files
  present"): it is `kind: file` with paths `.pi/workbench/project.yaml` /
  `.pi/workbench/recipes.yaml`, and after the P8 root split all `kind: file`
  checks resolved against the effective project root — so a legal nested
  project looked for the workbench config inside the nested directory
  (failing B0.4) and a nested `.pi/workbench` could impersonate the
  repository configuration. B0.4 now carries the INTERNAL catalog-only
  `file_root: "repository"` metadata (`GateCheck.file_root`, set only in
  `gate-catalog.ts`) and the engine resolves it against the repository
  root; general file/json/numeric/schema checks keep resolving against
  the effective root. Root selection is deliberately NOT part of the
  public gate schema: `parseCheck` never reads or returns `file_root`,
  and gates.yaml rejects both `root` and `file_root` as unknown fields —
  a project can never anchor a check at the repository root. Recipe and
  run semantics are unchanged.

### Tests

- `tests/config.test.ts`: default (omitted and explicit `.`), explicit
  nested directory, inside-repository symlink accepted, POSIX/Windows
  absolute rejections, `..` escape, symlink escape, missing path,
  non-directory, non-string and empty values, and the inspectable
  repository-root fallback (profile/recipes still load).
- `tests/inspect.test.ts` (new): stack detection reads only the effective
  root's top level (repo-root `package.json` ignored for nested projects),
  default root without `project_dir`, git and config-files-present stay at
  the repository root, bad `project_dir` falls back and surfaces as a
  config error.
- `tests/gates.test.ts`: file/json/numeric/schema checks resolve against
  the effective root; repo-root files do not satisfy nested checks;
  nested symlink escapes rejected; gate runs persist under the repo root's
  `.pi/workbench/runs`; recipe execution and artifact checks stay
  repository-root based; built-in B0.4 passes for a legal nested project
  (manifest/dependency at the effective root, workbench config at the
  repository root) while b0.2/b0.3 stay effective-root based; a nested
  `.pi/workbench` alone never satisfies the built-in B0.4 repository-root
  check; default file checks still resolve against the effective root;
  gates.yaml `root`/`file_root` are rejected by the strict schema; a
  catalog unit test proves B0.4 is the only check carrying the internal
  `file_root: "repository"` metadata and that `fileCheckRoot` maps it to
  the repository root.
- `tests/p4-render.test.ts`: expanded inspect renderer shows the effective
  root (nested and repository-root default).


## [0.9.1] — P7 Bounded Worker Handoff

Replaces the oversized single-toolResult worker handoff with durable
bounded report artifacts plus a strictly bounded structured parent summary.
No commit, tag or npm publish is performed by this milestone.

### Added

- Centralized bounded-handoff constants in `worker/handoff.ts`:
  `MAX_PARENT_HANDOFF_BYTES=12288`, `MAX_PARENT_HANDOFF_LINES=120`,
  `MAX_WORKER_REPORT_BYTES=524288`, `MAX_SUMMARY_ITEMS_PER_SECTION=8`,
  `MAX_SUMMARY_ITEM_CHARS=500` — UTF-8 BYTES govern every byte cap, and
  truncation never splits a multibyte sequence.
- Durable per-delegation artifacts for every finished outcome (success AND
  failure) inside `<CONFIG_DIR_NAME>/workbench/delegations/<id>/`:
  `worker-report.md` (the REDACTED complete final worker text, ≤ 512 KiB,
  mode 0600, atomic temp+rename, explicit truncation marker when
  oversized, persisted only — never part of any parent result/details),
  `worker-summary.json` (actual digest-based `changed_paths` — never
  worker prose — plus bounded parsed Completed / Verification commands
  and observations / Remaining Risks items, report path, turns, context
  budget facts, usage, cache hit ratio, and a parse warning when the
  report sections are missing/unreliable or the Files Changed claims
  diverge from the actual diff), and `usage.json` (bounded structured
  usage/cache/budget/turn facts with the nested worker usage shape
  preserved for cost accounting). The runner retains the COMPLETE final
  assistant text in process memory (bounded only by the 2 MiB JSON-event
  input — never pre-truncated to the report bound); the ledger redacts
  FIRST and caps + appends the truncation marker only when the REDACTED
  report still exceeds 512 KiB, so post-secret tail content survives when
  redaction makes the report fit. worker-summary.json also persists the
  parse-reliability and item-truncation facts and is the SINGLE summary
  derivation the parent handoff renders (the runtime never re-parses the
  report text for the parent).
- Strictly bounded parent `workbench_delegate_worker` result: the content
  never concatenates `result.output`/report/patch/test logs, is capped to
  ≤ 120 lines / 12288 UTF-8 bytes by reserving every required fact line
  (identity/status/turns, bounded actual changed paths with an omission
  count, usage/cache/budget, report/summary/usage artifact paths,
  parse/review/failure facts) and dropping optional summary items only as
  WHOLE sanitized lines — a rendered line is never cut mid-item or
  mid-code-point. Structured details are tightly bounded (changed paths
  capped, failure/identity/stop strings bounded) and carry only delegation
  id / report path / summary / verification observations / risks / turns /
  usage / cache ratio / budget / status / identity —
  `allowed_paths`/`output`/`full_report`/`transcript`/`patch` fields are
  prohibited. Top-level nested worker usage is preserved.
- Four-section report parser (`## Completed` / `## Files Changed` /
  `## Verification` / `## Remaining Risks`) with at most 8 items per
  section and 500 characters per item; MISSING required sections (or an
  empty report) make parsing unreliable and the parent then contains no
  partial parsed section items — only the parse warning + report path +
  actual changed paths (never a raw-text fallback), while item-cap hits
  alone keep otherwise-present sections reliable and render as bounded
  items plus an explicit truncation fact (the distinction is persisted as
  `parse_reliable`/`truncated_items`). `parseReportedPaths` now scans the
  whole bounded report (its window equals the 512 KiB report artifact
  bound) so the review's reported/actual comparison works on long reports
  whose sections sit at the end.
- Progress exposes only turns and provider/model: `lastText` removed from
  the parent-facing `WorkerProgress` type and callback; the exact compact
  shape `DeepSeek worker: N turn(s), model provider/model` (starting state
  included); intermediate/final worker text never enters `onUpdate`.
- Diff review defaults raised to 400 lines / 32 KiB, enforced GLOBALLY
  over the rendered patch content (never independently per path); ANY
  per-path truncated entry also sets `patch_truncated` — even when the
  redaction-shrunk entry fits the global envelope — so the segmented
  `include_paths` review instruction (max 50 paths per call) always
  renders when any content was cut; bounded per-path patch stats
  (`patch_paths`: source, bytes, truncated/omitted). Scope checks and the
  bound diff hash always use the complete actual worker diff; an unbounded
  full patch is never persisted or returned.
- Pure context diagnostics in `worker/context-diagnostics.ts`:
  `estimateLatestTurnTokens`, `compactablePrefixAvailable`, and
  `detectSingleHugeRecentTurn` inspect bounded session-entry-like facts
  defensively (Pi's char/4 heuristic and `prepareCompaction` boundary
  structure — the latest compaction's `firstKeptEntryId` on ORIGINAL entry
  indices with the compaction-index+1 fallback; historical entries before
  the boundary never count — mirrored without implementing compaction) and
  detect the problematic latest delegation tool-result turn; `/q-status`
  and `/q-delegation-status` visibly include exactly `CONTEXT RISK: latest
  delegation handoff too large` when detected. The default thresholds are
  defined relative to the centralized 12 KiB parent cap (2× = 24576 bytes
  / 6144 char/4 tokens): a valid new bounded handoff never triggers, the
  pre-fix ~50 KiB runner-bounded handoff always does; malformed input
  fails safe.
- UTF-8 truncation is CODE-POINT safe: `truncateUtf8` binary-searches over
  code points (never UTF-16 code units), so 4-byte astral characters are
  never split into a lone surrogate and no replacement character can
  appear; boundary tests cover astral emoji at byte caps 1-5.
- Documentation (`docs/worker-delegation.md`: bounded handoff, artifact
  paths and limits, review segmentation, diagnostics, Sol's mandatory
  actual-diff/final-verification duties) and focused tests
  (`tests/worker-handoff.test.ts` plus coverage in worker-runner /
  delegation-ledger / diff-review suites) for report persistence,
  atomicity/containment/redaction/oversize truncation, parser success and
  fallback, item limits, UTF-8 parent caps, details and progress
  exclusions, actual changed paths, bounded review/hash completeness, and
  compactability diagnostics; existing worker budget/compaction fail-closed
  regressions continue to pass.

## [0.9.0] — P7: Worker-First Write Authority and Controlled Sol/DeepSeek Worker Delegation

Worker-first write authority, controlled Sol/DeepSeek worker delegation,
and the P7 release of the workbench. No commit, tag or npm publish is
performed by this milestone.

### Added

- Static DEV-only `workbench_delegate_worker` tool: GPT-5.6 Sol delegates one
  bounded implementation task to a short-lived, isolated
  `deepseek/deepseek-v4-flash:max` Pi child process.
- Fail-closed commander and worker model checks, non-recursive worker role,
  sequential execution, abort/timeout propagation, bounded JSON event and
  stderr handling, nested usage accounting, and parent-approved edit/write
  path scopes.
- Worker role guard blocks free-form bash and final gate execution; only
  declared recipes with an empty `writes` list remain available for development checks. AUDIT and VERIFY
  hard-deny delegation, preserving Sol-only final review and gate judgment.
- Unit and spawn/integration tests for model pinning, environment isolation,
  role restrictions, path containment, failures, timeout, and cancellation.
- [Controlled Worker Delegation](docs/worker-delegation.md) documentation plus
  architecture, security, mode-matrix, and tool-inventory updates.
- Cache observability for the commander session and the worker report:
  `openai-codex-responses` (Pi's Codex provider — GPT-5.6 Sol) is now a
  verified Responses-style usage semantic (it streams through
  `openai-responses-shared`), so Sol's telemetry records compute the exact
  `cacheHitRatio` and the footer renders a numeric `CACHE` segment instead
  of `CACHE N/A`; unknown api kinds still degrade to `partial`/`null`.
- Deterministic worker cache summary (`workerCacheHitRatio` +
  `formatWorkerCacheSummary` in `worker/runner.ts`): the
  `workbench_delegate_worker` final text appends
  `worker cache : uncached input N | cache read N | hit ratio P%`, the
  structured `details` carry the aggregated `usage` and a nullable
  `cache_hit_ratio`, and the top-level tool `usage` is preserved. A worker
  with zero input (zero denominator) renders `hit ratio N/A` and
  `cache_hit_ratio: null` — never NaN.
- Raw Codex Responses usage fixture (same `finalizeResponse` mapping as
  `openai-responses`) and telemetry regressions: a Sol record is verified,
  computes the exact ratio, and renders the numeric CACHE footer; verified
  zero-denominator usage yields `null`/`CACHE N/A`.
- Split session-cost observability: `core/cost-breakdown.ts` mirrors Pi's
  default footer cost aggregation over session entries — assistant message
  usage lands in the commander bucket (grouped per
  `provider/responseModel ?? model`), `workbench_delegate_worker` tool-result
  usage in the worker bucket, and all other tool-result plus
  `branch_summary`/`compaction` usage in the other bucket. Malformed,
  non-finite and negative values contribute zero (never NaN, never a crash),
  and `total` is exactly `commander + worker + other`; for valid data the
  totals match Pi's native footer numbers.
- Compact deterministic `COST S:$… W:$… O:$…` status segment (O omitted
  when zero, S and W always shown) appended through the existing
  `ctx.ui.setStatus` flow — the Pi footer is never replaced.
- Status refresh after assistant/tool-result `message_end`; because Pi 0.83
  persists messages after extension handlers, the pending event message is
  included exactly once so COST/CACHE update immediately without double
  counting.
- `/q-cost-status` command printing the exact commander, worker, other and
  total costs plus the per-model commander breakdown from
  `ctx.sessionManager.getEntries()` — works in TUI and print/json modes via
  the shared output helper.
- Unit tests for classification, reconciliation (exact bucket sums and the
  Pi-footer mirror), malformed values, formatting, status integration, the
  registered command's TUI/print behavior, and the deterministic command
  inventory (23 → 24 commands).
- Worker context-budget protection: pure `core/worker-budget.ts` for the
  pinned `deepseek/deepseek-v4-flash:max` window (1,000,000 context tokens,
  80% soft handoff at 800,000, 90% hard stop at 900,000 — model-specific
  and independent of the Commander/project compaction reserve) with
  Pi-compatible context-token calculation (positive `totalTokens` wins,
  otherwise the non-negative `input + output + cacheRead + cacheWrite`
  sum; malformed values contribute zero).
- Worker-role lifecycle only: one hidden active-loop (`display: false`,
  `deliverAs: "steer"`) soft-budget handoff telling the worker to stop new
  implementation, finish a concise handoff, and list the remaining work;
  `session_before_compact`
  is cancelled (`{ cancel: true }`) so a worker never silently continues
  through lossy compaction. Commander compaction behavior is unchanged.
- Runner budget/compaction tracking: per-message max context tokens and
  ratio, soft-budget reach flag, `compaction_start` parsing with count and
  distinct reasons, fail-closed termination at the 90% hard budget, and
  rejection of any result with a compaction attempt or hard-budget stop.
- The worker report exposes `max_context_tokens`, `max_context_ratio`,
  `soft_budget_reached`, `hard_budget_exceeded`, `compaction_count` and
  `compaction_reasons` in structured `details` plus a deterministic
  `worker budget : max context N / 1000000 (P%) | soft 800000 | hard 900000`
  text line.
- Worker-first write authority (P7): approved GPT-5.6 Sol in DEV resolves to
  the fixed `worker-first-strict` policy — the exact canonical 14-tool
  allowlist (read, grep, find, ls + all 10 workbench tools; no
  bash/edit/write, no foreign tools) with no persisted/prompt/config opt-out;
  actor identity comes only from the existing `WORKBENCH_AGENT_ROLE=worker`
  env contract and the provider/model pair (project config can never
  self-label a controller as Sol or as a worker); delegated workers and other
  controllers keep their existing guards (the worker guards remain
  authoritative; other controllers are not newly denied).
- Second-layer commander guard: for strict Sol, `bash` is always blocked,
  `edit`/`write` require an ACTIVE user-issued temporary write lease
  authorizing the project-relative path and the remaining call, and every
  tool outside the allowlist is blocked despite any re-enable; blocked
  commander write attempts are counted while a review is outstanding.
- User-only temporary commander write leases (commands, never model tools):
  `/q-write-policy status` (accepts exactly the trimmed `status` subcommand),
  `/q-commander-write-unlock <reason> --paths <comma-list> --calls <N>
  --minutes <N>` plus the two-step confirmation forms
  (`confirm <partA> <partB>` / `confirm <lease-id> <partA> <partB>`), and
  `/q-commander-write-lock` (explicit revocation + persisted audit facts).
  Fixed reasons (`bootstrap-policy`, `worker-unavailable`,
  `security-emergency`, `user-directed`), project-relative exact or `/**`
  subtree paths (absolute POSIX, Windows drive and backslash-root paths
  rejected before normalization, `..` escapes refused), edit/write only
  (never bash), max 10 calls / max 30 minutes, one call consumed per
  successful authorized write, expiry/exhaustion/revocation (leaving DEV,
  model/provider change, session end) restoring the exact canonical 14 tools;
  TUI requires an explicit human confirmation dialog (cancel leaves locked),
  non-TUI issues a PENDING lease with two bounded distinct token parts
  displayed once and confirms on a second invocation with both exact parts
  (both consumed on success; tokens never appear in status/compact
  summaries); fail-closed restore of persisted leases.
- Write-authority footer segments: `WF:LEASE <used>/<max>` for an ACTIVE
  confirmed strict-Sol lease, `WF:LOCKED` for every other lease state, and
  `WF:REVIEW` appended independently while a delegation review is pending or
  stale; workers and other controllers render no WF segment.
- Delegation ledger (P7): every delegation writes a bounded before/after
  ledger at `<CONFIG_DIR_NAME>/workbench/delegations/<id>/` —
  `manifest.json`, `before.json` (contract, git HEAD/dirty, before diff
  hash, per-path porcelain status codes + bounded content digests), and on
  every outcome (success AND failure) `after.json` (TRUE changed paths since
  before incl. previously-dirty paths, after diff hash, pinned identity,
  usage/budget facts, bounded redacted report summary, safe reported_paths
  parsed from the worker's `## Files Changed` section), `worker-summary.json`
  and a `review.json` PENDING_REVIEW placeholder. Atomic writes, redacted,
  bounded; the ledger's own directory never counts as a project change;
  argv-only git exec.
- Review lifecycle (P7): `workbench_review_worker_diff` re-reads the REAL
  git state, scope-checks every worker path against `allowed_paths`
  (realpath/symlink-safe; `include_paths` narrows only the patch and can
  never hide a violation), binds the CURRENT diff hash vs the recorded after
  hash (mismatch/drift warnings), warns when the worker's `## Files Changed`
  section is missing or inconsistent with the actual diff, writes the
  completed `review.json`, and marks REVIEWED only on PASS (FAIL keeps
  PENDING_REVIEW); `workbench_delegation_status` + `/q-delegation-status`
  report actor, policy, lease, delegation, hashes, blocked-write counter and
  latest verdict. PENDING_REVIEW/STALE blocks the next delegation AND VERIFY
  (`/q-mode-verify` and VERIFY gate runs are refused); any diff change after
  REVIEWED turns the delegation STALE (a diff returning to exactly the
  reviewed hash re-validates); state persists via the
  `workbench-delegation-state` custom entry with fail-closed restore.
- Inventory: command surface 24 → 28 and workbench tool surface 8 → 10
  (delegate → review → status), pinned by the inventory test; the three P7
  delegation tools have no compact TUI renderers (the P4 five remain the
  only ones).
- Unit and spawn/integration tests: `tests/write-authority.test.ts`,
  `tests/delegation-ledger.test.ts`, `tests/delegation-state.test.ts`,
  `tests/diff-review.test.ts`, plus worker-policy and inventory updates —
  actor identity, the exact 14-tool order, lease bounds/reasons/paths/
  confirmation/revocation, ledger bounds/atomicity/self-exclusion, review
  hash-binding invariants, delegation/VERIFY blocking, stale transitions,
  and reported-vs-actual path notes.
- Documentation: README, CHANGELOG, docs/architecture.md,
  docs/security.md, docs/worker-delegation.md and docs/compatibility.md
  updated for worker-first write authority, the user-only lease commands,
  the delegation ledger and the review lifecycle (released as 0.9.0;
  historical 0.8.0/P6 records unchanged).
- Machine-backed B6 Worker-First Compliance gate: universal base gate with
  eight `worker-first` checks (strict policy active, zero unauthorized
  commander writes or hard denial active, no pending/stale review, reviewed
  hash matches the current diff, worker paths within the approved
  contracts, no active unexplained lease, Sol-initiated final
  verification). The runtime injects bounded worker-first facts into every
  gate run — missing facts are NOT_RUN (a required NOT_RUN never PASSes),
  a pending/stale review BLOCKs B6, and model prose can never satisfy
  B6.1-B6.8.
- Recipe mutation policy: every recipe declares
  `mutation: none | artifacts | source` (strict parsing; legacy inference
  maps non-empty `writes` to `source`); strict Sol runs only
  `none`/`artifacts` recipes and delegated workers only `none` (write-free)
  recipes — `source`-mutating recipes are denied to both through one shared
  pure decision enforced at the `tool_call` guard and in gate recipe
  checks (other controllers are unaffected).
- Worker-first workflow contract: `q-build`, the implementation-workflow
  skill, and both project AGENTS templates explicitly state the seven
  worker-first rules (Sol owns requirements/architecture/scope/criteria;
  routine source/tests/docs/config writes are worker-owned by default;
  high-risk decisions remain Sol-owned while the concrete writes are
  bounded worker slices; worker defects are repaired by a fresh worker;
  only a user-issued temporary write lease is an exception; worker reports
  are never acceptance; Sol reviews the actual diff and runs the final
  recipes/gates); focused package-content tests fail when any of the
  delegation, fresh-worker repair, actual-diff review, lease exception or
  commander final-gate language is removed.

### Changed

- The Pi-native architecture contract now permits an explicit short-lived Pi
  worker loop while continuing to forbid standalone agent frameworks,
  daemons, background services, recursive delegation, and worker-owned final
  verification.
- Sol/Worker responsibility split: Sol owns requirements, cross-cutting
  architecture, scope, actual-diff review, final verification/gates, and the
  verdict; the worker owns routine local implementation decisions inside the
  approved contract and is expected to deliver a complete source+tests+docs
  vertical slice (investigation, production source changes, tests, docs,
  write-free recipe checks, in-scope repair) instead of stopping after a
  narrow code edit.
- Static `workbench_delegate_worker` metadata and the worker system prompt
  now codify the DEV default: coherent bounded low/medium-risk vertical
  slices after minimum repository orientation, with explicit
  source/tests/docs paths and observable acceptance criteria, Sol
  independent diff inspection, and worker prose never treated as acceptance.
- Documentation: low/medium/high-risk delegation rubric, Commander-led
  responsibilities, fresh-worker continuation (every delegation is a new
  `--no-session` worker), and the one-writing-worker-per-worktree rule.
- Focused tests for the responsibility boundaries, the complete-slice
  task/prompt contract, and the static delegate-tool metadata. Worker
  verification reports are observation-only: they may not self-mark any
  acceptance criterion satisfied/met/passed/accepted/complete; only Sol maps
  evidence to criteria.
- `session_before_compact` is now cancelled inside the delegated worker
  process only; the commander session still supplements (never cancels)
  Pi compaction. The runner keeps exactly one short-lived
  `pi --mode json -p --no-session` subprocess per invocation — no worker
  process reuse, session persistence, or daemon is introduced.
- `VERIFIED_API_KINDS` now includes `openai-codex-responses`; cache telemetry
  and worker-delegation docs describe Sol and worker cache observability
  accurately.
- Reviewed policy corrections: high-risk work remains Commander-led, not
  categorically impossible to delegate — Sol owns requirements, cross-cutting
  architecture, and core safety decisions and never delegates the decision
  itself; under worker-first write authority Sol does NOT directly write by
  default (implementation and repair writes go to a fresh bounded worker),
  and only explicitly designed bounded support/implementation scopes are
  delegated after the architecture is fixed — a temporary commander direct
  write requires an explicit user-issued write lease and is never the DEV
  default. The worker system prompt still requires stopping and reporting
  instead of guessing or expanding scope when completion needs an unapproved
  architecture, security/policy, destructive, or out-of-scope decision.
- The worker-prompt focused test asserts the explicit
  no-final-PASS/acceptance prohibition instead of a banned substring, and
  the delegate parameter-schema regression pins the reviewed baseline hash
  `2cf1f563f78ffe2c85d142c1f40deea7bc658365345554db11c80b8af6b521d9`
  instead of comparing the schema to itself.

### Released

- Version 0.8.0 → 0.9.0 (package.json, package-lock.json root entries,
  `EXTENSION_VERSION` in cache-types.ts, `compatibility/pi.json`
  current-version manifest, README current version, deterministic banner
  version chip + alt text); P7 is promoted from Unreleased to the 0.9.0
  release section; historical 0.8.0/P6 release records stay historical.
- Commander compaction re-enabled in `.pi/settings.json`
  (`compaction.enabled: true`; `reserveTokens` 27200 and
  `keepRecentTokens` 20000 unchanged); the local settings backup files
  (`.pi/settings.json.backup-*`) and the `.p7-recovery/` directory are
  gitignored so recovery artifacts are not release changes.

## [0.8.0] — P6-E: Cache Benchmark, Hardening, and Release Gate

Offline cache benchmarking, DeepSeek-final-constraint audit, privacy audit,
compatibility/security docs update, and the P6 release gate. No commit,
tag or npm publish is performed by this milestone.

### Added

- **Offline cache benchmark CLI** (`scripts/cache-benchmark.ts`): `report`,
  `doctor` and `compare` subcommands; reads ONLY workbench telemetry JSONL,
  run manifests and action cache records. Never calls a model, never sends
  HTTP, never reads `auth.json`/`models.json`, never warms caches, never
  modifies providers, never hardcodes provider prices (`--cost-map`
  required for `estimatedAvoidedCost`, otherwise `null`). Outputs the full
  contract: requestCount, uncachedInputTokens, cacheReadTokens,
  outputTokens, cacheHitRatio, usageSemanticStatus, providerReportedCost,
  estimatedAvoidedCost, expectedInvalidations, unexpectedDrifts,
  mode/model/thinking changes, reloads, compactions, recipe executions /
  cache hits / misses / hit ratio, localExecutionTimeAvoided,
  cacheStorageSize, corruptionCount, fallbackCount. JSON and human-readable
  output; friendly exit when no telemetry; corrupt lines counted, never
  fatal; `--session`/`--since`/`--until` scoping; `--save` (atomic) and
  `compare` over saved reports (both the extension and benchmark report
  shapes).
- **npm scripts** `cache:report` and `cache:doctor`.
- **Offline doctor context** in `cache-doctor.ts` (`context: "cli"`):
  Pi-dependent checks (system prompt, live tool registry, model registry)
  are honestly SKIPPED offline — never silently passed — and provider/
  model/apiKind are derived from the last telemetry record; new offline
  checks: action-cache integrity, index consistency, stale locks, recipe
  cache consistency.
- **Docs**: `docs/cache/cache-benchmark.md` (statistical definitions),
  `docs/cache/P6_BENCHMARK_REPORT.md` (P6-A→P6-B→P6-C before/after from
  `p6a-baseline` / `p6b-stable-dev` / `p6c-action-cache` saved reports),
  `docs/cache/P6_RELEASE_REPORT.md` (tested versions, P6-A usage mapping,
  P6-B prefix stability evidence, P6-C/P6-D verification, DeepSeek final
  constraints, known limitations, rollback + clear/prune instructions);
  README, CHANGELOG, compatibility.md, security.md and
  compatibility/pi.json updated.
- **Benchmark corpus**: `p6b-stable-dev.json` saved report (135-request
  P6-B session); whole-corpus analysis: 602 requests, 99.55% provider-billed
  cache hit ratio, systemPromptHash/toolNamesHash/toolOrderHash constant
  across the corpus, zero same-mode `UNEXPECTED_DRIFT` with driftSource,
  5/12 recipe cache hits (138.4 s local execution avoided), 0 corruption,
  0 lock fallbacks.
- **Tests**: `tests/p6-e-cache-benchmark.test.ts` (15 tests) covering
  tolerant telemetry reading, run-manifest parsing, action-cache facts,
  the full 23-field report contract, cost-map rules, session scoping,
  rendering, mixed-shape normalization, CLI exit behavior.

### Changed

- Version 0.7.0 → 0.8.0 (package.json, package-lock.json,
  `EXTENSION_VERSION` in `cache-types.ts`); banner alt text.

### Audited (this milestone)

- **DeepSeek final constraints (17/17 hold):** no auth.json access, no
  models.json/models-store.json writes, no DEEPSEEK_API_KEY dependency, no
  cache_control / prompt_cache_key / prompt_cache_retention, no cache TTL
  configuration, no keepalive, no warmup requests, no dynamic/deferred
  tool loader, no supportsToolSearch/supportsToolReferences, stable per-mode
  tool sets, P5 permission isolation on mode switch, cacheWrite=0 is not an
  error, provider best-effort miss is a normal possibility, no hardcoded
  DeepSeek prices.
- **Privacy/security audit:** hash-only telemetry with forbidden-key deep
  scan, read-only payload digests, recipe redaction/truncation, path
  containment (lexical + realpath) for recipes and report saves, corruption
  → miss + quarantine, rebuildable index, per-key locks with stale-lock
  recovery, rotation/prune bounds, prune/clear never delete run evidence,
  non-TUI crash safety, project-trust gating, cache hits never bypass
  gates, mutable `latest` never cached, failed folds never hidden, no
  HFT/LOB/market-making functionality (grep-verified).

## [0.7.3] — P6-D: Quant Research Cache Contracts

Versioned manifest contracts that make quantitative research caching safe.
The workbench only **defines, validates and connects** the contracts — it
never downloads market data, never computes features, never runs a backtest
engine. Cache hits never bypass Q0–Q5.

### Added

- **Three versioned contract schemas** (`cache/quant-contracts.ts`):
  DATA_SNAPSHOT, FEATURE_SET, BACKTEST_RESULT with required fields,
  per-profile requirements (stock-selection: point-in-time universe,
  industry/market-cap versions, financial publication alignment,
  winsorization, normalization, missing-value policy; market-timing:
  signal timestamp, bar open/close, resampling, warmup, timezone,
  calendar) and a strict validation status model (`invalid` / `unresolved` /
  `validated`). Manifests that merely parse — missing adjustment/
  corporate-action/delisting semantics, mutable ids, unresolved logical
  references, walk-forward with empty folds, best-trial-only, missing
  trial lineage — can never be `validated` and never cacheable.
- **Immutable reference discipline**: `latest`/`current`/`now`/`today` can
  never be a final manifest id or cache key; logical references resolve
  against a registry (same-dir, `artifacts/**`, `.pi/workbench/quant/registry/**`)
  to the newest immutable revision; unresolved references refuse the quant
  cache; `logicalReference`/`resolvedReference` are recorded in action
  records.
- **Recipe cache `domain: quant` + `quantContract {type, manifest}`**: still
  opt-in (default off), manifest must exist, schema-invalid refuses the
  cache at key time and write time, the resolved immutable key joins the
  action key, `backtest-result` hits re-verify `resultArtifactHash`
  (mismatch = corruption), manifest warnings preserved verbatim, failed
  folds never filtered.
- **Gate integration**: built-in schema checks for the three contracts
  (`schema: data-snapshot|feature-set|backtest-result`) that only PASS for
  fully `validated` manifests; cached runs keep re-validating through the
  full Q ladder.
- **Commands**: `/q-cache-validate <manifest-path>` (contract type, schema
  version, immutable/mutable, content hash, upstream keys, missing fields,
  warnings, cache eligibility, Q gate implications) and `/q-cache-lineage
  <run-id|action-key>` (contract chain, upstream relationships, action
  keys, artifact hashes, reused runs, invalidation reason). Neither ever
  reads data files into the model context.
- **Fixtures** (`fixtures/quant/`, real structure, no investment
  conclusions): valid-data-snapshot, invalid-latest-snapshot,
  valid-stock-selection-feature-set, valid-market-timing-feature-set,
  valid-stock-selection-backtest, valid-market-timing-backtest,
  missing-point-in-time, missing-corporate-action-policy,
  failed-fold-retained, corrupted-artifact.
- **Templates**: stock-selection and market-timing recipes gain
  `domain: quant` cache blocks (data:fetch → data-snapshot,
  feature:compute → feature-set, backtest → backtest-result) and the
  gates.yaml documentation covers the contract schema checks.
- **Docs**: `docs/cache/quant-cache.md`, `data-snapshot-contract.md`,
  `feature-set-contract.md`, `backtest-result-contract.md`,
  `quant-cache-invalidation.md`; recipe-cache-schema updated for
  `domain`/`quantContract`.
- **Tests**: `tests/p6-d-quant-contracts.test.ts` (32) and
  `tests/p6-d-quant-cache.test.ts` (25) covering the key/invalidation
  matrix, reference resolution, corruption, lineage and cached Q Gate
  revalidation.

### Not implemented (by design)

- No HFT / L2/LOB / tick replay / queue model / market making / matching
  engine / colocation / latency / exchange order routing / live execution
  schema or module — verified by tests.
- The workbench does not verify `rawDataHash`/data-file content hashes
  beyond bounded streaming verification of the declared result artifact;
  data files are never read into memory or the model context.

## [0.7.2] — P6-C: Deterministic Recipe Action Cache

An **opt-in, project-local, result-only cache** for declared recipes:
`actionKey -> execution result metadata`. Disabled by default; only
successful results cached by default; cache failures degrade to normal
execution; gates are never bypassed (a hit creates a full new run record
with `executionSource: cache` and gate statuses stay PASS/FAIL/BLOCKED/
NOT_RUN).

### Added

- **Action cache** (`cache/action-types.ts`, `action-key.ts`,
  `action-fingerprint.ts`, `action-store.ts`, `action-cache.ts`,
  `action-explain.ts`): full action key (recipe definition, argv, cwd,
  mode, declared env hashes, toolchain versions, OS/arch, lockfile
  hashes, declared-input Merkle hash, workbench config, profile, gate
  schema, upstream keys — never git state/mtime/size), streaming SHA-256
  input fingerprinting with symlink-escape refusal and protected-secret
  refusal, per-key locking with stale recovery, atomic writes, LRU prune,
  corruption handling (action JSON → quarantine+miss, index rebuild, CAS
  re-verify), capacity limit via `project.yaml cache.actionCache.maxBytes`.
- **Recipe schema** `cache:` block: `enabled/version/mode/successOnly/
  inputs/outputs/environment/toolchain/maxAgeSeconds/upstream` with
  parse-time denial of network/time/random/source-mutating recipes
  (violations disable caching with a warning, never the recipe).
- **Commands**: `/q-run <recipe> [--no-cache|--refresh-cache]`,
  `/q-cache-explain <recipe>`, `/q-cache-prune [--apply]`,
  `/q-cache-clear <recipe|all>`; `workbench_run_recipe` gained a `cache`
  parameter. Gate recipe evidence records `execution_source`.
- **Bootstrap recipes** in `.pi/workbench/recipes.yaml`: `typecheck` and
  `unit-test` cached (result-only), `check` intentionally uncached.
- **Docs**: `docs/cache/action-cache.md`, `recipe-cache-schema.md`,
  `cache-maintenance.md`, `cache-correctness.md`.
- **Tests**: `tests/p6-c-action-key.test.ts` (27) and
  `tests/p6-c-action-cache.test.ts` (28) covering hit/miss lifecycle,
  every key component, symlink/protected/limits, locking, corruption,
  LRU, CAS primitives, gate evidence and failure fallback.

### Disabled / not implemented (documented)

- artifacts RESTORE is disabled (`ARTIFACT_RESTORE_ENABLED = false`) —
  CAS primitives exist and are tested, but no file is restored until
  restore passes its own security gate; artifacts-mode recipes always
  execute (metadata only).
- upstream keys use empty params; chained recipes with params stay
  uncached.

## [0.7.1] — P6-B: DeepSeek Stable Prefix Optimization

DeepSeek's prompt cache is a full-prefix cache, so the workbench now
formalizes and enforces a **stable prefix contract**: the system prompt,
tool metadata, registration order and per-mode tool matrices are static;
dynamic facts (time, git, run/gate ids, cache stats) are confined to the
allowed dynamic channels; same-mode drift is classified as
`UNEXPECTED_DRIFT` with a `driftSource` detail.

### Added

- **Stable-prefix contract** (`cache/stable-prefix.ts`): stable/dynamic
  zone constants, deterministic stable sorts (`stableSortStrings`,
  `sortedById/ByName/ByPath`), `modePrefixFingerprint` (system prompt +
  tool names/order/schema per mode), `stableResourcesHash` (skills,
  templates, gates, recipes, profiles, extensions), dynamic-value markers
  and `staticToolMetadataIssues` for tool metadata audits.
- **Static tool catalog** (`core/tool-catalog.ts`): `WORKBENCH_TOOL_NAMES`
  is the explicit registration-order constant; name/label/description/
  promptSnippet/promptGuidelines/parameters are centralized static
  metadata that `index.ts` spreads into `registerTool`.
- **`UNEXPECTED_DRIFT` classification**: same-mode system/tool drift now
  records `inferredInvalidationReason: "UNEXPECTED_DRIFT"` with
  `driftSource` (SYSTEM_PROMPT/TOOL_SET/TOOL_ORDER/TOOL_SCHEMA); the P6-A
  specific reasons are still recognized on old (1.0) records. Telemetry
  schema version bumped to 1.1.
- **Doctor/report extensions**: `/q-cache-doctor` shows
  `prefix_hashes` (systemPromptHash, activeToolNamesHash,
  activeToolOrderHash, activeToolSchemaHash), `same_mode_drift`,
  `expected_vs_unexpected`, `tool_metadata_static`, and churn now counts
  compaction; `/q-cache-report` gains the `same-mode mutat.` line.
- **Deterministic resource discovery**: gates sorted by id
  (`effectiveGates`), recipes sorted by name, profiles sorted by name,
  readdir results sorted; DEV mode preserves foreign tools in
  name-sorted order.
- **Docs**: `docs/cache/stable-prefix-contract.md`,
  `docs/cache/deepseek-cache-limitations.md`,
  `docs/cache/cache-efficient-workflow.md`; telemetry and provider docs
  updated for schema 1.1.

### Changed

- Tool metadata is now spread from the catalog (behavior-identical
  strings).
- P6-A telemetry tests updated for the 1.1 schema and
  `UNEXPECTED_DRIFT`/`driftSource`.

## [0.7.0] — P6-A: DeepSeek Prompt Cache Telemetry and Baseline

Observability for the DeepSeek prompt cache: hash-only telemetry of
normalized usage and context fingerprints, inferred invalidation reasons,
per-project JSONL storage with rotation, three new commands, and a compact
footer segment. Observation only — no payload mutation, no TTL control, no
warm-up requests, no Recipe Action Cache.

### Added

- **Cache telemetry module** (`extensions/workbench-runtime/cache/`):
  `cache-types.ts` (schema + verified usage semantics), `canonical-hash.ts`
  (deterministic SHA-256 canonicalization), `prompt-fingerprint.ts`
  (system prompt / tool / payload digests — text never retained),
  `invalidation-classifier.ts` (14 inferred reasons, expected vs
  unexpected), `cache-telemetry.ts` (session observer + state entry),
  `cache-store.ts` (append-only JSONL, rotation, atomic reports, forbidden
  field refusal), `cache-report.ts` (aggregation + rendering),
  `cache-doctor.ts` (health checks).
- **Pi-native events**: `session_start` (state restore, reload/new
  classification), `model_select`, `thinking_level_select`,
  `before_provider_request` (read-only structural peek),
  `message_end` (assistant only), `session_before_compact`,
  `session_shutdown` (safe flush).
- **Usage mapping (verified against installed Pi 0.83.0)**: for
  `openai-completions` (deepseek) `usage.input` is the un-cached input
  (`prompt_cache_miss_tokens`), `usage.cacheRead` the hit portion;
  `cacheHitRatio = cacheRead / (input + cacheRead)`; `usage.cost.total` is
  the cost fact. Unknown api kinds degrade to `partial`/`unverified` and
  never guess a ratio.
- **Storage**: `<root>/.pi/workbench/cache/telemetry.jsonl` (5 MB limit,
  5 archives), `reports/` (atomic writes, sanitized names), user-only file
  modes, gitignored, opt-out via `project.yaml` `cache.telemetry: false`.
- **Commands**: `/q-cache-status`, `/q-cache-report [session|project]
  [--save <name>]`, `/q-cache-doctor [json]`; footer segment
  `CACHE 72% | read 184k | miss 71k` (or `CACHE N/A`).
- **Docs**: `docs/cache/deepseek-prompt-cache.md`,
  `docs/cache/cache-telemetry.md`, `docs/cache/cache-privacy.md`.

### Changed

- Version bumped to 0.7.0; `EXTENSION_VERSION` in cache-types.ts must stay
  in sync with package.json.
- `ProjectConfig` gains `cacheTelemetry` (project.yaml `cache.telemetry`).
- Command inventory grows from 15 to 18 (P5 inventory test updated);
  lifecycle-event inventory extended.

## [0.6.1] — MIT License and README Banner

### Added

- **MIT License**: `LICENSE` (Copyright (c) 2026 BurgerWang); `package.json`
  and the lockfile root entry now declare `"license": "MIT"` (was
  UNLICENSED).
- **Pixel-art README banner**: `assets/banner.svg` (586x243) — a
  deterministic 5x7 bitmap-font rendering of the title (every pixel is an
  SVG rect; no font/network dependencies) generated by
  `tools/make-banner.mjs`, which reads the version from `package.json` so
  the banner can never drift from the package version. The generator is
  byte-deterministic and a test regenerates it and byte-compares against
  the committed file.

### Changed

- Version bumped to 0.6.1.

## [0.6.0] — P5: Hardening, Compatibility, Documentation, and Release Readiness

Path protection, a token-based command guard, state recovery and
compaction supplements, compatibility documentation, and the final
release-readiness audit.

### Added

- **Protected-path policy** (`core/path-policy.ts`): default protected set
  `.env` / `.env.*` (except `.env.example` and `.env.template`, explicitly
  allowed), `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`,
  `credentials.*`, `secrets.*`, `exchange-keys.*`, `auth.json`, `.netrc`,
  `*.token`, keystores. Policy: `edit`/`write` on protected paths is blocked
  in ALL modes; `read`/`ls`/`find`/`grep` on protected paths is blocked in
  AUDIT/VERIFY and allowed in DEV; bash display-reads (`cat .env`, ...) are
  blocked in AUDIT/VERIFY (defense in depth). Basename matching,
  case-insensitive, `~`-aware — documented in docs/security.md.
- **Token-based command guard** (`core/command-guard.ts`): quote-aware shell
  scanner + 11 rules — `rm -rf /`, `rm -rf ~`/`$HOME`, `rm` of `.git`,
  `git reset --hard`, `git clean -fd`+, `git push -f`/`--force`
  (+`--force-with-lease`, any position), `git checkout -- .` / `git restore
  .`, `git remote` add/remove/set-url/rename, `git config --global/--system`
  writes (reads stay allowed), `sudo`, and
  `npm|yarn|pnpm|bun publish|unpublish` (`--dry-run` stays allowed).
  Quoted text, commit messages and branch names cannot false-positive;
  quoted destructive forms are still caught.
- **State recovery** (`core/compact.ts` + wiring): mode and key task state
  (task, phase, gates, last run, evidence paths, next step, do-not-retry)
  are persisted as Pi custom entries and restored on every `session_start`
  (covers `/new`, `/resume`, `/fork`, `/clone`, `/reload` and compaction;
  a fresh `/new` session falls back to DEV).
- **Compaction supplement**: on `session_before_compact` the workbench only
  SUPPLEMENTS Pi's own compaction — never cancels it, never replaces its
  summary — with a bounded (40 lines / 2.4 KB) redacted ASCII note
  (task, mode, gates, last run, evidence paths, next step, do-not-retry,
  repeated-failure warnings) persisted as a custom entry and delivered as a
  hidden (`display: false`) next-turn custom message. Run logs never enter
  the session context.
- **`/q-status`** now reports the active path policy and command guard.
- **Compatibility surface**: `compatibility/pi.json` (tested-environment
  matrix) and docs/ — `compatibility.md`, `architecture.md`, `security.md`,
  `project-onboarding.md`, `quant-research-profile.md`. Only actually tested
  versions are claimed: Pi 0.83.0, Node v24.13.0, npm 11.18.0, CachyOS
  Linux (kernel 7.1.5-1-cachyos), pi-tui 0.83.0, typebox 1.3.7.
- **Tests**: 259 total (P5 adds `p5-command-guard` — tokenizer/segment
  splitting, all 11 rules, false-positive battery; `p5-path-policy` —
  protected matching incl. `.env.example` allowlist, per-mode matrix;
  `p5-compact` — state sanitization/caps, do-not-retry tracking, bounded
  redacted notes; `p5-state-recovery` — real-extension wiring via stub API:
  session_start restore, /new fallback, supplement/dedupe/never-cancel;
  `p5-inventory` — direct-load smoke, exact 15-command/7-tool/7-prompt
  inventory, no naming conflicts; `p5-redact` — argv `key=value`
  credential-carrier redaction with word-boundary parsing).

### Changed

- `core/mode-policy.ts` now integrates the command guard and path policy
  into `checkToolCall`; the catastrophic-command section moved to
  `core/command-guard.ts` (same public names, token-based internals).
- README updated with the P5 protection model and docs pointers; version
  bumped to 0.6.0.

### Known limitations (P5)

- Path matching is basename-based (a directory named `credentials/` does not
  protect ordinary files inside it) and POSIX-oriented.
- The bash path check covers display readers (`cat`, `head`, ...); general
  bash parsing is not attempted — the structured tools are the enforcement
  point.
- `--dry-run` publishing is allowed by design; unpublishing is blocked.
- Full interactive TUI session automation remains out of scope (component
  tests + print/json smokes cover the surface).

## [0.5.0] — P4: Pi-native TUI Status, Run Reports, and Run Comparison

A P4-status line (footer slot via `ctx.ui.setStatus` — the Pi footer is
never replaced), an auto-hiding widget via `ctx.ui.setWidget`, `/q-report`
and `/q-compare` commands, a new `workbench_compare_runs` tool, and compact
`renderCall`/`renderResult` renderers for the five workbench tools.

### Added

- **Status bar** (`core/status.ts`): `WB:<MODE> | <profile> | <gate>:<status>
  | run:<id>` from the project config and persisted run records only;
  missing parts degrade to shorter lines; long profiles are width-fitted.
- **Widget** (`core/widget.ts`): shown only while a task is active, the
  latest gate run is not a PASS, or the user forced it on
  (`/q-widget on`); auto-clears otherwise; content is task, phase, gate,
  last run, blocking reason; plain ASCII, width-fitted; `widgetAction`
  returns `"noop"` without UI so print/json modes never touch TUI APIs.
- **Run reports** (`core/report.ts`): `/q-report latest | <run-id>` —
  manifest facts (recipe, profile, mode, duration, exit code, status, git,
  artifacts, log paths) plus per-gate statuses/failed checks for gate runs
  and the declared quant facts for runs with a quant-result artifact.
- **Run comparison** (`core/compare.ts`): `/q-compare <a> <b>` and
  `workbench_compare_runs` — generic deltas (exit code, duration, artifact
  additions/removals, gate delta, gate-run test counts, numeric deltas of
  shared JSON artifact snapshots) and quant deltas (benchmark, return,
  drawdown, turnover, cost impact, fold pass/fail, parameter changes) when
  both runs carry a valid quant-result artifact. Deltas are descriptive:
  a higher return is never automatically interpreted as a better strategy
  (neutrality note). Incompatible schemas (recipe vs gate, quant vs
  non-quant) are reported with notes, never silently.
- **Recipe-run JSON artifact snapshots** (`core/recipe-runner.ts`): declared
  JSON artifacts (<= 1MB) are copied into the run directory at run time, so
  later runs overwriting the same project file cannot corrupt earlier run
  records; the comparator and quant report read only run-attributed copies
  (live-file fallback only for pre-P4 runs).
- **Tool renderers** (`core/render.ts` pure line builders +
  `ui/tool-renderers.ts` TUI components): compact `renderCall`/`renderResult`
  for `workbench_project_inspect`, `workbench_run_recipe`,
  `workbench_run_gate`, `workbench_read_run` and `workbench_compare_runs`;
  expanded view adds recipe, duration, exit code, artifacts, failed checks
  and log paths; partial/streaming and error states are handled; renderers
  render the structured `details` payloads verbatim — they never re-read
  run files and never recompute business metrics; narrow terminals degrade
  via Pi's Text wrapping plus `fitToWidth` truncation; colors are an
  overlay on plain ASCII (readable without color, no emoji semantics).
- **Commands**: `/q-report latest | <run-id>`, `/q-compare <run-id-a>
  <run-id-b>`, `/q-widget on | off`.
- **Tool**: `workbench_compare_runs` (read-only; available in AUDIT too).
- **Tests**: 200 total (P4 adds `p4-status`, `p4-report`, `p4-compare`,
  `p4-render`) covering compact/expanded/partial renderers, missing fields,
  narrow widths, report latest, unknown runs, incompatible schemas, generic
  and quant comparisons, and the UI-disabled guard.

## [0.4.0] — P3: Gate Engine, Evidence Artifacts, and the Quant Research Validation Ladder

Gate enforcement (`gates.yaml` is no longer "reserved"), a built-in
validation ladder (base gates B0-B5 for every profile, quant gates Q0-Q5 for
quant-research profiles), evidence artifacts per gate run, the
quant-result.schema.json output contract, and the `/q-gate` command family
plus three new workbench tools.

### Added

- **Gate schema** (`core/gate-schema.ts`): gates and checks with
  `id`, `title`, `description`, `profiles`, `prerequisites`, `required`,
  `blocking`, `evidence`, `acceptance`; check kinds `config` (config parses
  cleanly), `recipe` (declared recipe runs; alternatives supported),
  `artifact` (a recipe run's persisted artifacts), `file` (path or any-of),
  `json` (field exists / equals / any-of-paths), `numeric` (finite number
  with min/max, incl. array `.length` paths), `manual` (explicit human
  evidence only), `schema` (quant-result contract validation). Strict
  parsing — broken gates.yaml aborts with a setup error, never silently
  drops checks.
- **Built-in gate catalog** (`core/gate-catalog.ts`): base gates B0-B5
  (project readiness, static quality, unit correctness, integration
  correctness, output contract, reproducibility/handoff) and quant gates
  Q0-Q5 (research contract, market data integrity, backtest semantics,
  experiment integrity, out-of-sample robustness, strategy reporting).
  Base gates load for every profile; quant gates load only for
  quant-research profiles. A project's gates.yaml replaces built-ins by id
  and can add new gates.
- **Gate engine** (`core/gate-engine.ts`): runs selectors (`<gate-id>`,
  comma lists, `base`, `quant`, `all`) in prerequisite order; prerequisite
  status resolves from the current run first, then the most recent
  persisted gate run; a non-PASS outcome of a blocking prerequisite BLOCKs
  dependents; a required check that is NOT_RUN can never pass a gate;
  warnings never upgrade status; numeric constraints are only evaluated
  against structured artifacts; manual evidence is only ever recorded as
  type `manual`. Path containment (lexical + realpath/symlink) applies to
  every evidence path. Each gate run persists
  `manifest.json`, `gates.json`, `evidence.json`, `summary.json`,
  `stdout.log`, `stderr.log`, `artifacts/` (copied evidence sources) under
  `.pi/workbench/runs/<run-id>/`.
- **Quant result contract** (`core/quant-result.ts` +
  `schemas/quant-result.schema.json`): the workbench never computes strategy
  metrics — it validates the project's declared output
  (`results/quant-result.json` by convention). Required fields:
  `schema_version`, `run_id`, `strategy_type`, `frequency`, `universe`,
  `data_range`, `split`, `benchmark`, `costs`, `metrics` (return,
  volatility, drawdown, turnover, exposure, benchmark_delta plus a
  risk-adjusted metric), `folds`, `parameters`, `artifacts`; optional
  `warnings`, `semantics`, and profile-specific optional fields for
  stock-selection (`universe.point_in_time`, `exposure`, `rebalance`) and
  market-timing (`regime`, `position_sizing`). Every number must be finite
  (`1e999` parses to Infinity and is rejected); every fold is recorded —
  failed folds are reported, never filtered.
- **Commands**: `/q-gate <gate-id|base|quant|all> [manual:<check-id>=<note>]`,
  `/q-gates`, `/q-gate-show <gate-id>`, `/q-evidence <run-id>`.
- **Tools**: `workbench_run_gate` (runs selectors, accepts manual evidence),
  `workbench_read_gate` (gate run record or gate definition + latest
  status), `workbench_list_gates` (available gates + latest status).
  AUDIT keeps read-only gate tools but hard-denies `workbench_run_gate`;
  VERIFY allows gate runs (they only execute declared recipes).
- **Templates**: per-profile `gates.yaml` now documents the enforced ladder
  and the override mechanism; `AGENTS.quant-research.md` documents the
  validation ladder and the quant output contract.
- **Tests** (`tests/gates.test.ts`, `tests/quant-result.test.ts`, updated
  `tests/mode-policy.test.ts`): gate dependency order, prerequisite FAIL →
  BLOCKED, required NOT_RUN never PASSes, missing artifacts, missing JSON
  fields, numeric constraints, non-numeric/NaN/Infinity values, quant gates
  loading only for quant profiles, generic not enforcing quant gates,
  failed folds not filtered, evidence path escapes (including symlinks),
  gate result persistence, independent run ids, recipe/artifact/manual/
  schema/config checks, yaml catalog overrides, and the quant-result
  contract validator.

### Changed

- `gates.yaml` is enforced (P2 kept it reserved); empty `gates: []` means
  "use the built-in catalog" so existing projects keep working.
- `mode-policy.ts` registers the three new workbench tools and hard-denies
  `workbench_run_gate` in AUDIT.
- Version bumped to 0.4.0.

### Known limitations (P3)

- The schema check supports the built-in `quant-result` schema only;
  project-defined JSON schemas are not yet loadable.
- Recipe-name conventions (`check:*`, `test:*`, `data:fetch`, `backtest`)
  are documented; projects that use different names should override the
  checks in gates.yaml.

## [0.3.0] — P2: Full Skills, Prompt Templates, and Project Templates

Complete general-development and quantitative-research skills, the full
`q-*` prompt template set, and project templates (AGENTS + per-profile
configs) written by `/q-init`.

### Added

- **General-development skills (7)**: `repository-orientation` and
  `implementation-workflow` completed; `validation-ladder` completed;
  new `repository-audit`, `debugging-workflow`, `cli-product-development`,
  `handoff-and-release`. Every skill is a focused `SKILL.md` plus detailed
  checklists in `references/*.md` (progressive disclosure, no content
  duplication across skills).
- **Quantitative-research skills (7)**: `quant-research-design`,
  `market-data-integrity`, `stock-selection-research`, `market-timing-research`,
  `backtest-integrity`, `experiment-validation`, `strategy-reporting`.
  Coverage per spec: selection (point-in-time universe, survivorship,
  delisting, corporate actions, cross-sectional features, ranking/grouping,
  industry and market-cap exposure, rebalance, portfolio construction,
  turnover, benchmark, attribution); timing (signal generation vs tradable
  time, entry/exit, position sizing, market state, time-series splits,
  benchmark, regime performance, parameter stability, walk-forward);
  backtest integrity (future leakage, look-ahead bias, signal/execution
  alignment, adjustments, suspensions, delisting, fees, slippage, cash and
  positions, benchmark alignment, return computation, rebalance semantics).
  Out of scope explicitly: order book, tick replay, queue models, market
  making, colocation, microsecond latency, exchange execution engines.
  Skills are language-neutral (no python-only assumptions), vendor- and
  exchange-agnostic, and treat statistical conventions as conventions —
  only correctness properties are stated as rules.
- **Prompt templates (7)**: `q-audit` (evidence-first, confirmed / probable /
  unknown classification), `q-plan` (phased plan with a verifiable Gate per
  phase, no code changes), `q-build` (real implementation, tests in sync, no
  stubs/TODOs), `q-debug` (reproduce first, preserve original error, fix
  root cause, regression verify), `q-verify` (no source changes, declared
  recipes/gates, PASS/FAIL/BLOCKED/NOT_RUN), `q-optimize` (engineering
  optimization or selection/timing parameter experiments; no parameter
  chasing without out-of-sample validation; full trial reporting, never
  best-trial-only), `q-review` (diff/commit/implementation review: logic,
  tests, compatibility, omissions). All templates support `argument-hint`
  and `$ARGUMENTS`; none collide with extension command names.
- **Project templates** (`templates/project/`): `AGENTS.generic.md`,
  `AGENTS.quant-research.md`, plus per-profile config sets (`generic/`,
  `stock-selection/`, `market-timing/`) — the single source of truth loaded
  by the `/q-init` service. `/q-init` now also writes an `AGENTS.md` at the
  project root, selected by profile; an existing `AGENTS.md` is never
  overwritten by default (per-file confirmation required, consistent with
  the config files).
- **Package-content tests** (`tests/package-content.test.ts`): every skill
  directory has `SKILL.md`; frontmatter parses; names legal and matching
  their directories; descriptions present; prompts parse with description +
  `argument-hint` + `$ARGUMENTS`; no filename collisions and no collision
  with extension commands; every `skill:name` reference in prompts and
  AGENTS templates resolves; no empty or TODO-only skills; the package
  manifest discovers all 14 skills and 7 prompts; quant topic-coverage
  assertions per skill; language/vendor neutrality checks.

### Changed

- `templates.ts` now loads template files from `templates/project/` on disk
  (`getInitTemplate` is async) — templates are real files, not generated
  strings, and the AGENTS content is selected per profile.
- `init.ts` plans an `AGENTS.md` entry at the project root in addition to
  the four config files; `applyInit` writes the profile-selected AGENTS
  template; the plan display marks `AGENTS.md (project root)`.
- README updated with the full skill/prompt tables, project-template
  layout, and P2 roadmap.

### Known limitations (P2)

- `gates.yaml` is parsed but not yet enforced (gate engine is a later
  milestone).
- The quant recipe placeholders in project templates assume script entry
  points (`scripts/*.py`); the skills and AGENTS templates themselves are
  language-neutral.

## [0.2.0] — P1: Project Configuration and Controlled Recipe Runner

Project configuration, `/q-init`, declarative recipes, a controlled Recipe
Runner, run records with redaction, output truncation, and VERIFY without free
bash.

### Added

- **Project configuration** (`core/config.ts`):
  - Config under `<project-root>/<CONFIG_DIR_NAME>/workbench/` using Pi's
    official `CONFIG_DIR_NAME` export (never hardcoded): `project.yaml`,
    `recipes.yaml`, `gates.yaml` (parsed, reserved), `profiles.yaml` (parsed,
    reserved).
  - Project root via `git rev-parse --show-toplevel` with `ctx.cwd` fallback.
  - Trust gate: `ctx.isProjectTrusted()` is required before any config is read
    or executed; untrusted projects are refused.
  - Invalid YAML and schema violations are reported as config issues, never
    thrown away silently.
- **`/q-init` command**: profiles `generic`, `quant-research/stock-selection`,
  `quant-research/market-timing`. Displays files before writing; existing files
  are never overwritten by default; overwrites require per-file confirmation;
  `hft`/`market-making`/`lob`/`execution-engine` rejected by design.
- **Declarative Recipe Schema** (`core/recipe-schema.ts`): strict validation
  (argv-only commands, unknown-field rejection, type-checked params),
  `{{param}}` substitution into argv, defaults aligned with Pi's truncation
  constants.
- **Recipe Runner** (`core/recipe-runner.ts`): single service behind the tools
  and commands — mode gating via `allowed_modes`, timeout + AbortSignal
  forwarding, exit-code policy, `shell=false` argv execution via `pi.exec`,
  lexical + realpath containment for `cwd`/`writes`/`artifacts`
  (`core/path-guard.ts`), env allow-list, artifact glob collection.
- **Run records** (`core/runs.ts`): `runs/<run-id>/` with `manifest.json`,
  `command.json`, `environment.json`, `stdout.log`, `stderr.log`,
  `summary.json`; secret redaction (`core/redact.ts`) on every artifact;
  git commit/dirty captured.
- **Output truncation**: Pi's official `truncateHead`/`truncateTail` with
  `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES`; full logs always on disk; returned
  summaries always cite full log paths.
- **Custom tools**: `workbench_project_inspect`, `workbench_run_recipe`,
  `workbench_read_run` (bounded log tails, never full large logs inline).
- **Commands**: `/q-run <recipe> [k=v ...]`, `/q-runs [limit]`,
  `/q-run-show <run-id>` — same services as the tools, no duplicated logic.
- **Mode redefinition (P1)**: VERIFY no longer allows free `bash` — its tool
  set is read/grep/find/ls + all `workbench_*` tools, with `bash`/`edit`/`write`
  hard-denied at the `tool_call` guard. AUDIT hard-denies
  `workbench_run_recipe` as well. DEV keeps all built-in dev tools plus
  `workbench_*` tools.
- **Runtime dependency**: `yaml` (formal `dependencies`, not peer).
- **Tests**: 82 tests across `mode-policy`, `config`, `recipe-schema`,
  `path-guard`, `recipe-runner`, `init`, `templates`.

### Changed

- `tests/mode-policy.test.ts` assertions for VERIFY (no bash) and the
  workbench tool sets were updated to the P1 semantics defined by the P1 spec
  (the P0 VERIFY-with-bash behavior was deliberately redefined; no P0 tests
  were deleted).
- README updated with the P1 mode model, `/q-init`, recipe config examples,
  local package install, project trust flow, and the no-sandbox security model.

### Known limitations (P1)

- `gates.yaml` is parsed but not yet enforced (gate engine is a later
  milestone).
- Recipe restrictions are discipline/guardrails, not an OS sandbox — a recipe
  runs with the user's full permissions (see README Security model).
- Run records are retained indefinitely; no retention/GC policy yet.

## [0.1.0] — P0 Bootstrap

Initial release. Minimal, loadable, verifiable baseline built purely on Pi native mechanisms.

### Added

- **Pi package manifest** (`package.json` `pi` key) declaring `./extensions`, `./skills`, `./prompts`.
- **Workbench Runtime extension** (`extensions/workbench-runtime/`):
  - Native commands `/q-mode-audit`, `/q-mode-dev`, `/q-mode-verify`, `/q-status`.
  - Mode policy core (`core/mode-policy.ts`): AUDIT / DEV / VERIFY tool sets,
    hard `tool_call` guard, catastrophic-command blocking (`rm -rf /`,
    `git reset --hard`, `git clean -fd`/`-fdx`, `git push --force`/`-f`).
  - State persistence (`core/state.ts`) via Pi custom session entry
    `workbench-mode`; restored on `session_start`; default DEV.
  - TUI status `WB:AUDIT` / `WB:DEV` / `WB:VERIFY`; safe degradation in
    print/json modes.
- **Skills**: `repository-orientation`, `implementation-workflow`, `validation-ladder`.
- **Prompt templates**: `/q-audit`, `/q-build`, `/q-verify`.
- **Tests**: `tests/mode-policy.test.ts` covering tool sets, guard behavior,
  catastrophic/safe command classification, and state restore fallback.

### Known limitations (P0)

- VERIFY still allows free `bash` and is **not** a final security mode; P1 replaces
  it with a declarative Recipe Runner.
- No `workbench_*` custom tools, no Recipe Runner, no Gate Engine, no quant
  profiles, no complex TUI yet.
