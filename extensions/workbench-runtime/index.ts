/**
 * pi-dev-workbench — Workbench Runtime extension (P1: Project Configuration
 * and Controlled Recipe Runner; P3: Gate Engine, Evidence Artifacts and the
 * Quant Research Validation Ladder; P4: Pi-native TUI status, run reports,
 * run comparison and compact tool renderers; P5: path protection, command
 * protection, state recovery and compaction supplements, compatibility
 * hardening).
 *
 * P5 additions:
 *   - protected-path policy (core/path-policy.ts): credential files are
 *     never modified (edit/write blocked in all modes) and never read in
 *     AUDIT/VERIFY; read in DEV is allowed. .env.example/.env.template are
 *     explicitly allowed.
 *   - token-based command guard (core/command-guard.ts): rm -rf / or ~,
 *     rm of .git, git reset --hard, git clean -fd, git push --force,
 *     git checkout -- . / git restore ., git remote mutations,
 *     git config --global writes, sudo, package publish — parsed, with
 *     quote-awareness so harmless commands never false-positive.
 *   - state recovery + compaction supplements (core/compact.ts): mode and
 *     key task state are persisted as Pi custom entries, restored on
 *     session_start (covers /resume /fork /clone /reload; an ordinary /new
 *     starts a fresh/DEV session that copies nothing); on
 *     session_before_compact a bounded ASCII note (task, mode, gates, runs,
 *     evidence paths, next step, do-not-retry) is persisted and injected as
 *     a hidden custom message. Pi compaction itself is never cancelled or
 *     reimplemented, and no run logs ever enter the session context.
 *   - milestone handoff (core/milestone-handoff.ts, user-only):
 *     /q-milestone-handoff <next step> is the ONLY path that carries
 *     workbench state into a fresh session — it waits for idle, parses and
 *     bounds the explicit next step (empty/overlong rejected up front),
 *     redacts it against the collected env secrets and re-caps it
 *     (code-point/UTF-8 safe), then persists a bounded/redacted schema-v1
 *     `prepared` milestone record (workbench-milestone-handoff) in the
 *     source session — every record string (milestone id, next step,
 *     session pointer, timestamp) is bounded/redacted by prepare and the
 *     SAME normalized next step is stored in `record.next_step` and the
 *     copied `state.nextStep` (a stale/undefined snapshot nextStep never
 *     reaches the record or the target) — then starts a fresh
 *     parent-linked session whose setup appends a `resumed` record, a
 *     hidden pointer-only note (display:false, workbench-milestone-handoff-
 *     note; never the absolute source session path — only the fixed
 *     parent-linked fact, the pointer stays outside model context) and
 *     copies of the mode / bounded compact state / delegation
 *     state — NEVER the commander write lease (the target write authority
 *     stays locked even if the source held an active/pending lease).
 *     session_start(new) fires BEFORE setup, so the replacement reloads
 *     (withSession → replacementCtx.reload()) to restore the setup entries;
 *     no model/provider call and no agent turn; a cancelled replacement
 *     records an additive `cancelled` record in the source. Loading is
 *     fail-closed (unknown schema/malformed records ignored, legacy entries
 *     untouched, no migration/rewrite) and prepare can never build a
 *     record its own fail-closed loader rejects.
 *
 * P6-A additions (DeepSeek prompt-cache telemetry — observability only):
 *   - hash-only telemetry of usage, context fingerprints and inferred cache
 *     invalidations (cache/ directory); records go to
 *     <root>/<CONFIG_DIR_NAME>/workbench/cache/telemetry.jsonl (append-only,
 *     rotated, privacy-filtered — no prompt/message/tool/schema text, no
 *     secrets, no full session ids)
 *   - Pi-native events only: session_start, model_select,
 *     thinking_level_select, before_provider_request (read-only structural
 *     peek — payload/headers never mutated), message_end (assistant only),
 *     session_before_compact, session_shutdown (safe flush)
 *   - usage facts come from Pi's normalized assistant usage; usage.cost.total
 *     is the actual cost fact source; cacheHitRatio is computed only for api
 *     kinds whose semantics are verified in the installed Pi source
 *   - /q-cache-status /q-cache-report [session|project] [--save <name>]
 *     /q-cache-doctor; compact CACHE segment in the footer status
 *   - telemetry never blocks or modifies model requests; opt-out via
 *     project.yaml cache.telemetry: false. No Recipe Action Cache yet.
 *
 * P6-C additions (Deterministic Recipe Action Cache — opt-in, disabled by
 * default):
 *   - actionKey -> execution result metadata for DECLARED recipes only;
 *     never model answers/patches/audit conclusions/arbitrary bash
 *   - full action key: schema/policy/package versions, recipe definition
 *     hash, cache policy hash, argv hash, relative cwd, mode, declared env
 *     hashes, toolchain versions, OS/arch, lockfile hashes, declared-input
 *     Merkle hash, workbench config hash, profile hash, gate schema hash,
 *     upstream action keys — never git commit/branch/mtime/dirty state
 *   - input fingerprinting: content SHA-256 (streaming, bounded), dirs via
 *     recursive Merkle, symlinks resolved with escape refusal, protected
 *     secret paths never read, missing patterns and glob no-match are key
 *     components
 *   - hit lifecycle: new run manifest with executionSource: cache,
 *     actionKey, reusedFromRunId, cacheCreatedAt, cacheValidatedAt,
 *     exitCode, evidencePaths, artifactValidation; gates still only see
 *     PASS/FAIL/BLOCKED/NOT_RUN and re-validate every run record
 *   - /q-run <recipe> [--no-cache|--refresh-cache]; /q-cache-explain
 *     /q-cache-prune [--apply] /q-cache-clear <recipe|all>
 *   - cache failures degrade to normal execution; artifacts restore stays
 *     disabled until it passes its own security gate
 *
 * P6-D additions (Quant Research Cache Contracts):
 *   - three versioned manifest contracts (cache/quant-contracts.ts):
 *     DATA_SNAPSHOT, FEATURE_SET, BACKTEST_RESULT — the workbench only
 *     defines, validates and connects the contracts; it never downloads
 *     data, computes features or runs a backtest engine
 *   - immutable-reference discipline: latest/current/now/today can never
 *     be a final manifest id or cache key; logical references resolve to
 *     an immutable manifest (registry-based) or the quant cache is refused
 *   - recipe cache `domain: quant` + `quantContract: {type, manifest}`:
 *     manifest must exist, schema-valid and immutable; the resolved
 *     immutable key joins the action key; result artifact hash mismatch on
 *     a hit is CORRUPTION; manifest warnings are preserved verbatim;
 *     failed folds are never filtered; walk-forward with empty folds is
 *     never validated; best-trial-only caching is never valid
 *   - gate schema checks for the three contracts (data-snapshot,
 *     feature-set, backtest-result) — cache hits never bypass Q0-Q5
 *   - /q-cache-validate <manifest-path>; /q-cache-lineage <run-id|action-key>
 *     (never reads data files into the model context)
 *
 * Unreleased additions (split session-cost observability):
 *   - pure defensive cost-breakdown module (core/cost-breakdown.ts) that
 *     mirrors Pi's default footer aggregation over session entries:
 *     assistant usage => commander bucket (grouped per
 *     provider/responseModel-or-model), toolResult usage with toolName
 *     workbench_delegate_worker => worker bucket, other toolResult usage
 *     and branch_summary/compaction usage => other bucket; malformed /
 *     non-finite / negative values contribute zero; total is exactly the
 *     bucket sum
 *   - compact deterministic status segment COST S:$… W:$… O:$… (O omitted
 *     when zero, S and W always shown) appended via the existing
 *     ctx.ui.setStatus flow — the Pi footer is never replaced
 *   - status refresh after assistant/tool-result message_end; the pending
 *     message is included exactly once so COST/CACHE update immediately
 *     despite Pi 0.83 persisting messages after extension handlers
 *   - /q-cost-status prints exact commander/worker/other/total and the
 *     per-model commander breakdown from ctx.sessionManager.getEntries()
 *     in TUI and print/json modes
 *
 * Native read v3 and NRO search additions:
 *   - three fixed same-name overrides of the Pi built-in read/grep/find
 *     tools, registered statically in the fixed read → grep → find order
 *     BEFORE the 11 workbench catalog tools (the registration surface is
 *     exactly NATIVE_OVERRIDE_NAMES + WORKBENCH_TOOL_NAMES); the override
 *     metadata is static: read adds exactly the ONE §6.4 continuation/count
 *     guideline bullet (N1), grep mirrors the same bullet and appends the
 *     static count-mode sentence to its description (N2), find keeps the
 *     built-in metadata verbatim (N3 not implemented)
 *   - read v3: offset, limit and cursor all use one same-handle streaming
 *     pager. Text is quoted in a trusted protocol capped at 12,288 bytes,
 *     240 file lines and 252 total lines; strict cursors bind normalized path,
 *     file snapshot, byte offset and line number. Long lines use segment
 *     cursors. A bounded prefix sniff delegates images to Pi's attachment
 *     pipeline without passing text through Pi's legacy full-read path.
 *   - N2 grep count: the parameter schema appends exactly the two optional
 *     selectors `output` (matches|count) and `count_kind` (matches|lines)
 *     after the byte-identical legacy property prefix; output=count runs a
 *     dedicated abort-aware Pi-free adapter (core/native-search-adapter.ts)
 *     over the installed rg — ONE compact exact uncapped
 *     `count kind=<matches|lines> value=<n> files=<n>` line with details
 *     undefined, legacy limit/context never applied, zero is an exact
 *     result, missing paths fail with the built-in text and a pre-abort
 *     rejects `Operation aborted`; output omitted or "matches" (and a
 *     count_kind present while output is omitted) delegates byte-for-byte
 *     to the built-in definition — the new selectors never reach it
 *   - N3 find (count/max_depth) is NOT implemented: find remains an exact
 *     legacy pass-through — schema, metadata and execute delegate to the
 *     built-in definition byte-for-byte
 *   - the overrides perform no writes, no pi.exec, no shell and no model
 *     calls; the exact-name tool_call guard, MODE_TOOLS/write-authority
 *     inventories and WORKBENCH_TOOL_NAMES are unchanged
 *
 * P0/P1 additions (commander-token-optimization plan, slice A — additive):
 *   - P0 observability in core/cost-breakdown.ts: exact commander
 *     assistant-request count, compaction count, and deterministic
 *     per-tool inline TEXT UTF-8 byte attribution over session toolResult
 *     entries (grouped by toolName, stable ordering, counts, total;
 *     malformed/non-text content contributes zero and never throws;
 *     descriptive only — never claims causal token savings);
 *     /q-cost-status renders these facts compactly with bounded per-tool
 *     rows, never rendering tool arguments or result text; the existing
 *     commander/worker/other cost + token semantics are byte-for-byte
 *     unchanged
 *   - P1 bounded parent-result summaries (core/result-summary.ts, pure):
 *     workbench_run_recipe, /q-run, workbench_run_gate and /q-gate now
 *     emit success summaries <= 4096 UTF-8 bytes / 40 lines (status/exit,
 *     duration, artifacts, cache, log paths, recognized Node TAP totals,
 *     warning/anomaly facts, explicit omission facts — never raw
 *     stdout/stderr, never per-test success lines) and failure summaries
 *     <= 12288 UTF-8 bytes / 120 lines under the fixed precedence
 *     (status/exit+command, failing tests, first root cause, timeout/
 *     cancelled, warning count, full log paths, omission facts; bounded
 *     excerpts only after required facts). Warning counts surface even on
 *     exit 0; clean non-empty stderr is an explicit anomaly fact. Gate
 *     summaries keep failing/blocked gate ids + reasons before passing
 *     gates and always name the full record path. Full logs/records are
 *     persisted exactly as before; summaries are presentation only and
 *     never acceptance evidence. recipe/gate tool schemas, structured
 *     details, run records and cache behavior are unchanged.
 *
 * Commander Slice B1 additions (commander-token-optimization plan,
 * P2 layered run results + P3 read-only batching guideline — additive):
 *   - layered workbench_read_run presentation (core/run-result.ts, pure):
 *     the omitted `include` now resolves to `summary` and renders the
 *     ordered Summary/Evidence/Persisted layers <= 4096 UTF-8 bytes / 40
 *     lines (custom caps clamped to documented safe bounds), sanitized
 *     and code-point safe, NEVER inlining raw stdout/stderr, per-test
 *     lines, or argv, with durable project-relative run-dir/manifest/
 *     summary/stdout/stderr paths; explicit `manifest` adds bounded
 *     cwd/argv metadata without tails; explicit `logs`/`all` append only
 *     the existing caller-bounded log tails; structured details and disk
 *     records are unchanged (legacy records render identically)
 *   - deterministic read-only batching classifier
 *     (INDEPENDENT_READ_ONLY_ALLOWLIST in core/run-result.ts): exactly
 *     read/grep/find/ls + workbench_project_inspect/read_run/read_gate/
 *     list_gates/compare_runs — execution, review, delegation and write
 *     tools (incl. workbench_delegation_status) are never classified, and
 *     the classifier never infers independence; the single static prompt
 *     guideline in core/tool-catalog.ts mirrors the allowlist (batch 2+
 *     known-independent read-only calls in one host parallel turn;
 *     dependent calls, writes, delegations, reviews and final
 *     recipe/gate execution stay sequential). No tool/order/mode change.
 *
 * Commander Slice B2 additions (commander-token-optimization plan,
 * P2 coverage-gated segmented actual-diff review — additive):
 *   - displayed-path coverage facts on review records
 *     (core/diff-review.ts): displayed_paths / remaining_paths /
 *     coverage_complete / review_path — a path is displayed only when it
 *     appears in an actually rendered patch entry (globally omitted paths
 *     never count; bounded/per-path-truncated entries count as that
 *     path's bounded evidence segment); prior displayed coverage merges
 *     ONLY from the persisted review.json with the SAME bound_diff_hash
 *     and valid worker-path membership (legacy schema_version-1 records
 *     infer prior coverage ONLY from their persisted patch entries); a
 *     hash change resets coverage (only prior-hash coverage is dropped —
 *     this call's actually rendered paths stay displayed under the new
 *     hash). Every review segment still
 *     scope-checks EVERY worker path and binds the complete current diff
 *     hash — include_paths narrows only the rendered patch; defaults 400
 *     lines / 32 KiB, max 50 include_paths, redaction and the worker
 *     scope are unchanged
 *   - workbench_review_worker_diff is callable repeatedly on the latest
 *     delegation (PENDING_REVIEW / STALE / REVIEWED): every call re-runs
 *     the real git facts/scope/hash; a same-hash complete PASS rerender
 *     keeps the valid REVIEWED binding, a changed hash resets coverage
 *     (PASS stays blocking until fresh coverage is complete), and ANY
 *     re-review that is not PASS with complete coverage (a scope FAIL or
 *     an incomplete PASS — e.g. a legacy partial review record)
 *     invalidates a prior same-hash REVIEWED state fail-closed
 *     via the pure demoteReviewedToPending transition
 *     (core/delegation-state.ts — REVIEWED → PENDING_REVIEW, reviewed
 *     hash cleared; pending/stale stay safely blocking)
 *   - deterministic rendered coverage counts, bounded next include_paths
 *     guidance (max 50 paths / ≤ 1024 UTF-8 bytes, complete paths only
 *     with an exact omitted count), the review-complete fact and the
 *     durable project-relative review.json path; details expose
 *     review_record + coverage facts; no caller/prose acknowledgement
 *     API; no tool/order/mode/schema change; review writes stay
 *     review.json + the existing state entry only
 *
 * P7 additions (Worker-first write authority + delegation ledger, slice 2):
 *   - strict Sol DEV tool matrix (core/write-authority.ts wired): the
 *     approved GPT-5.6 Sol commander gets exactly the fixed
 *     STRICT_SOL_DEV_ALLOWLIST in DEV (no bash/edit/write, no foreign
 *     tools); delegated workers and other controllers keep the existing
 *     DEV behavior before role filtering; AUDIT/VERIFY stay strict
 *   - second-layer commander guard in the tool_call handler: bash is
 *     always blocked for strict Sol; edit/write require a valid user-issued
 *     temporary write lease (restored/revoked via custom entries); every
 *     tool outside the allowlist is blocked despite re-enable; blocked
 *     write attempts are counted in the delegation state
 *   - delegation ledger (core/delegation-ledger.ts): each worker attempt
 *     writes <CONFIG_DIR_NAME>/workbench/delegations/<id>/ with
 *     manifest.json, before.json, after.json, worker-summary.json (and the
 *     review service adds review.json) — bounded, atomic, redacted, no
 *     transcripts/secrets; git facts come from argv-only exec calls; the
 *     ledger's own directory never counts as a project change
 *   - review lifecycle (core/delegation-state.ts wired): every delegation
 *     starts PENDING_REVIEW (even on failure — no fallback); a pending or
 *     stale review blocks the next delegation AND VERIFY; the review tool
 *     (core/diff-review.ts) checks the real diff against allowed_paths
 *     (include_paths narrows only the patch), binds the reviewed hash, and
 *     any later diff change turns the delegation STALE
 *   - bounded worker handoff (worker/handoff.ts + worker/context-
 *     diagnostics.ts): the complete final worker text is persisted as the
 *     redacted ≤512 KiB worker-report.md (mode 0600, atomic, UTF-8-safe,
 *     explicit truncation marker) plus bounded worker-summary.json /
 *     usage.json under the delegation directory on EVERY outcome; the
 *     parent toolResult is a strictly bounded summary (≤120 lines / 12
 *     KiB) that NEVER concatenates result.output/report/patch/test logs;
 *     progress exposes only turns/provider/model (never text); pure
 *     estimateLatestTurnTokens / detectSingleHugeRecentTurn /
 *     compactablePrefixAvailable diagnostics flag the single-huge-recent-
 *     turn shape via the exact `CONTEXT RISK: latest delegation handoff
 *     too large` line in /q-status and /q-delegation-status (Pi compaction
 *     is never reimplemented); diff review defaults are 400 lines / 32 KiB
 *     enforced globally over the rendered patch with per-path stats and a
 *     segmented include_paths review instruction
 *   - workbench_review_worker_diff / workbench_delegation_status tools and
 *     /q-delegation-status; footer appends WF:LEASE <used>/<max> (active
 *     confirmed lease), WF:LOCKED (locked/pending/expired/exhausted/
 *     revoked) or WF:REVIEW (review outstanding — appended independently)
 *   - P7 slice 3 (user-only lease commands): /q-write-policy status,
 *     /q-commander-write-unlock <reason> --paths ... --calls ... --minutes
 *     ... and /q-commander-write-lock — unlock is Sol+DEV+strict only;
 *     /q-write-policy accepts EXACTLY the trimmed `status` subcommand
 *     (anything else prints usage and alters no state); the human inline
 *     confirmation is TUI-only (branch on ctx.mode === "tui" — RPC/
 *     print/json are non-TUI and always use the pending two-part token
 *     flow even though RPC contexts carry hasUI); TUI requires an
 *     explicit human confirmation (cancel leaves locked); non-TUI issues
 *     a PENDING lease that visibly emits two distinct bounded token parts
 *     and confirms on a second same-command invocation with both exact
 *     parts (tokens never enter status/compact summaries); lock revokes
 *     and persists the audit facts; an ACTIVE confirmed lease enables
 *     exactly its edit/write tools on top of the canonical 15-tool
 *     allowlist (lease-added tools are canonical, deduplicated edit then
 *     write), and exhaustion/expiry/revocation restores the exact 15
 *     (bash stays hard-blocked; the second-layer guard stays
 *     authoritative); lease-lock synchronization is LAZY — before each
 *     agent turn and inside the command/tool guards and the status
 *     refresh, a lease that is no longer ACTIVE reverts the advertised
 *     set to the exact canonical 15 (no timers, no background resources)
 *
 *   - Phase 2 of the worker token-budget repair (docs/plans/worker-token-
 *     budget-repair.md): the runner accumulates the pure cumulative spend
 *     policy (core/worker-spend.ts) after every assistant message, records
 *     final profile/state/band/reasons facts on the run result, and
 *     terminates fail-closed on any hard spend dimension; the worker-role
 *     lifecycle reads the spend profile from the fixed
 *     WORKBENCH_WORKER_SPEND_PROFILE child env contract (malformed/missing
 *     falls back to standard) and sends exactly one hidden cumulative soft
 *     steer (its own flag, independent of the context steer)
 *   - Phase 3 of the same repair: the optional public `budget_profile`
 *     parameter (closed literal union low|standard|extended, default
 *     standard) is resolved by the pure contract validation in
 *     core/worker-policy.ts BEFORE ledger creation/child launch and the
 *     resolved profile is passed consistently into the ledger contract
 *     (before.json contract.budget_profile) and runDeepseekWorker (spend
 *     facts preserved on every outcome, exception fallback included); the
 *     canonical cumulative `spend` object is persisted additively in
 *     usage.json and worker-summary.json (schema_version stays 1;
 *     pre-repair records read without migration) and the bounded parent
 *     handoff renders the deterministic spend summary line plus nested
 *     spend details from the SAME persisted worker-summary spend object
 *   - Phase 4 of the same repair (numeric-only progress): WorkerProgress
 *     carries the cumulative spend counters (turns / totalTokens /
 *     outputTokens) and the fixed ok|soft|hard band after every processed
 *     assistant message — never worker text, reasons, tool arguments,
 *     patches, logs, or error prose — and the starting/running onUpdate
 *     keeps the exact `DeepSeek worker: N turn(s), model provider/model`
 *     text prefix, appends the deterministic spend segment
 *     (`| spend total X | output Y | band B`) and adds only the bounded
 *     numeric counters and fixed band to the details
 *
 * P7 commander advisory (commander-token-optimization plan §6 P7 —
 * observation-only, no hard stop):
 *   - pure core/commander-advisory.ts evaluates the five cumulative
 *     dimensions (requests, gross_tokens, output_tokens, tool_text_bytes,
 *     compactions — fixed order, inclusive >= boundaries, HIGH-over-soft
 *     precedence) over the SAME current session breakdown as the COST
 *     segment (pending-message-aware with the existing dedup semantics);
 *     documented defaults soft 200 / 25M / 125k / 3.5M / 5 and high
 *     300 / 40M / 200k / 5M / 8
 *   - optional trusted project.yaml commander.advisory.soft/high overrides
 *     (positive safe integers, high > soft per dimension); invalid values,
 *     unknown keys and ordering violations become bounded project.yaml
 *     ConfigIssue records and fall back to the documented defaults —
 *     malformed config never disables observability and never throws
 *   - presentation ONLY: the footer appends CMD:SOFT / CMD:HIGH when
 *     triggered (OK adds no segment) and /q-cost-status renders the
 *     deterministic bounded advisory facts (current values, thresholds,
 *     band, reasons) with trusted config best-effort or defaults (never
 *     trust-gated); no steering message, no cancel/terminate, no tool/
 *     mode/write-authority change, no workflow blocking, no hard-stop path
 *
 * P8 additions (safe nested project support):
 *   - optional project.yaml `project_dir` (default "."): after config load
 *     the safe effective project root is resolved — POSIX/Windows absolute
 *     paths, `..` escapes and symlink escapes are rejected, the target
 *     must exist and be a directory; violations become project.yaml
 *     ConfigIssues and fall back to the repository root (config stays
 *     inspectable, nothing outside the repository is ever read)
 *   - stack detection reads only the effective project root's top level;
 *     git and config-files-present stay repository-root based
 *   - gate file/json/numeric/schema checks resolve relative to the
 *     effective project root with realpath containment; gate config, run
 *     persistence, recipe checks/execution, artifact run records and git
 *     stay repository-root based (recipe cwd semantics unchanged)
 *   - workbench_project_inspect and its renderer show the effective root
 *
 * P4b additions (current-state reuse assessment for workbench_read_run):
 *   - core/validation-assessment.ts assesses the persisted P4a validation
 *     evidence of a read run against the CURRENT trusted project/runtime
 *     state and renders exactly one explicit status (REUSABLE or
 *     RERUN_REQUIRED with fixed reason codes) in every include mode and
 *     the additive details.validation field — observation only, it never
 *     skips recipe/gate execution and is never acceptance evidence
 *   - recipe targets are rebuilt from the CURRENTLY DECLARED recipe plus
 *     the persisted privacy-safe invocation identity, cross-checked
 *     against the manifest's argv_hash (valid 64-hex, exactly equal;
 *     raw argv is never used or exposed); gate targets are reconstructed
 *     from the CURRENT effective catalog plus the strictly validated
 *     persisted gates.json/evidence.json artifacts (foreign schema
 *     versions, contradictory identity facts and malformed/extra source
 *     evidence fail closed via readPersistedGateRunFacts)
 *   - the read path is STRICTLY read-only: no persistence/session
 *     append, no in-memory delegation-state mutation (the worker-first
 *     facts come from the read-only projection), no run-artifact writes,
 *     no P6-C action-cache contact; gate execution keeps its existing
 *     mutating refresh semantics
 *
 * P8b additions (two-phase tool-result receipt lifecycle wiring):
 *   - the reviewed P8a receipt core is wired into Pi's native tool
 *     lifecycle: at the END of the `tool_call` guard (after every
 *     worker/commander/mode/path/lease check has allowed) every registered
 *     workbench tool EXCEPT the public recovery tool begins an exclusive
 *     started receipt (native Pi session id + event.toolCallId + exact
 *     tool name + canonical input hash; effective project root resolved
 *     like each tool's own execute); BEGIN completes before the tool
 *     executes; a matching completed replay and every incomplete/corrupt/
 *     conflict/invalid/storage outcome block fail-closed with a short
 *     fixed reason and never execute (exact same-toolCallId identity only
 *     — P4 validation evidence is never consulted); when the in-memory
 *     handle map is already at MAX_IN_FLIGHT_RECEIPTS a new call is
 *     blocked with a fixed bounded reason BEFORE begin/execution —
 *     existing pending handles are never evicted
 *   - one `tool_result` handler finalizes ONLY handles begun by this
 *     runtime with the exact same toolCallId AND tool name (bounded
 *     in-memory map, capacity-blocked at MAX_IN_FLIGHT_RECEIPTS): text
 *     blocks only, env secrets scrubbed, status success/error, bounded
 *     redacted summary — before Pi emits tool_execution_end/final result
 *     events; the handle is removed after the attempt; success merges safe
 *     structured recovery metadata (available, result id, project-relative
 *     receipt path/status) into object details without changing
 *     content/isError/caps; failure never claims availability, never
 *     rewrites/rolls back domain artifacts, leaves the started receipt
 *     incomplete and merges a bounded unavailable code; a tool-name
 *     mismatch never finalizes, leaves the started receipt incomplete,
 *     consumes the in-memory handle and merges the bounded
 *     tool_name_mismatch fact; replay-blocked and recovery-tool results
 *     never finalize anything
 *   - public read-only `workbench_recover_tool_result` (appended LAST in
 *     the catalog/registration order; strict Sol DEV allowlist 14 → 15;
 *     AUDIT/VERIFY read-only sets; NOT receipted itself): exactly one of
 *     result_id (strict wtr1 shape) or tool_call_id (current-session
 *     derivation — the current native session identity AND the parameter
 *     are validated/narrowed BEFORE any hash; absent/invalid/
 *     control-char/over-bound identity fails closed with the fixed
 *     `invalid` code and hashes nothing); calls only
 *     recoverReceipt + the bounded renderer; fixed fail-closed codes
 *     invalid/missing/incomplete/corrupt/conflict/storage_error; reads no
 *     raw logs/domain records, runs no other tool, performs no refresh,
 *     and labels persisted summaries non-acceptance evidence
 *   - receipts never touch run/cache/gate/delegation artifacts or
 *     execution counts; legacy no-receipt sessions (absent/invalid native
 *     session identity) fail closed; this repository still implements NO
 *     WebSocket (or any other) transport
 *
 * Registers native Pi commands:
 *   /q-mode-audit /q-mode-dev /q-mode-verify /q-status   — mode control (P0)
 *   /q-init <profile>                                    — project init (P1)
 *   /q-run <recipe> [--no-cache|--refresh-cache]         — recipe runner (P1+P6-C)
 *   /q-runs /q-run-show <run-id>                         — run records (P1)
 *   /q-gate <selector> /q-gates /q-gate-show <gate-id>   — gate engine (P3)
 *   /q-evidence <run-id>                                 — evidence viewer (P3)
 *   /q-report latest|<run-id>                            — run report (P4)
 *   /q-compare <a> <b>                                   — run comparison (P4)
 *   /q-widget on|off                                     — widget toggle (P4)
 *   /q-cache-status                                     — cache telemetry status (P6-A)
 *   /q-cache-report [session|project] [--save <name>]   — cache telemetry report (P6-A)
 *   /q-cache-doctor [json]                             — cache telemetry health check (P6-A)
 *   /q-cache-explain <recipe>                          — action key / hit-miss (P6-C)
 *   /q-cache-prune [--apply]                           — LRU prune (P6-C)
 *   /q-cache-clear <recipe|all>                        — clear action cache (P6-C)
 *   /q-cache-validate <manifest-path>                  — quant contract validation (P6-D)
 *   /q-cache-lineage <run-id|action-key>               — quant cache lineage (P6-D)
 *   /q-cost-status                                     — split session cost (commander/worker/other)
 *   /q-context-output-status [json]                    — numeric-only output-control observations (R8)
 *   /q-delegation-status                              — write authority + delegation review status (P7)
 *   /q-write-policy status                           — P7 write policy status (P7)
 *   /q-commander-write-unlock <reason> --paths ...   — temporary commander write lease (P7)
 *   /q-commander-write-lock                          — revoke/lock the commander write lease (P7)
 *   /q-milestone-handoff <next step>                  — user-only milestone session handoff (P5)
 *
 * Registers workbench custom tools (P1/P3/P4/P7/P8b):
 *   workbench_project_inspect — project root, git, stacks, profile, recipes,
 *                               config errors (no secrets)
 *   workbench_run_recipe      — run a declared recipe only; full output to
 *                               disk, truncated summary to the model
 *   workbench_read_run      — read run records by run_id (bounded layered
 *                               summary default; manifest/logs on request)
 *   workbench_run_gate        — run the validation ladder (gates + checks)
 *   workbench_read_gate       — read a gate run record or gate definition
 *   workbench_list_gates      — list available gates with latest status
 *   workbench_compare_runs    — compare two run records (P4)
 *   workbench_delegate_worker — DEV-only bounded implementation delegation
 *                               from GPT-5.6 Sol to pinned DeepSeek max
 *   workbench_review_worker_diff — review a delegation's actual diff (P7)
 *   workbench_delegation_status — write authority + review status (P7)
 *   workbench_recover_tool_result — read-only tool-result receipt recovery (P8b)
 *
 * P4 UI (all Pi-native):
 *   - footer status via `ctx.ui.setStatus` (the Pi footer itself is never
 *     replaced): WB:<MODE> | <profile> | <gate>:<status> | run:<id>
 *   - compact widget via `ctx.ui.setWidget`, shown only while a task is
 *     active, a gate is failing, or the user forced it on (/q-widget)
 *   - compact renderCall/renderResult for the run/inspect/compare tools; expanded
 *     shows recipe, duration, exit code, artifacts, failed checks, log path
 *   - all UI calls are guarded by ctx.mode/ctx.hasUI — print/json modes
 *     never touch TUI-only APIs and every fact comes from the run's own
 *     JSON records (manifest/gates/result); renderers never recompute
 *     business metrics
 *
 * Mechanisms used (all Pi-native):
 *   - `pi.appendEntry` + `session_start` for mode persistence
 *   - `pi.setActiveTools` for the mode tool set (layer 1)
 *   - `pi.on("tool_call")` hard guard (layer 2): AUDIT blocks
 *     mutation/run/delegation; VERIFY blocks bash/edit/write/delegation;
 *     delegated workers additionally block recursion/bash/final gates and
 *     constrain edit/write paths
 *   - `pi.exec` (argv + shell=false + timeout/AbortSignal) for recipe runs
 *   - one short-lived `pi --mode json --no-session` child for a delegated
 *     worker task; no daemon, recursive delegation, or persistent worker
 *   - Pi's official CONFIG_DIR_NAME and truncation helpers
 *
 * Scope: stock selection, timing, mid/low-frequency backtesting, data
 * analysis, parameter experiments, walk-forward, out-of-sample validation,
 * and general software engineering. No HFT/L2/market-making/exchange
 * routing/execution code is implemented or planned.
 */

import { constants as BUFFER_CONSTANTS } from "node:buffer";
import { access, mkdir, open, readFile, writeFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	createFindToolDefinition,
	createGrepToolDefinition,
	createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
	buildNativeReadV3Page,
	READ_V3_ALLOCATION_TOO_SMALL,
	READ_V3_MAX_FILE_LINES,
	READ_V3_MAX_OUTPUT_BYTES,
	formatGrepCountLine,
	IMAGE_SNIFF_BYTES,
	NATIVE_OVERRIDE_METADATA,
	NATIVE_OVERRIDE_PARAMETERS,
	nativeResolveReadPath,
	sniffImageMimeType,
} from "./core/native-tool-policy.ts";
import { fileSourceSnapshotFromStats, readTextPage } from "./core/bounded-file-io.ts";
import {
	computeFileSourceId,
	decodeContinuationCursor,
	validateFileCursorSource,
	type FileCursorPayload,
	type FileSourceSnapshot,
} from "./core/continuation-cursor.ts";
import { runGrepCount } from "./core/native-search-adapter.ts";

import {
	checkToolCall,
	computeActiveTools,
	MODE_TOOLS,
	type WorkbenchMode,
} from "./core/mode-policy.ts";
import { RECOVERY_TOOL_NAME, WORKBENCH_TOOL_METADATA, WORKBENCH_TOOL_PARAMETERS, isWorkbenchToolName } from "./core/tool-catalog.ts";
import {
	beginBlockReason,
	beginReceipt,
	capacityBlockReason,
	deriveResultId,
	finalizeReceipt,
	finalizeUnavailableCode,
	isValidIdentity,
	MAX_IN_FLIGHT_RECEIPTS,
	receiptRelativePath,
	recoverFailureText,
	recoverReceipt,
	renderReceiptRecovery,
	type ReceiptHandle,
	type RecoverOutcome,
} from "./core/tool-result-recovery.ts";
import {
	commanderBlockReason,
	computeRoleActiveTools,
	parseWorkerAllowedPaths,
	resolveWorkerBudgetProfile,
	resolveWorkerRepairOf,
	workerRecipeBlockReason,
	workerRoleToolCallBlockReason,
	WORKER_ALLOWED_PATHS_ENV,
	WORKER_MODEL_ID,
	WORKER_MODEL_SELECTOR,
	WORKER_PROJECT_ROOT_ENV,
	WORKER_PROVIDER,
	WORKER_ROLE_ENV,
	type RecipeMutationFacts,
} from "./core/worker-policy.ts";
import { assertWorkerSucceeded, runDeepseekWorker, type WorkerRunResult } from "./worker/runner.ts";
import { buildDelegateWorkerResult } from "./worker/handoff.ts";
import { delegationContextRiskLine } from "./worker/context-diagnostics.ts";
import { isWorkerPathAllowedRealpath } from "./worker/path-scope.ts";
import {
	WORKER_HARD_BUDGET,
	WORKER_MODEL_CONTEXT_TOKENS,
	WORKER_SOFT_BUDGET,
	WORKER_SOFT_STEER_MESSAGE_TYPE,
	WORKER_SOFT_STEER_TEXT,
	workerBudgetBand,
	workerContextTokens,
} from "./core/worker-budget.ts";
import {
	addWorkerSpendUsage,
	EMPTY_WORKER_SPEND_STATE,
	formatWorkerSpendSteerText,
	isWorkerSpendProfile,
	workerSpendBand,
	workerSpendReasons,
	WORKER_SPEND_DEFAULT_PROFILE,
	WORKER_SPEND_PROFILE_ENV,
	WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE,
	type WorkerSpendState,
} from "./core/worker-spend.ts";
import {
	describeMode,
	loadModeFromEntries,
	MODE_ENTRY_TYPE,
	statusText,
} from "./core/state.ts";
import {
	findProjectRoot,
	loadProjectConfig,
	type ExecFn,
} from "./core/config.ts";
import { inspectProject } from "./core/inspect.ts";
import { planInit, applyInit, renderInitPlan } from "./core/init.ts";
import { isSupportedInitProfile, INIT_PROFILES } from "./core/templates.ts";
import { displayRelative, runRecipe, RecipeSetupError } from "./core/recipe-runner.ts";
import { buildArgv, type ValidationComponent } from "./core/recipe-schema.ts";
import { EXTENSION_VERSION, type TelemetryRecord } from "./cache/cache-types.ts";
import {
	GateSetupError,
	latestGateStatus,
	loadGates,
	preflightGateManualEvidence,
	runGates,
} from "./core/gate-engine.ts";
import { GATE_CATALOG } from "./core/gate-catalog.ts";
import { type Gate, type GateStatus, type WorkerFirstGateFacts } from "./core/gate-schema.ts";
import {
	DEFAULT_SNIPPET_BYTES,
	DEFAULT_SNIPPET_LINES,
	isValidRunId,
	listRuns,
	readLogSnippet,
	readManifest,
	readRunLogPage,
} from "./core/runs.ts";
import { join } from "node:path";
import { runStatusLabel, fitToWidth } from "./core/format.ts";
import { renderRunLogPage, renderRunResult } from "./core/run-result.ts";
import { assessRunValidation } from "./core/validation-assessment.ts";
import { buildStatusLine } from "./core/status.ts";
import { buildCostBreakdown, costStatusSegment, renderCostBreakdown } from "./core/cost-breakdown.ts";
import {
	advisoryStatusSegment,
	contextOutputAdvisoryStatusSegment,
	evaluateAdvisory,
	renderAdvisoryFacts,
	type AdvisoryConfig,
} from "./core/commander-advisory.ts";
import { buildGateParentSummary, buildRecipeParentSummary } from "./core/result-summary.ts";
import { buildWidgetLines, widgetAction, type WidgetState } from "./core/widget.ts";
import {
	buildRunReport,
	GATE_READ_MAX_BYTES,
	latestGateRunSummary,
	latestGateStatuses,
	readGateEvidenceView,
	readGateRunPage,
	renderGateDefinitionPage,
	resolveRunTarget,
} from "./core/report.ts";
import { compareRuns } from "./core/compare.ts";
import { COMPARISON_PERSIST_ERROR } from "./core/comparison-record.ts";
import {
	buildCompactNote,
	collectDoNotRetry,
	COMPACT_NOTE_MESSAGE_TYPE,
	COMPACT_STATE_ENTRY_TYPE,
	emptyCompactState,
	loadCompactStateFromEntries,
	MAX_DO_NOT_RETRY,
	MAX_EVIDENCE_PATHS,
	MAX_GATES,
	MAX_MODIFIED_FILES,
	pushBounded,
	shouldSupplement,
	type CompactState,
} from "./core/compact.ts";
import {
	renderCompareLines,
	renderGatePreflightLines,
	renderInspectLines,
	type BoundedStringListDetails,
	type CompareToolDetails,
	type GatePreflightToolDetails,
	type GateToolDetails,
	type InspectToolDetails,
	type ReadRunToolDetails,
	type RecipeToolDetails,
} from "./core/render.ts";
import { workbenchToolRenderer } from "./ui/tool-renderers.ts";
import {
	createCacheTelemetry,
	type CacheTelemetry,
} from "./cache/cache-telemetry.ts";
import { buildCacheReport, renderCacheReport, renderCacheStatus, type RateLookup } from "./cache/cache-report.ts";
import { runDoctor, renderDoctor, doctorToJson, type DoctorFacts } from "./cache/cache-doctor.ts";
import { CacheStore, DEFAULT_MAX_TELEMETRY_BYTES } from "./cache/cache-store.ts";
import { ActionCacheStore } from "./cache/action-store.ts";
import {
	computeKey,
	lookupValidated,
	planCache,
	type ActionCacheContext,
	type CacheRequestMode,
} from "./cache/action-cache.ts";
import { renderCacheExplain, renderPrune, renderClear, type ExplainFacts } from "./cache/action-explain.ts";
import { validateQuantManifestCommand, renderQuantCacheValidate } from "./cache/quant-cache-validate.ts";
import { buildQuantLineage, renderQuantLineage } from "./cache/quant-cache-lineage.ts";
import type { ActionRecord } from "./cache/action-types.ts";
import {
	collectAfterFacts,
	collectGitFacts,
	computeDiffHash,
	createDelegationLedger,
	finishDelegationLedger,
	makeDelegationId,
	readDelegationLedger,
	type AfterFacts,
	type GitFacts,
	type LedgerWorkerFacts,
	type LedgerWorkerSummaryRecord,
} from "./core/delegation-ledger.ts";
import {
	MAX_REVIEW_GUIDANCE_BYTES,
	MAX_REVIEW_PATCH_PATHS,
	MAX_REVIEW_PATH_BYTES,
	readReviewRecord,
	reviewDelegation,
} from "./core/diff-review.ts";
import {
	ERROR_RESULT_MAX_BYTES,
	DIFF_REVIEW_RESULT_MAX_BYTES,
	DIFF_REVIEW_RESULT_MAX_LINES,
	RUN_LOG_RESULT_MAX_BYTES,
	RUN_LOG_RESULT_MAX_LINES,
	clampWholeResultText,
	resolveToolOutputPolicy,
} from "./core/output-policy.ts";
import {
	enforceOutputEnvelope,
	enforceStreamingUpdate,
	type ImageContent as OutputImageContent,
	type OutputEnvelopeFacts,
	type OutputEnvelopeResult,
	type TextContent as OutputTextContent,
} from "./core/output-envelope.ts";
import {
	projectToolResultDetails,
	type BoundedReceiptFacts,
} from "./core/details-projection.ts";
import {
	COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES,
	HISTORY_DESCRIPTOR_MAX_BYTES,
	HISTORY_MAX_BUNDLES,
	OTHER_HISTORY_TOOL_TEXT_MAX_BYTES,
	WORKER_HISTORY_TOOL_TEXT_MAX_BYTES,
	historyProjectionFailureMessages,
	historyToolTextBytes,
	projectContextHistory,
	type HistoryProjectionFacts,
} from "./core/context-history-budget.ts";
import {
	blockedControlText,
	createTurnOutputBudgetState,
	planTurnOutputBudget,
	type TurnOutputAuthorization,
	type TurnRole,
} from "./core/turn-output-budget.ts";
import {
	OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE,
	createOutputControlTelemetry,
	renderOutputControlStatus,
	serializeOutputControlTelemetry,
	type OutputControlTelemetryAccumulator,
} from "./core/output-control-telemetry.ts";
import {
	blocksVerify,
	DELEGATION_STATE_ENTRY_TYPE,
	delegationCompactSummary,
	emptyDelegationState,
	hasPendingReview,
	hasStaleReview,
	loadDelegationStateFromEntries,
	markReviewed,
	demoteReviewedToPending,
	observeDiffChange,
	recordBlockedWriteAttempt,
	recordDelegation,
	reviewBlockReason,
	serializeDelegationState,
	type DelegationState,
} from "./core/delegation-state.ts";
import {
	commanderToolCallBlockReason,
	confirmLease,
	consumeLeaseCall,
	defaultWritePolicy,
	detectActorRole,
	issueLease,
	LEASE_STATE_ENTRY_TYPE,
	leaseCompactSummary,
	leaseRevokeReason,
	leaseStatus,
	loadLeaseFromEntries,
	revokeLease,
	serializeLease,
	type WriteLease,
} from "./core/write-authority.ts";
import {
	makeLeaseId,
	newConfirmationParts,
	parseUnlockArgs,
	parseWritePolicyArgs,
	renderLeaseConfirmed,
	renderLeaseIssued,
	renderUnlockPreview,
	renderWritePolicyStatus,
	UNLOCK_USAGE,
	writeAuthorityFooterSegment,
} from "./core/lease-command.ts";
import { collectSecretValues } from "./core/redact.ts";
import {
	buildMilestoneHandoffNote,
	makeMilestoneId,
	MILESTONE_HANDOFF_ENTRY_TYPE,
	MILESTONE_HANDOFF_NOTE_ENTRY_TYPE,
	milestoneHandoffUsage,
	parseNextStepArg,
	prepareMilestoneHandoff,
	toCancelledRecord,
	toResumedRecord,
} from "./core/milestone-handoff.ts";

const STATUS_KEY = "workbench";
const OUTPUT_TURN_TELEMETRY_ENTRY_TYPE = "workbench-output-turn-telemetry-v1";

/** Secret env values scrubbed from every ledger/review artifact. */
const secrets = collectSecretValues(process.env);

type RuntimeOutputContent = Array<OutputTextContent | OutputImageContent>;

const MAX_GUARD_REASON_BYTES = 511;
const MAX_GUARD_REASON_LINES = 4;
const GUARD_REASON_FALLBACK = "[workbench blocked]";

/** Fixed-safe guard presentation: no path, argument or exception can exceed Pi's immediate-result boundary. */
function boundedGuardReason(value: unknown): string {
	try {
		const source = typeof value === "string" ? value : GUARD_REASON_FALLBACK;
		let result = "";
		let usedBytes = 0;
		let usedLines = 0;
		for (let index = 0; index < source.length; index += 1) {
			const unit = source.charCodeAt(index);
			let scalar: string;
			if (unit >= 0xd800 && unit <= 0xdbff) {
				const next = source.charCodeAt(index + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					scalar = source.slice(index, index + 2);
					index += 1;
				} else scalar = "\ufffd";
			} else scalar = unit >= 0xdc00 && unit <= 0xdfff ? "\ufffd" : source[index]!;
			const scalarBytes = Buffer.byteLength(scalar, "utf8");
			const nextLines = result.length === 0 ? (scalar === "\n" ? 2 : 1) : usedLines + (scalar === "\n" ? 1 : 0);
			if (usedBytes + scalarBytes > MAX_GUARD_REASON_BYTES || nextLines > MAX_GUARD_REASON_LINES) break;
			result += scalar;
			usedBytes += scalarBytes;
			usedLines = nextLines;
		}
		return result.length > 0 ? result : GUARD_REASON_FALLBACK;
	} catch {
		return GUARD_REASON_FALLBACK;
	}
}

/** Read an own DATA property without invoking a getter or proxy trap value. */
function ownDataValue(value: unknown, key: PropertyKey): unknown {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value") ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

/** Collect assistant tool calls in source order without invoking accessors. */
function assistantToolCalls(message: unknown): unknown[] | undefined {
	if (ownDataValue(message, "role") !== "assistant") return undefined;
	const content = ownDataValue(message, "content");
	if (!Array.isArray(content)) return [];
	const calls: unknown[] = [];
	const lengthValue = ownDataValue(content, "length");
	const length = typeof lengthValue === "number" && Number.isSafeInteger(lengthValue) && lengthValue >= 0
		? Math.min(lengthValue, 2_049)
		: 0;
	for (let index = 0; index < length; index += 1) {
		const block = ownDataValue(content, String(index));
		if (ownDataValue(block, "type") !== "toolCall") continue;
		calls.push({
			toolCallId: ownDataValue(block, "id"),
			toolName: ownDataValue(block, "name"),
			args: ownDataValue(block, "arguments"),
		});
	}
	return calls;
}

function exactCallKey(toolCallId: unknown, toolName: unknown): string | undefined {
	if (
		typeof toolCallId !== "string" || toolCallId.length === 0 || toolCallId.length > 512
		|| typeof toolName !== "string" || toolName.length === 0 || toolName.length > 512
	) return undefined;
	return JSON.stringify([toolCallId, toolName]);
}

/**
 * Streaming details are presentation-only.  If defensive projection had to
 * touch, omit, or replace any ordinary detail, expose one fixed short DTO
 * instead of allowing a hostile/circular/accessor payload into Pi's partial
 * result event.  Trusted envelope facts remain numeric/bounded and no receipt
 * is ever minted for an update.
 */
function streamingDetailsFailure(envelope: OutputEnvelopeFacts): Record<string, unknown> {
	return {
		details_projection: { available: false, code: "projection_error" },
		output_envelope: envelope,
	};
}

function boundedStreamingUpdate<TDetails>(
	toolName: string,
	partialResult: AgentToolResult<TDetails>,
): AgentToolResult<TDetails> {
	const content = ownDataValue(partialResult, "content");
	const details = ownDataValue(partialResult, "details");
	const envelope = enforceStreamingUpdate({ toolName, content });
	const projection = projectToolResultDetails({
		toolName,
		details,
		envelope: envelope.facts,
	});
	return {
		content: envelope.content,
		details: (projection.truncated
			? streamingDetailsFailure(envelope.facts)
			: projection.details) as TDetails,
	};
}

/** Locally bounded objects skip the publish-time defense-in-depth pass. */
const locallyBoundedStreamingUpdates = new WeakSet<object>();

function wrapStreamingToolDefinition<TParams extends TSchema, TDetails, TState>(
	tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	const execute = tool.execute;
	const toolName = tool.name;
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const boundedOnUpdate: AgentToolUpdateCallback<TDetails> | undefined = onUpdate
				? (partialResult) => {
					const bounded = boundedStreamingUpdate(toolName, partialResult);
					locallyBoundedStreamingUpdates.add(bounded);
					onUpdate(bounded);
				}
				: undefined;
			return execute.call(tool, toolCallId, params, signal, boundedOnUpdate, ctx);
		},
	};
}

/**
 * Pi 0.83 does not let an extension replace a tool_execution_update event, but
 * AgentSession currently passes the same mutable AgentToolResult object to
 * extension handlers before notifying downstream subscribers. Replace its two
 * presentation fields in place as defense in depth for exact trusted built-ins.
 *
 * This mutation is never the authority for foreign tools: a frozen, accessor-
 * backed, inherited or Proxy partial result cannot be proven rewritable. The
 * tool_call guard below therefore prevents every effective foreign definition
 * from executing before it can publish any update.
 */
function boundGlobalStreamingUpdate(event: unknown): void {
	const partialResult = ownDataValue(event, "partialResult");
	const toolNameValue = ownDataValue(event, "toolName");
	if ((typeof partialResult !== "object" && typeof partialResult !== "function") || partialResult === null) return;
	if (locallyBoundedStreamingUpdates.delete(partialResult)) return;
	let contentDescriptor: PropertyDescriptor | undefined;
	let detailsDescriptor: PropertyDescriptor | undefined;
	try {
		contentDescriptor = Object.getOwnPropertyDescriptor(partialResult, "content");
		detailsDescriptor = Object.getOwnPropertyDescriptor(partialResult, "details");
	} catch {
		return;
	}
	if (
		!contentDescriptor || !Object.prototype.hasOwnProperty.call(contentDescriptor, "value")
		|| !detailsDescriptor || !Object.prototype.hasOwnProperty.call(detailsDescriptor, "value")
		|| (!contentDescriptor.writable && !contentDescriptor.configurable)
		|| (!detailsDescriptor.writable && !detailsDescriptor.configurable)
	) return;
	const bounded = boundedStreamingUpdate(
		typeof toolNameValue === "string" ? toolNameValue : "",
		partialResult as AgentToolResult<unknown>,
	);
	try {
		Object.defineProperties(partialResult, {
			content: { ...contentDescriptor, value: bounded.content },
			details: { ...detailsDescriptor, value: bounded.details },
		});
	} catch {
		// A non-conforming foreign object cannot be safely rewritten through
		// Pi 0.83's observation-only event API. Never invoke accessors as a
		// fallback and never claim it is inside the supported global scope.
	}
}

const STREAMING_BOUNDARY_UNAVAILABLE = "Tool streaming output boundary is unavailable";
const MAX_STREAMING_REGISTRY_TOOLS = 4_096;
const WORKBENCH_RUNTIME_SOURCE_PATH = fileURLToPath(import.meta.url);
const WORKBENCH_RUNTIME_SOURCE_DIR = dirname(WORKBENCH_RUNTIME_SOURCE_PATH);
const WORKBENCH_PACKAGE_ROOT = dirname(dirname(WORKBENCH_RUNTIME_SOURCE_DIR));
const TRUSTED_PI_BUILTIN_NAMES = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);
const SOURCE_INFO_KEYS = ["baseDir", "origin", "path", "scope", "source"] as const;

type StreamingToolTrust = "trusted" | "absent" | "unproven";

function hasExactSourceInfoKeys(value: unknown): boolean {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
	try {
		const keys = Reflect.ownKeys(value);
		if (keys.some((key) => typeof key !== "string")) return false;
		const sorted = (keys as string[]).slice().sort();
		return sorted.length === SOURCE_INFO_KEYS.length
			&& SOURCE_INFO_KEYS.every((key, index) => sorted[index] === key);
	} catch {
		return false;
	}
}

function isExactWorkbenchSourceInfo(value: unknown): boolean {
	if (!hasExactSourceInfoKeys(value) || ownDataValue(value, "path") !== WORKBENCH_RUNTIME_SOURCE_PATH) return false;
	const source = ownDataValue(value, "source");
	const scope = ownDataValue(value, "scope");
	const origin = ownDataValue(value, "origin");
	const baseDir = ownDataValue(value, "baseDir");
	const exactTemporarySource = source === "local"
		&& scope === "temporary"
		&& origin === "top-level"
		&& baseDir === WORKBENCH_RUNTIME_SOURCE_DIR;
	// The repository's checked-in `.pi/settings.json` loads this package via
	// `packages: [".."]`. Pi preserves that literal source and assigns the
	// resolved package root as baseDir. Keep this acceptance tuple exact: a
	// different project package, source spelling, entry path, or base directory
	// remains foreign even if it collides with a workbench tool name.
	const exactRepositoryPackageSource = source === ".."
		&& scope === "project"
		&& origin === "package"
		&& baseDir === WORKBENCH_PACKAGE_ROOT;
	return exactTemporarySource || exactRepositoryPackageSource;
}

function isExactTrustedBuiltinSourceInfo(toolName: string, value: unknown): boolean {
	return TRUSTED_PI_BUILTIN_NAMES.has(toolName)
		&& hasExactSourceInfoKeys(value)
		&& ownDataValue(value, "path") === `<builtin:${toolName}>`
		&& ownDataValue(value, "source") === "builtin"
		&& ownDataValue(value, "scope") === "temporary"
		&& ownDataValue(value, "origin") === "top-level"
		&& ownDataValue(value, "baseDir") === undefined;
}

interface StreamingControlPlane {
	readonly api: ExtensionAPI;
	readonly toolCallBlockReason: (toolName: unknown) => string | undefined;
}

/**
 * Install the global publish-time boundary, then shadow registerTool so tools
 * owned by this extension are additionally bounded at their callback source.
 * Every call re-resolves Pi's effective registry: a workbench name is trusted
 * only when this runtime wrapped it AND its live source is this exact module;
 * the seven pinned Pi built-ins require their exact synthetic provenance.
 * Missing definitions are left to Pi's non-executing unknown-tool path, while
 * malformed, collided, SDK and foreign definitions fail closed. All other API
 * methods retain the original ExtensionAPI receiver.
 */
function streamingControlledApi(runtimePi: ExtensionAPI): StreamingControlPlane {
	const wrappedTools = new Map<string, object>();
	runtimePi.on("tool_execution_update", (event) => {
		boundGlobalStreamingUpdate(event);
	});
	function registerBoundedTool<TParams extends TSchema, TDetails, TState>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void {
		const wrapped = wrapStreamingToolDefinition(tool);
		wrappedTools.set(tool.name, wrapped);
		runtimePi.registerTool(wrapped);
	}
	const api = new Proxy(runtimePi, {
		get(target, property) {
			if (property === "registerTool") return registerBoundedTool;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	function effectiveToolTrust(toolName: unknown): StreamingToolTrust {
		if (typeof toolName !== "string" || toolName.length === 0 || toolName.length > 512) return "unproven";
		let tools: unknown;
		try {
			tools = runtimePi.getAllTools();
		} catch {
			return "unproven";
		}
		if (!Array.isArray(tools)) return "unproven";
		const length = ownDataValue(tools, "length");
		if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > MAX_STREAMING_REGISTRY_TOOLS) {
			return "unproven";
		}
		let match: unknown;
		for (let index = 0; index < length; index += 1) {
			const candidate = ownDataValue(tools, String(index));
			const candidateName = ownDataValue(candidate, "name");
			if (typeof candidateName !== "string" || candidateName.length === 0 || candidateName.length > 512) {
				return "unproven";
			}
			if (candidateName !== toolName) continue;
			if (match !== undefined) return "unproven";
			match = candidate;
		}
		if (match === undefined) return "absent";
		// Some conforming test/non-Pi hosts expose the exact registered
		// definition rather than Pi's ToolInfo projection. Reference equality
		// is still a complete proof that this runtime installed the wrapper.
		if (wrappedTools.get(toolName) === match) return "trusted";
		const sourceInfo = ownDataValue(match, "sourceInfo");
		if (wrappedTools.has(toolName) && isExactWorkbenchSourceInfo(sourceInfo)) return "trusted";
		if (isExactTrustedBuiltinSourceInfo(toolName, sourceInfo)) return "trusted";
		return "unproven";
	}

	return {
		api,
		toolCallBlockReason(toolName) {
			return effectiveToolTrust(toolName) === "unproven" ? STREAMING_BOUNDARY_UNAVAILABLE : undefined;
		},
	};
}

function runtimeFailureEnvelope(): OutputEnvelopeResult {
	const policy = resolveToolOutputPolicy({ toolName: "", args: undefined, role: "commander" });
	return enforceOutputEnvelope({
		toolName: "",
		content: null as unknown as RuntimeOutputContent,
		isError: true,
		policy,
		allocatedBytes: ERROR_RESULT_MAX_BYTES,
	});
}

// ------------------------------------------------------------- P5 state

/** Workbench facts carried across compaction and session replacement (P5). */
let compactState: CompactState = emptyCompactState("DEV");
/** Recent run-outcome signatures (newest last) for repeated-failure notes. */
let recentOutcomes: string[] = [];
/** The last supplement note sent, to avoid duplicates. */
let lastCompactNote: string | undefined;

function touchCompactState(): void {
	compactState.updatedAt = new Date().toISOString();
}

function rememberRunOutcome(toolName: string, details: Record<string, unknown>): void {
	if (toolName === "workbench_run_gate") {
		const status = typeof details.status === "string" ? details.status : "UNKNOWN";
		recentOutcomes.push(`gate:${status}`);
	} else if (toolName === "workbench_run_recipe") {
		const recipe = typeof details.recipe === "string" ? details.recipe : "?";
		recentOutcomes.push(details.ok === true ? `recipe:${recipe}:ok` : `recipe:${recipe}:exit:${String(details.exit_code ?? "?")}`);
	}
	recentOutcomes = recentOutcomes.slice(-12);
	compactState.doNotRetry = collectDoNotRetry(recentOutcomes, MAX_DO_NOT_RETRY);
}

type NativeReadV3IoErrorCode = "source_not_regular" | "source_changed_during_read" | "source_oversized" | "io_error";

class NativeReadV3IoFailure extends Error {
	constructor(readonly code: NativeReadV3IoErrorCode) {
		super(code);
		this.name = "NativeReadV3IoFailure";
	}
}

export interface NativeReadV3TestHookFacts {
	readonly toolCallId: string;
	readonly fileSize: number;
	readonly mimeType: string | null;
}

/**
 * Deterministic race instrumentation for native-read regression tests.
 * Hooks are scoped to one exact tool-call id and receive no path or content.
 */
export interface NativeReadV3TestHooks {
	afterMagicSniff?: (facts: Readonly<NativeReadV3TestHookFacts>) => void | Promise<void>;
	afterImageBytesRead?: (facts: Readonly<NativeReadV3TestHookFacts>) => void | Promise<void>;
	afterAuthoritativeClose?: (facts: Readonly<{ toolCallId: string; closed: boolean }>) => void | Promise<void>;
}

const nativeReadV3TestHooks = new Map<string, Readonly<NativeReadV3TestHooks>>();

/** Test-only, opt-in hook lease; restoring cannot remove another lease. */
export function installNativeReadV3TestHooks(toolCallId: string, hooks: Readonly<NativeReadV3TestHooks>): () => void {
	if (toolCallId.length === 0 || toolCallId.length > 512 || nativeReadV3TestHooks.has(toolCallId)) {
		throw new Error("invalid native read v3 test hook lease");
	}
	nativeReadV3TestHooks.set(toolCallId, hooks);
	return () => {
		if (nativeReadV3TestHooks.get(toolCallId) === hooks) nativeReadV3TestHooks.delete(toolCallId);
	};
}

function sameNativeReadSnapshot(a: FileSourceSnapshot, b: FileSourceSnapshot): boolean {
	return a.fileSize === b.fileSize
		&& a.mtimeMs === b.mtimeMs
		&& a.mtimeNs === b.mtimeNs
		&& a.dev === b.dev
		&& a.ino === b.ino;
}

async function nativeReadHandleSnapshot(handle: FileHandle): Promise<FileSourceSnapshot> {
	try {
		const stats = await handle.stat({ bigint: true });
		if (!stats.isFile()) throw new NativeReadV3IoFailure("source_not_regular");
		const snapshot = fileSourceSnapshotFromStats(stats);
		if (!snapshot.ok) throw new NativeReadV3IoFailure("io_error");
		return snapshot.value;
	} catch (error) {
		if (error instanceof NativeReadV3IoFailure) throw error;
		throw new NativeReadV3IoFailure("io_error");
	}
}

async function verifyNativeReadHandle(handle: FileHandle, expected: FileSourceSnapshot): Promise<void> {
	let current: FileSourceSnapshot;
	try {
		current = await nativeReadHandleSnapshot(handle);
	} catch {
		throw new NativeReadV3IoFailure("source_changed_during_read");
	}
	if (!sameNativeReadSnapshot(expected, current)) throw new NativeReadV3IoFailure("source_changed_during_read");
}

/** Verify that the path still resolves to the authoritative inode; never read it. */
async function verifyNativeReadPathIdentity(path: string, expected: FileSourceSnapshot): Promise<void> {
	let verifier: FileHandle;
	try {
		verifier = await open(path, "r");
	} catch {
		throw new NativeReadV3IoFailure("source_changed_during_read");
	}
	let current: FileSourceSnapshot | undefined;
	let failed = false;
	try {
		current = await nativeReadHandleSnapshot(verifier);
	} catch {
		failed = true;
	}
	try {
		await verifier.close();
	} catch {
		throw new NativeReadV3IoFailure("io_error");
	}
	if (failed || current === undefined || !sameNativeReadSnapshot(expected, current)) {
		throw new NativeReadV3IoFailure("source_changed_during_read");
	}
}

function throwIfNativeReadAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

async function readNativeHandleExactly(handle: FileHandle, size: number, signal: AbortSignal | undefined): Promise<Buffer> {
	if (!Number.isSafeInteger(size) || size < 0) throw new NativeReadV3IoFailure("io_error");
	if (size > BUFFER_CONSTANTS.MAX_LENGTH) throw new NativeReadV3IoFailure("source_oversized");
	let buffer: Buffer;
	try {
		buffer = Buffer.allocUnsafe(size);
	} catch {
		throw new NativeReadV3IoFailure("source_oversized");
	}
	let offset = 0;
	while (offset < buffer.length) {
		throwIfNativeReadAborted(signal);
		let bytesRead: number;
		try {
			({ bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset));
		} catch {
			throw new NativeReadV3IoFailure("io_error");
		}
		if (bytesRead <= 0) throw new NativeReadV3IoFailure("source_changed_during_read");
		offset += bytesRead;
	}
	return buffer;
}

async function closeNativeReadAuthority(handle: FileHandle, toolCallId: string): Promise<boolean> {
	let closed = true;
	try {
		await handle.close();
	} catch {
		closed = false;
	}
	try {
		await nativeReadV3TestHooks.get(toolCallId)?.afterAuthoritativeClose?.(Object.freeze({ toolCallId, closed }));
	} catch {
		closed = false;
	}
	return closed;
}

export default function workbenchRuntime(runtimePi: ExtensionAPI): void {
	const streamingControl = streamingControlledApi(runtimePi);
	const pi = streamingControl.api;
	let mode: WorkbenchMode = "DEV";
	/**
	 * P7 session-scoped write-authority state. The delegation review
	 * lifecycle and the temporary commander write lease are persisted as Pi
	 * custom entries (survive compaction and session replacement) and
	 * restored on session_start. The lease is issued/confirmed/locked only
	 * through the user-only slash commands (core/lease-command.ts + the
	 * handlers below); it is never granted by prompts or config.
	 */
	let delegationState: DelegationState = emptyDelegationState();
	let writeLease: WriteLease | undefined;
	/**
	 * P8b: in-memory handles for receipts begun by THIS runtime
	 * (toolCallId → handle + project root). CAPACITY-BLOCKING at
	 * MAX_IN_FLIGHT_RECEIPTS: when the map is already full a new registered
	 * workbench call is blocked fail-closed BEFORE begin/execution with a
	 * fixed bounded reason — existing handles are never evicted and nothing
	 * is begun for the blocked call. Only handles created here are ever
	 * finalized; a replayed call or the recovery tool never enters this map.
	 */
	const pendingReceiptHandles = new Map<string, { handle: ReceiptHandle; projectRoot: string }>();
	/** Per-result side-channel facts keyed by Pi's SAME mutable middleware event. */
	const outputEnvelopeFactsByEvent = new WeakMap<object, OutputEnvelopeFacts>();
	const receiptFactsByEvent = new WeakMap<object, BoundedReceiptFacts>();
	/** Trusted continuation comes only from the registered tool result details. */
	/** Latest known commander identity facts (updated on session_start/model_select). */
	let currentModelFacts: { provider?: string; model?: string } = {};
	const workerRoleContext = {
		role: process.env[WORKER_ROLE_ENV],
		projectRoot: process.env[WORKER_PROJECT_ROOT_ENV],
		allowedPaths: parseWorkerAllowedPaths(process.env[WORKER_ALLOWED_PATHS_ENV]),
		// Phase 2 (worker token-budget repair): the delegation spend profile
		// from the fixed child env contract. The runner ALWAYS writes a valid
		// low/standard/extended value; malformed/missing child env falls back
		// to `standard` defensively (strict validation, never guessed).
		spendProfile: isWorkerSpendProfile(process.env[WORKER_SPEND_PROFILE_ENV])
			? process.env[WORKER_SPEND_PROFILE_ENV]
			: WORKER_SPEND_DEFAULT_PROFILE,
	};
	const turnOutputBudget = createTurnOutputBudgetState();
	/** Session-scoped numeric-only context-output observations (never enforcement). */
	let outputControlTelemetry: OutputControlTelemetryAccumulator | undefined;
	let outputControlTelemetryRole: TurnRole | undefined;
	const pendingOutputAuthorizations = new Map<string, TurnOutputAuthorization[]>();
	/** Cursor facts created by this runtime's read execute, never by details. */
	const trustedReadContinuations = new Map<string, Array<{ kind: "read"; value: string }>>();
	/** Run-log cursor facts created by this runtime, never accepted from details. */
	const trustedRunLogContinuations = new Map<string, Array<{ kind: "run-log"; value: string }>>();
	/** Gate-page cursors created by read_gate execute, never accepted from details. */
	const trustedGateContinuations = new Map<string, Array<{ kind: "gate-read"; value: string }>>();
	/** Exact FIFO counts for results that already traversed all tool_result middleware. */
	const processedNormalResults = new Map<string, number>();
	/**
	 * Numeric-only outgoing-history side channel. R8 consumes this in-memory
	 * snapshot when it persists the unified output-control telemetry; R7 does
	 * not append an entry per provider request and never retains message text.
	 */
	let latestHistoryProjectionFacts: HistoryProjectionFacts = {
		originalToolTextBytes: 0,
		finalToolTextBytes: 0,
		collapsedResults: 0,
		removedBundles: 0,
		protectedLatestBundles: 0,
	};
	let currentTurnSerial = 0;

	function outputTurnRole(): TurnRole {
		if (workerRoleContext.role === "worker") return "worker";
		return detectActorRole({
			roleEnv: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		}) === "sol-commander" ? "commander" : "other";
	}

	function ensureOutputControlTelemetry(entries?: readonly unknown[]): OutputControlTelemetryAccumulator {
		const role = outputTurnRole();
		if (!outputControlTelemetry || outputControlTelemetryRole !== role) {
			outputControlTelemetry = createOutputControlTelemetry(role);
			outputControlTelemetryRole = role;
			if (entries) outputControlTelemetry.restoreFromEntries(entries);
		}
		return outputControlTelemetry;
	}

	function mirrorOutputControlCompactFacts(): void {
		const snapshot = ensureOutputControlTelemetry().snapshot();
		compactState.outputTruncatedResults = snapshot.totals.truncatedResults;
		compactState.outputHistoryCollapsedBundles = snapshot.totals.historyCollapsedResults;
	}

	function persistOutputControlTelemetry(): void {
		const snapshot = serializeOutputControlTelemetry(ensureOutputControlTelemetry().snapshot());
		pi.appendEntry(OUTPUT_CONTROL_TELEMETRY_ENTRY_TYPE, snapshot);
	}

	function observeOutputEnvelope(toolName: unknown, facts: unknown): void {
		try {
			ensureOutputControlTelemetry().recordEnvelope(toolName, facts);
			mirrorOutputControlCompactFacts();
		} catch {
			// Observation is never allowed to alter or reject a bounded result.
		}
	}

	function rememberOutputAuthorization(authorization: TurnOutputAuthorization): void {
		if (!authorization.authorizationId) return;
		const key = exactCallKey(authorization.toolCallId, authorization.toolName);
		if (!key) return;
		const queue = pendingOutputAuthorizations.get(key) ?? [];
		queue.push(authorization);
		pendingOutputAuthorizations.set(key, queue);
	}

	function takeOutputAuthorization(toolCallId: unknown, toolName: unknown): TurnOutputAuthorization | undefined {
		const key = exactCallKey(toolCallId, toolName);
		if (!key) return undefined;
		const queue = pendingOutputAuthorizations.get(key);
		const authorization = queue?.shift();
		if (queue?.length === 0) pendingOutputAuthorizations.delete(key);
		return authorization;
	}

	/**
	 * Read the next exact id+name authorization without settling its FIFO slot.
	 * Tool execute uses this only to render inside its already-authorized byte
	 * allocation; tool_result remains the sole consumer/accounting boundary.
	 */
	function peekOutputAuthorization(toolCallId: unknown, toolName: unknown): TurnOutputAuthorization | undefined {
		const key = exactCallKey(toolCallId, toolName);
		if (!key) return undefined;
		return pendingOutputAuthorizations.get(key)?.[0];
	}

	function rememberTrustedReadContinuation(toolCallId: unknown, cursor: unknown): void {
		if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 1_024) return;
		const key = exactCallKey(toolCallId, "read");
		if (!key) return;
		const queue = trustedReadContinuations.get(key) ?? [];
		queue.push({ kind: "read", value: cursor });
		trustedReadContinuations.set(key, queue);
	}

	function takeTrustedReadContinuation(toolCallId: unknown, toolName: unknown): { kind: "read"; value: string } | undefined {
		const key = exactCallKey(toolCallId, toolName);
		if (!key || toolName !== "read") return undefined;
		const queue = trustedReadContinuations.get(key);
		const continuation = queue?.shift();
		if (queue?.length === 0) trustedReadContinuations.delete(key);
		return continuation;
	}

	function rememberTrustedRunLogContinuation(toolCallId: unknown, cursor: unknown): void {
		if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 1_024) return;
		const key = exactCallKey(toolCallId, "workbench_read_run");
		if (!key) return;
		const queue = trustedRunLogContinuations.get(key) ?? [];
		queue.push({ kind: "run-log", value: cursor });
		trustedRunLogContinuations.set(key, queue);
	}

	function takeTrustedRunLogContinuation(toolCallId: unknown, toolName: unknown): { kind: "run-log"; value: string } | undefined {
		const key = exactCallKey(toolCallId, toolName);
		if (!key || toolName !== "workbench_read_run") return undefined;
		const queue = trustedRunLogContinuations.get(key);
		const continuation = queue?.shift();
		if (queue?.length === 0) trustedRunLogContinuations.delete(key);
		return continuation;
	}

	function rememberTrustedGateContinuation(toolCallId: unknown, cursor: unknown): void {
		if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 1_024) return;
		const key = exactCallKey(toolCallId, "workbench_read_gate");
		if (!key) return;
		const queue = trustedGateContinuations.get(key) ?? [];
		queue.push({ kind: "gate-read", value: cursor });
		trustedGateContinuations.set(key, queue);
	}

	function takeTrustedGateContinuation(toolCallId: unknown, toolName: unknown): { kind: "gate-read"; value: string } | undefined {
		const key = exactCallKey(toolCallId, toolName);
		if (!key || toolName !== "workbench_read_gate") return undefined;
		const queue = trustedGateContinuations.get(key);
		const continuation = queue?.shift();
		if (queue?.length === 0) trustedGateContinuations.delete(key);
		return continuation;
	}

	function authorizeOutput(toolCallId: unknown, toolName: unknown, args: unknown): TurnOutputAuthorization {
		return turnOutputBudget.authorizeToolCall({ toolCallId, toolName, args });
	}

	function rememberProcessedNormalResult(toolCallId: unknown, toolName: unknown): void {
		const key = exactCallKey(toolCallId, toolName);
		if (!key) return;
		processedNormalResults.set(key, (processedNormalResults.get(key) ?? 0) + 1);
	}

	function takeProcessedNormalResult(toolCallId: unknown, toolName: unknown): boolean {
		const key = exactCallKey(toolCallId, toolName);
		if (!key) return false;
		const count = processedNormalResults.get(key) ?? 0;
		if (count <= 0) return false;
		if (count === 1) processedNormalResults.delete(key);
		else processedNormalResults.set(key, count - 1);
		return true;
	}
	/** One-shot worker soft-budget steer flag (worker role only, per process). */
	let workerSoftSteerSent = false;
	/**
	 * Phase 2: one-shot worker cumulative spend soft-steer flag — its OWN
	 * flag, fully independent of the context steer flag above.
	 */
	let workerSpendSoftSteerSent = false;
	/**
	 * Phase 2: independent cumulative spend state accumulated over assistant
	 * `message_end` events (worker role only). Independent of the runner's
	 * own copy and of the context-budget tracking; every assistant message
	 * increments it exactly once via the pure policy.
	 */
	let workerSpendState: WorkerSpendState = { ...EMPTY_WORKER_SPEND_STATE };

	const execFn: ExecFn = (command, args, options) =>
		pi.exec(command, args, { cwd: options?.cwd, timeout: options?.timeout, signal: options?.signal });

	// ---------------------------------------------------------- P6-A cache

	/** Session-scoped prompt-cache telemetry (hash-only, never blocking). */
	const cacheTelemetry: CacheTelemetry = createCacheTelemetry({
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
	});

	// ------------------------------------------------------------------ state

	/** P7: persist the delegation review state as a Pi custom entry. */
	function persistDelegationState(): void {
		// P7 slice 3: keep the compaction mirror in step with every delegation
		// state change (the mirror is a bounded summary — the persisted entry
		// above stays authoritative for the hard guards).
		refreshCompactP7Facts();
		try {
			pi.appendEntry(DELEGATION_STATE_ENTRY_TYPE, serializeDelegationState(delegationState));
		} catch {
			// non-interactive context: the in-memory state is still authoritative
		}
	}

	/** P7: persist the commander write lease (or its absence) as a Pi custom entry. */
	function persistLease(): void {
		// P7 slice 3: the compaction mirror carries the bounded lease summary.
		refreshCompactP7Facts();
		try {
			pi.appendEntry(LEASE_STATE_ENTRY_TYPE, writeLease ? serializeLease(writeLease) : undefined);
		} catch {
			// non-interactive context: the in-memory lease is still authoritative
		}
	}

	// ------------------------------------------------------------------
	// P7 slice 3 — compaction mirror + injected worker-first gate facts
	// ------------------------------------------------------------------

	/**
	 * P7: bounded text for the next required delegation/review action. The
	 * compact note and /q-delegation-status share this derivation.
	 */
	function nextDelegationActionText(state: DelegationState): string | undefined {
		if (state.latestId === undefined) return "start the first worker delegation (no delegation yet)";
		if (state.status === "PENDING_REVIEW") {
			return `review delegation ${state.latestId} (PENDING_REVIEW) before the next delegation or VERIFY`;
		}
		if (state.status === "STALE") {
			return `re-review delegation ${state.latestId} (STALE — the diff changed since the review)`;
		}
		return `delegation ${state.latestId} REVIEWED — start the next delegation or run final verification`;
	}

	/**
	 * P7 slice 3: refresh the compaction mirror with the current worker-first
	 * facts. The mirror is a bounded summary ONLY — the hard guards read the
	 * lease/delegation custom entries directly and never depend on this text.
	 */
	function refreshCompactP7Facts(): void {
		const now = new Date().toISOString();
		const actor = detectActorRole({
			roleEnv: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		});
		const policy = defaultWritePolicy(currentModelFacts.provider, currentModelFacts.model);
		compactState.writePolicy = policy ?? undefined;
		compactState.commanderWritesDenied =
			actor === "sol-commander" ? leaseStatus(writeLease, now) !== "active" : undefined;
		compactState.lastDelegationId = delegationState.latestId;
		compactState.pendingDelegationReview =
			delegationState.latestId !== undefined && (hasPendingReview(delegationState) || hasStaleReview(delegationState))
				? true
				: undefined;
		compactState.reviewedDiffHash = delegationState.reviewedDiffHash;
		compactState.activeWriteLease = writeLease ? leaseCompactSummary(writeLease, now) : undefined;
		compactState.blockedCommanderWriteAttempts =
			delegationState.blockedWriteAttempts > 0 ? delegationState.blockedWriteAttempts : undefined;
		// The next required delegation/review action belongs to the
		// worker-first flow: meaningful for the Sol commander (policy active)
		// and for any session carrying a delegation.
		compactState.nextDelegationAction =
			actor === "sol-commander" || delegationState.latestId !== undefined
				? nextDelegationActionText(delegationState)
				: undefined;
		touchCompactState();
	}

	/**
	 * P4b: collect the CURRENT real diff hash (fail-closed — null on any
	 * collection error, so the injected facts never fabricate a clean-tree
	 * hash). Each successful collection runs exactly ONE status command
	 * (inside the collector). Read-only.
	 */
	async function collectCurrentDiffHash(projectRoot: string): Promise<string | null> {
		try {
			const git = await collectGitFacts(projectRoot, execFn);
			return computeDiffHash(git.changedPaths, git.pathDigests, git.pathStatuses);
		} catch {
			return null;
		}
	}

	/**
	 * Shared facts builder over an explicit (possibly projected) delegation
	 * state + the injected current diff hash. Never mutates anything itself.
	 */
	async function buildWorkerFirstGateFactsFromState(
		projectRoot: string,
		state: DelegationState,
		injectedCurrentDiffHash: string | null,
		now: string,
	): Promise<WorkerFirstGateFacts> {
		const actor = detectActorRole({
			roleEnv: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		});
		const policy = defaultWritePolicy(currentModelFacts.provider, currentModelFacts.model);
		const leaseNow = leaseStatus(writeLease, now);
		const reviewBlock = reviewBlockReason(state, "verify");
		let reviewVerdict: "PASS" | "FAIL" | null = null;
		let reviewViolationCount: number | null = null;
		if (state.latestId !== undefined && reviewBlock === undefined) {
			try {
				const review = await readReviewRecord(projectRoot, state.latestId);
				if (review) {
					reviewVerdict = review.verdict;
					reviewViolationCount = review.violations.length;
				}
			} catch {
				// no review record — facts stay null (NOT_RUN for review checks)
			}
		}
		return {
			schema_version: 1,
			blockedReason: reviewBlock,
			actor,
			writePolicy: policy ?? null,
			commanderWritesDenied: actor === "sol-commander" ? leaseNow !== "active" : null,
			blockedCommanderWriteAttempts: state.blockedWriteAttempts,
			hasDelegation: state.latestId !== undefined,
			latestDelegationId: state.latestId ?? null,
			reviewStatus: state.latestId !== undefined ? state.status : null,
			currentDiffHash: injectedCurrentDiffHash,
			reviewedDiffHash: state.reviewedDiffHash ?? null,
			reviewVerdict,
			reviewViolationCount,
			leaseStatus: leaseNow,
			leaseReason: writeLease?.reason ?? null,
			leaseCallsUsed: writeLease?.callsUsed ?? 0,
			leaseMaxCalls: writeLease?.maxCalls ?? 0,
			gateRunInitiatedByCommander: actor === "sol-commander",
		};
	}

	/**
	 * P7 slice 3 (mutating gate-run path, unchanged behavior): construct the
	 * bounded worker-first compliance facts for a gate run from
	 * actor/policy/lease/delegation/latest-review facts. The delegation
	 * state is refreshed against the REAL git diff first (any change after
	 * REVIEWED turns it STALE here) and persisted — the mutating refresh
	 * stays gate-execution-only. When a pending/stale review blocks final
	 * verification, the facts carry `blockedReason` and every B6 check
	 * evaluates BLOCKED instead of being evaluated against partial facts.
	 * Never reads model prose — missing facts are NOT_RUN.
	 *
	 * B6 diff freshness FAILS CLOSED: the injected current diff hash is only
	 * ever refreshed from the real current git facts inside this call. When
	 * that collection fails (git unavailable/broken or any collection
	 * error), the authoritative delegation state is preserved untouched and
	 * the injected facts carry a MISSING current hash, so the required
	 * `reviewed-hash-matches-current` check evaluates NOT_RUN and can never
	 * PASS from a stale in-memory reviewed/current pair.
	 */
	async function buildWorkerFirstGateFacts(projectRoot: string, now: string): Promise<WorkerFirstGateFacts> {
		const hash = await collectCurrentDiffHash(projectRoot);
		if (hash === null) {
			// Best-effort refresh failed: the in-memory/persisted delegation
			// state stays authoritative and untouched, and the injected current
			// hash stays MISSING — `reviewed-hash-matches-current` is NOT_RUN.
			return buildWorkerFirstGateFactsFromState(projectRoot, delegationState, null, now);
		}
		delegationState = observeDiffChange(delegationState, hash, now);
		persistDelegationState();
		return buildWorkerFirstGateFactsFromState(projectRoot, delegationState, delegationState.currentDiffHash ?? null, now);
	}

	/**
	 * P4b READ-ONLY projection for workbench_read_run's assessment: observes
	 * the current real-diff freshness (a diff change after REVIEWED would
	 * flip the PROJECTED status to STALE exactly like the mutating path, so
	 * the gate-state facts hash refuses reuse) WITHOUT calling
	 * persistDelegationState / pi.appendEntry and WITHOUT mutating the
	 * authoritative in-memory delegation state. Collection failure stays
	 * fail-closed (missing current hash).
	 */
	async function buildReadOnlyWorkerFirstGateFacts(projectRoot: string, now: string): Promise<WorkerFirstGateFacts> {
		const hash = await collectCurrentDiffHash(projectRoot);
		if (hash === null) {
			return buildWorkerFirstGateFactsFromState(projectRoot, delegationState, null, now);
		}
		const projected = observeDiffChange(delegationState, hash, now);
		return buildWorkerFirstGateFactsFromState(projectRoot, projected, projected.currentDiffHash ?? null, now);
	}

	function applyModeTools(): void {
		// P7: the strict Sol DEV allowlist depends on the resolved actor
		// (env worker contract first, then provider/model); other actors keep
		// the existing DEV behavior, which the worker role filter then narrows.
		// An ACTIVE confirmed lease additionally enables exactly its edit/write
		// tools on top of the canonical 15-tool allowlist; pending/expired/
		// exhausted/revoked leases (or no lease) leave the exact 15.
		const actorFacts = {
			roleEnv: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		};
		const leaseTools =
			writeLease && leaseStatus(writeLease, new Date().toISOString()) === "active" ? [...writeLease.tools] : [];
		pi.setActiveTools(
			computeRoleActiveTools(computeActiveTools(mode, pi.getActiveTools(), actorFacts, leaseTools), workerRoleContext.role),
		);
	}

	/**
	 * P7: lazy lease-lock synchronization — no timers, no background
	 * resources. Called before an agent turn and before/within the relevant
	 * command/tool guards and the status refresh: when the lease is no
	 * longer ACTIVE (expired/exhausted/revoked — pending included), the
	 * exact canonical 15-tool set is reapplied so stale edit/write are
	 * never advertised. The second-layer tool_call guard stays
	 * authoritative: a blocked write call also removes the stale tools.
	 */
	function syncLeaseLock(now?: string): void {
		if (writeLease && leaseStatus(writeLease, now ?? new Date().toISOString()) !== "active") {
			applyModeTools();
		}
	}

	/**
	 * P4 status bar: WB:<MODE> | <profile> | <gate>:<status> | run:<id>.
	 * All facts come from the project config and the persisted run records;
	 * missing pieces degrade to shorter lines (mode-only fallback). The
	 * P6-A CACHE segment and the Unreleased COST segment (split
	 * commander/worker/other session cost from session entries) are
	 * appended when they carry valid facts.
	 */
	async function refreshStatus(ctx: ExtensionContext, pendingMessage?: unknown): Promise<void> {
		// No status bar exists in print/json modes; skip silently.
		if (ctx.mode === "print" || ctx.mode === "json") return;
		let line = statusText(mode);
		// P7: commander advisory thresholds — trusted project.yaml
		// commander.advisory, best-effort (defaults on untrusted/error paths).
		let advisoryConfig: AdvisoryConfig | undefined;
		try {
			if (ctx.isProjectTrusted()) {
				const projectRoot = await projectRootFor(ctx);
				const config = await loadProjectConfig(projectRoot, { trusted: true });
				advisoryConfig = config.commanderAdvisory;
				cacheTelemetry.setEnabled(config.cacheTelemetry);
				cacheTelemetry.setProjectRoot(projectRoot);
				const gate = await latestGateRunSummary(projectRoot);
				const runs = await listRuns(projectRoot, 1);
				const latestRun = runs[0];
				line = buildStatusLine({
					mode,
					profile: config.profile,
					activeGate: gate?.worst_gate ? { id: gate.worst_gate.id, status: gate.worst_gate.status, run_id: gate.run_id } : undefined,
					latestRun: latestRun
						? { run_id: latestRun.run_id, status: runStatusLabel(latestRun), ok: runStatusLabel(latestRun) === "OK" }
						: undefined,
				});
			}
		} catch {
			// keep the mode-only fallback line
		}
		// P6-A compact cache segment — only when the data is valid.
		const cacheSegment = cacheTelemetry.statusSegment();
		if (cacheSegment) line = line ? `${line} | ${cacheSegment}` : cacheSegment;
		// Unreleased: split session-cost segment (commander/worker/other) —
		// session-entry facts only, deterministic, O omitted when zero. P7:
		// the SAME current breakdown (pending-message-aware with the existing
		// dedup semantics) drives the observation-only commander advisory
		// segment — CMD:SOFT / CMD:HIGH appended only when triggered, OK adds
		// no segment. Thresholds: trusted config best-effort or defaults.
		const breakdown = buildCostBreakdown(ctx.sessionManager.getEntries(), pendingMessage);
		const costSegment = costStatusSegment(breakdown);
		if (costSegment) line = line ? `${line} | ${costSegment}` : costSegment;
		const advisorySegment = advisoryStatusSegment(evaluateAdvisory(breakdown, advisoryConfig));
		if (advisorySegment) line = line ? `${line} | ${advisorySegment}` : advisorySegment;
		const outputAdvisorySegment = contextOutputAdvisoryStatusSegment(ensureOutputControlTelemetry().snapshot().advisory);
		if (outputAdvisorySegment) line = line ? `${line} | ${outputAdvisorySegment}` : outputAdvisorySegment;
		// P7 write-authority segments: an ACTIVE confirmed lease renders the
		// required compact `WF:LEASE <callsUsed>/<maxCalls>`; locked/pending/
		// expired/exhausted/revoked render `WF:LOCKED`. WF:REVIEW (a review
		// is pending or stale) is appended independently below — it never
		// merges into the lease segment. In-memory facts only — the footer
		// never runs git or touches the disk; the lazy lock sync keeps stale
		// edit/write from ever being advertised.
		syncLeaseLock();
		const actor = detectActorRole({
			roleEnv: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		});
		const policy = defaultWritePolicy(currentModelFacts.provider, currentModelFacts.model);
		const writeSegment = writeAuthorityFooterSegment({
			actor,
			policy,
			lease: writeLease,
			now: new Date().toISOString(),
		});
		if (writeSegment) line = line ? `${line} | ${writeSegment}` : writeSegment;
		if (hasPendingReview(delegationState) || hasStaleReview(delegationState)) {
			line = line ? `${line} | WF:REVIEW` : "WF:REVIEW";
		}
		ctx.ui.setStatus(STATUS_KEY, line);
	}

	/** P6-A: keep the telemetry enable flag in sync with project.yaml (opt-out). */
	async function refreshCacheConfig(ctx: ExtensionContext): Promise<void> {
		try {
			if (!ctx.isProjectTrusted()) {
				cacheTelemetry.setEnabled(false);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const config = await loadProjectConfig(projectRoot, { trusted: true });
			cacheTelemetry.setEnabled(config.cacheTelemetry);
		} catch {
			// default on — telemetry is best-effort and hash-only
			cacheTelemetry.setEnabled(true);
		}
	}

	// ------------------------------------------------------------------ widget

	const WIDGET_KEY = "workbench";
	let widgetForced = false;
	let widgetTask: string | undefined;
	let widgetPhase: string | undefined;

	/** Collect the widget facts (latest gate run + latest run) from disk. */
	async function collectWidgetState(ctx: ExtensionContext): Promise<WidgetState> {
		const state: WidgetState = {
			task: widgetTask,
			phase: widgetPhase,
			taskActive: widgetTask !== undefined,
			gateFailed: false,
			forced: widgetForced,
		};
		try {
			if (!ctx.isProjectTrusted()) return state;
			const projectRoot = await projectRootFor(ctx);
			const gate = await latestGateRunSummary(projectRoot);
			if (gate) {
				state.gateFailed = gate.status !== "PASS";
				state.activeGate = gate.worst_gate
					? `${gate.worst_gate.id} ${gate.worst_gate.status} (run ${gate.run_id})`
					: `all ${gate.status} (run ${gate.run_id})`;
				state.blockingReason = gate.blocking_reason ?? undefined;
			}
			const runs = await listRuns(projectRoot, 1);
			const latest = runs[0];
			if (latest) {
				state.lastRun = `run:${latest.run_id} ${latest.recipe} exit=${latest.exit_code ?? "killed"} ${runStatusLabel(latest)}`;
			}
		} catch {
			// minimal state (task/phase only)
		}
		return state;
	}

	/**
	 * Show/hide the widget per the P4 rules. Never touches the UI without
	 * `ctx.hasUI` (print/json are no-ops).
	 */
	async function refreshWidget(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const state = await collectWidgetState(ctx);
		const action = widgetAction(state, ctx.hasUI);
		if (action === "show") {
			ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(state, { width: 96 }));
		} else if (action === "hide") {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	}

	function setMode(next: WorkbenchMode, ctx: ExtensionContext, label: string): void {
		// P7: leaving DEV revokes any temporary commander write lease (the
		// policy requires revocation on mode change; expiry/exhaustion are
		// statuses that surface through leaseStatus instead).
		if (next !== "DEV" && writeLease) {
			const now = new Date().toISOString();
			const reason = leaseRevokeReason(writeLease, {
				mode: next,
				provider: currentModelFacts.provider,
				model: currentModelFacts.model,
			});
			if (reason) {
				writeLease = revokeLease(writeLease, reason, now);
				persistLease();
			}
		}
		mode = next;
		cacheTelemetry.observeModeChange(next);
		pi.appendEntry(MODE_ENTRY_TYPE, { mode });
		applyModeTools();
		const text = `${label}: ${describeMode(mode)}`;
		if (ctx.hasUI) {
			ctx.ui.notify(text, "info");
		} else {
			// print/json modes: visible stdout fallback.
			console.log(text);
		}
		void refreshStatus(ctx);
	}

	function output(ctx: ExtensionCommandContext, lines: string[]): void {
		const text = lines.join("\n");
		if (ctx.hasUI) {
			ctx.ui.notify(text, "info");
		} else {
			// print/json modes: fall back to stdout so /q-* still works.
			console.log(text);
		}
	}

	function trustedOrError(ctx: ExtensionContext): string | undefined {
		if (!ctx.isProjectTrusted()) {
			return "project is not trusted — workbench will not read or run its configuration. Exit Pi, re-enter the project, and approve project trust first.";
		}
		return undefined;
	}

	async function projectRootFor(ctx: ExtensionContext): Promise<string> {
		return findProjectRoot(ctx.cwd, execFn);
	}

	function runsDirFor(projectRoot: string): string {
		return join(projectRoot, CONFIG_DIR_NAME, "workbench", "runs");
	}

	/**
	 * P7: refresh the delegation state against the REAL git diff, then build
	 * the status lines (actor, policy, lease, latest delegation, review
	 * status, hashes, blocked write attempts, latest review verdict). Any
	 * diff change after REVIEWED turns the delegation STALE here.
	 *
	 * Fail closed: when the real git facts cannot be collected, the
	 * authoritative delegation state stays untouched (no observe, no
	 * persist) and the report VISIBLY marks the real-git refresh
	 * UNAVAILABLE — the persisted hashes are never presented as freshly
	 * verified.
	 */
	async function delegationStatusLines(projectRoot: string): Promise<{ lines: string[]; gitRefresh: "fresh" | "unavailable" }> {
		const now = new Date().toISOString();
		let gitRefresh: "fresh" | "unavailable" = "fresh";
		try {
			const git = await collectGitFacts(projectRoot, execFn);
			const hash = computeDiffHash(git.changedPaths, git.pathDigests, git.pathStatuses);
			delegationState = observeDiffChange(delegationState, hash, now);
			persistDelegationState();
		} catch {
			// Real-git refresh unavailable: the in-memory/persisted
			// authoritative state is left untouched and reported as NOT
			// freshly verified (never silently presented as fresh).
			gitRefresh = "unavailable";
		}
		const actor = detectActorRole({
			roleEnv: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		});
		const policy = defaultWritePolicy(currentModelFacts.provider, currentModelFacts.model);
		const lines = [
			`actor        : ${actor} (${currentModelFacts.provider ?? "(none)"}/${currentModelFacts.model ?? "(none)"})`,
			`write policy : ${policy ?? "not-applicable"}`,
			`write lease  : ${leaseCompactSummary(writeLease, now)}`,
		];
		if (delegationState.latestId !== undefined) {
			lines.push(
				`latest       : ${delegationState.latestId} ${delegationState.status}`,
				`current hash : ${delegationState.currentDiffHash ?? "(none)"}`,
				`reviewed hash: ${delegationState.reviewedDiffHash ?? "(none)"}`,
				`blocked writes: ${delegationState.blockedWriteAttempts}`,
			);
			const block = reviewBlockReason(delegationState, "delegation");
			if (block) lines.push(`blocked      : ${block}`);
			const review = await readReviewRecord(projectRoot, delegationState.latestId);
			if (review) {
				lines.push(
					`review       : ${review.verdict} at ${review.reviewed_at}${review.mismatch ? " (MISMATCH: current diff differs from the recorded after hash)" : ""}`,
					`review bound : ${review.bound_diff_hash}`,
				);
			}
		} else {
			lines.push(`latest       : (no delegation)`);
			lines.push(`blocked writes: ${delegationState.blockedWriteAttempts}`);
		}
		if (gitRefresh === "unavailable") {
			lines.push(`git refresh  : UNAVAILABLE — git status failed; the hashes above are persisted state, NOT freshly verified`);
		}
		return { lines, gitRefresh };
	}

	const TOOL_ERROR_MAX_BYTES = 8_192;
	const TOOL_ERROR_MAX_LINES = 120;
	const TOOL_DEFAULT_MAX_BYTES = 16_384;
	const TOOL_DEFAULT_MAX_LINES = 240;
	const GATE_DETAILS_MAX_ROWS = 24;
	const GATE_DETAILS_MAX_FAILED_CHECKS = 12;

	function boundedInlineDetail(value: unknown, maxBytes = 512): string {
		const clean = (typeof value === "string" ? value : "").replace(/[\x00-\x1f\x7f]/g, " ");
		return clampWholeResultText(clean, { maxBytes, maxLines: 1 }).text;
	}

	function boundedToolText(value: unknown, maxBytes = TOOL_DEFAULT_MAX_BYTES, maxLines = TOOL_DEFAULT_MAX_LINES): string {
		return clampWholeResultText(value, { maxBytes, maxLines }).text;
	}

	function fixedToolFailure(tool: string, code: string, sourcePath?: string): {
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
	} {
		const safeCode = boundedInlineDetail(code, 128) || "runtime_error";
		const text = boundedToolText(`${tool}: ${safeCode}${sourcePath ? ` source=${boundedInlineDetail(sourcePath, 512)}` : ""}`, TOOL_ERROR_MAX_BYTES, TOOL_ERROR_MAX_LINES);
		return { content: [{ type: "text", text }], details: { ok: false, error: safeCode, ...(sourcePath ? { source_path: boundedInlineDetail(sourcePath, 512) } : {}) } };
	}

	function boundedDetailsList(values: readonly string[], maxItems: number, maxItemBytes: number): BoundedStringListDetails {
		const shown = values.slice(0, maxItems).map((value) => boundedInlineDetail(value, maxItemBytes));
		return {
			items: shown,
			original_items: values.length,
			shown_items: shown.length,
			omitted_items: values.length - shown.length,
		};
	}

	function boundedCoverageMap(recipes: readonly { name: string; validation_components: readonly ValidationComponent[] }[]): NonNullable<InspectToolDetails["recipe_validation_components"]> {
		const shown = recipes.slice(0, 24);
		const output: NonNullable<InspectToolDetails["recipe_validation_components"]> = {
			__original_items__: recipes.length,
			__shown_items__: shown.length,
			__omitted_items__: recipes.length - shown.length,
		};
		for (const recipe of shown) {
			let key = boundedInlineDetail(recipe.name, 128) || "(unnamed)";
			let suffix = 1;
			while (Object.prototype.hasOwnProperty.call(output, key)) key = `${boundedInlineDetail(recipe.name, 112)}#${suffix++}`;
			output[key] = recipe.validation_components.slice(0, 16);
		}
		return output;
	}

	function boundedGateDetails(result: Awaited<ReturnType<typeof runGates>>, projectRoot: string): GateToolDetails {
		const nonPass = result.gates.filter((gate) => gate.status !== "PASS");
		const pass = result.gates.filter((gate) => gate.status === "PASS");
		const selected = [...nonPass, ...pass].slice(0, GATE_DETAILS_MAX_ROWS);
		const gates = selected.map((gate) => {
			const failedChecks = gate.checks.filter((check) => check.status === "FAIL").map((check) => check.check_id);
			const shownChecks = failedChecks.slice(0, GATE_DETAILS_MAX_FAILED_CHECKS).map((check) => boundedInlineDetail(check, 128));
			return {
				id: boundedInlineDetail(gate.id, 96),
				status: gate.status,
				title: boundedInlineDetail(gate.title, 256),
				failure_reason: gate.failure_reason ? boundedInlineDetail(gate.failure_reason, 512) : null,
				blocked_reason: gate.blocked_reason ? boundedInlineDetail(gate.blocked_reason, 512) : null,
				failed_checks: shownChecks,
				failed_check_count: failedChecks.length,
				failed_checks_omitted: failedChecks.length - shownChecks.length,
			};
		});
		return {
			ok: result.ok,
			status: result.status,
			run_id: boundedInlineDetail(result.runId, 128),
			requested: result.requested.slice(0, 16).map((selector) => boundedInlineDetail(selector, 128)),
			profile: result.profile ? boundedInlineDetail(result.profile, 128) : undefined,
			gates,
			counts: {
				pass: result.gates.filter((gate) => gate.status === "PASS").length,
				fail: result.gates.filter((gate) => gate.status === "FAIL").length,
				blocked: result.gates.filter((gate) => gate.status === "BLOCKED").length,
				not_run: result.gates.filter((gate) => gate.status === "NOT_RUN").length,
				total: result.gates.length,
				shown: gates.length,
				omitted: result.gates.length - gates.length,
			},
			log_path: boundedInlineDetail(displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs/${result.runId}`), 512),
			phase: "finished",
		};
	}

	function renderGateListPresentation(
		gates: readonly Gate[],
		statuses: Readonly<Record<string, { status: GateStatus; run_id: string }>>,
	): { text: string; shownGates: Gate[] } {
		const maximum = Math.min(gates.length, 24);
		for (let shown = maximum; shown >= 0; shown -= 1) {
			const selected = gates.slice(0, shown);
			const lines = [
				`${gates.length} gate(s) for this project; shown=${shown}; omitted=${gates.length - shown}:`,
				...selected.map((gate) => {
					const latest = statuses[gate.id];
					const status = latest ? `${latest.status} (run ${boundedInlineDetail(latest.run_id, 96)})` : "NOT_RUN (never run)";
					const prereqs = gate.prerequisites.length > 0 ? boundedInlineDetail(gate.prerequisites.join(","), 256) : "(none)";
					return `  ${boundedInlineDetail(gate.id, 96)} ${status} ${boundedInlineDetail(gate.title, 256)} prereqs=${prereqs}`;
				}),
				`omissions: ${gates.length - shown} gate row(s) omitted`,
				"source: .pi/workbench/gates.yaml + builtin ladder",
			];
			const text = lines.join("\n");
			if (Buffer.byteLength(text, "utf8") <= TOOL_DEFAULT_MAX_BYTES && lines.length <= TOOL_DEFAULT_MAX_LINES) {
				return { text, shownGates: [...selected] };
			}
		}
		return { text: "workbench_list_gates: bounded rendering unavailable\nsource: .pi/workbench/gates.yaml + builtin ladder", shownGates: [] };
	}

	function renderGateDefinition(gate: Gate, latestStatus?: GateStatus, latestRunId?: string): string[] {
		const page = renderGateDefinitionPage({ gate, latestStatus, latestRunId, include: "checks", maxLines: 320 });
		return page.text.split("\n");
	}

	// -------------------------------------------------------------- lifecycle

	pi.on("session_start", async (event, ctx) => {
		// Restore the most recent persisted mode and workbench state from the
		// current session's custom entries. Custom entries survive compaction
		// and every session-replacement path (/new, /resume, /fork, /clone,
		// /reload all reach this handler via session_start); /new starts a
		// fresh session file, so it falls back to the DEV default.
		const entries = ctx.sessionManager.getEntries();
		mode = loadModeFromEntries(entries);
		compactState = loadCompactStateFromEntries(entries, mode);
		// P7: restore the delegation review lifecycle and the commander write
		// lease from the same custom entries (they survive compaction and
		// every session-replacement path). The lease is policy-bound: a
		// restored lease is revoked when the current actor/model or mode no
		// longer qualifies.
		delegationState = loadDelegationStateFromEntries(entries);
		writeLease = loadLeaseFromEntries(entries);
		if (ctx.model) currentModelFacts = { provider: ctx.model.provider, model: ctx.model.id };
		// Restore only the latest strict numeric/fixed-enum snapshot for the
		// resolved role. Malformed matching entries reset the accumulator.
		outputControlTelemetry = undefined;
		outputControlTelemetryRole = undefined;
		ensureOutputControlTelemetry(entries);
		mirrorOutputControlCompactFacts();
		if (writeLease) {
			const now = new Date().toISOString();
			const reason = leaseRevokeReason(writeLease, {
				mode,
				provider: currentModelFacts.provider,
				model: currentModelFacts.model,
			});
			if (reason) {
				writeLease = revokeLease(writeLease, reason, now);
				persistLease();
			}
		}
		// P7 slice 3: mirror the restored authority facts into the compaction
		// state (fresh derivation — the mirror never overrides the restored
		// lease/delegation entries, which stay authoritative).
		refreshCompactP7Facts();
		applyModeTools();

		// P6-A: restore the cache telemetry summary and lifecycle reasons.
		const sessionId = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId() ?? ctx.cwd;
		cacheTelemetry.setSessionId(sessionId);
		cacheTelemetry.setMode(mode);
		cacheTelemetry.setThinkingLevel(ctx.thinkingLevel ?? pi.getThinkingLevel());
		cacheTelemetry.restoreFromEntries(entries);
		if (event.reason === "reload") cacheTelemetry.observeReload();
		if (event.reason === "new") cacheTelemetry.observeNewSession();
		if (ctx.model) {
			cacheTelemetry.observeModelChange({ provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api });
		}

		void refreshCacheConfig(ctx);
		void refreshStatus(ctx);
		void refreshWidget(ctx); // a previously failed gate keeps the widget visible
	});

	// ----------------------------------------------------- P5 compaction

	// Never cancels Pi compaction and never replaces its summary — the note
	// only supplements the compacted context with authoritative workbench
	// facts (task, mode, gates, runs, evidence paths, next step, do-not-retry
	// notes). The state entry persists across compaction and session
	// replacement; the hidden custom message (display: false, nextTurn) makes
	// the facts visible to the model without putting any log content into the
	// session context.
	pi.on("session_before_compact", (_event, _ctx) => {
		// Worker role only: a delegated worker must never silently continue
		// through lossy compaction — cancel it and let the runner's pinned
		// budget policy decide the outcome. Commander compaction behavior is
		// unchanged (supplement, never cancel).
		if (workerRoleContext.role === "worker") return { cancel: true };
		cacheTelemetry.observeCompaction();
		if (!shouldSupplement(compactState)) return undefined;
		const note = buildCompactNote(compactState);
		if (note === lastCompactNote) return undefined;
		lastCompactNote = note;
		try {
			pi.appendEntry(COMPACT_STATE_ENTRY_TYPE, compactState);
		} catch {
			// non-interactive context: the in-memory state is still valid
		}
		try {
			pi.sendMessage(
				{
					customType: COMPACT_NOTE_MESSAGE_TYPE,
					content: note,
					display: false,
					details: { updated_at: compactState.updatedAt },
				},
				{ deliverAs: "nextTurn" },
			);
		} catch {
			// print/json modes: the durable state entry above is the fallback
		}
		return undefined;
	});

	// -------------------------------------------------------- widget events

	pi.on("turn_start", (event) => {
		currentTurnSerial = event.turnIndex;
		pendingOutputAuthorizations.clear();
		trustedReadContinuations.clear();
		trustedRunLogContinuations.clear();
		trustedGateContinuations.clear();
		processedNormalResults.clear();
		pendingReceiptHandles.clear();
		turnOutputBudget.startTurn({ turnSerial: event.turnIndex, role: outputTurnRole() });
		ensureOutputControlTelemetry();
	});

	pi.on("turn_end", () => {
		const telemetry = turnOutputBudget.endTurn();
		try {
			pi.appendEntry(OUTPUT_TURN_TELEMETRY_ENTRY_TYPE, {
				role: telemetry.role,
				planning: telemetry.planned ? "planned" : "dynamic",
				turnSerial: telemetry.turnSerial,
				maxBytes: telemetry.maxBytes,
				reservationCount: telemetry.reservationCount,
				blockedCalls: telemetry.blockedCalls,
				consumedCalls: telemetry.consumedCalls,
				releasedCalls: telemetry.releasedCalls,
				reservedBytes: telemetry.reservedBytes,
				consumedBytes: telemetry.consumedBytes,
				controlConsumedBytes: telemetry.controlConsumedBytes,
				totalAccountedBytes: telemetry.totalAccountedBytes,
				releasedBytes: telemetry.releasedBytes,
				unusedBytes: telemetry.unusedBytes,
			});
		} catch {
			// Legacy per-turn observation persistence is best-effort.
		}
		try {
			ensureOutputControlTelemetry().recordTurn(telemetry);
			mirrorOutputControlCompactFacts();
			persistOutputControlTelemetry();
		} catch {
			// Session telemetry persistence is advisory and never breaks closure.
		}
		pendingOutputAuthorizations.clear();
		trustedReadContinuations.clear();
		trustedRunLogContinuations.clear();
		trustedGateContinuations.clear();
		processedNormalResults.clear();
		pendingReceiptHandles.clear();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// P7: lazy lease-lock sync before every agent turn — an
		// expired/exhausted lease is reverted to the exact canonical 15
		// before the model can see stale edit/write tools. No timers or
		// background resources.
		syncLeaseLock();
		// P7 slice 3: keep the compaction mirror fresh at every turn start.
		refreshCompactP7Facts();
		widgetTask = fitToWidth(event.prompt.trim().replace(/\s+/g, " ").slice(0, 120), 96) || "active task";
		widgetPhase = "planning";
		compactState.task = widgetTask;
		compactState.phase = "planning";
		touchCompactState();
		void refreshWidget(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		widgetTask = undefined;
		widgetPhase = undefined;
		compactState.task = undefined;
		compactState.phase = undefined;
		touchCompactState();
		void refreshWidget(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!event.toolName.startsWith("workbench_")) return;
		widgetPhase = `running ${event.toolName}`;
		compactState.phase = widgetPhase;
		touchCompactState();
		void refreshWidget(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!event.toolName.startsWith("workbench_")) return;
		widgetPhase = `finished ${event.toolName}`;
		compactState.phase = widgetPhase;
		const details = (event.result as { details?: unknown } | undefined)?.details;
		if (details && typeof details === "object" && !Array.isArray(details)) {
			const record = details as Record<string, unknown>;
			const runId = typeof record.run_id === "string" ? record.run_id : undefined;
			if (runId) {
				compactState.lastRunId = runId;
				if (typeof record.recipe === "string") compactState.lastRecipe = record.recipe;
				const evidencePath = `.pi/workbench/runs/${runId}`;
				compactState.evidencePaths = pushBounded(compactState.evidencePaths, evidencePath, MAX_EVIDENCE_PATHS);
					if (event.toolName === "workbench_run_gate" && Array.isArray(record.gates)) {
						// R6: tool_execution_end receives the projected, bounded DTO.
						// Consume only its finite status summary; never depend on gates_full
						// or a domain GateRunEntry/check/evidence structure.
						for (const g of (record.gates as Array<{ id?: unknown; status?: unknown }>).slice(0, 32)) {
							const id = typeof g.id === "string" ? g.id : "?";
						if (g.status === "PASS") compactState.passedGates = pushBounded(compactState.passedGates, id, MAX_GATES);
						else if (g.status === "FAIL") compactState.failedGates = pushBounded(compactState.failedGates, `${id} (run ${runId})`, MAX_GATES);
						else if (g.status === "BLOCKED") compactState.blockedGates = pushBounded(compactState.blockedGates, `${id} (run ${runId})`, MAX_GATES);
					}
				}
				rememberRunOutcome(event.toolName, record);
			}
		}
		touchCompactState();
		void refreshStatus(ctx);
		void refreshWidget(ctx);
	});

	// ------------------------------------------------------- P6-A cache events

	// Model/thinking/mode changes are the strongest (explicit) invalidation
	// signals; the next message_end classifies them as such.
	pi.on("model_select", (event) => {
		cacheTelemetry.observeModelChange({ provider: event.model.provider, id: event.model.id, api: event.model.api });
		// P7: the actor identity (and with it the strict Sol DEV tool set and
		// the write lease validity) follows the provider/model pair — update
		// the facts, revoke a lease bound to a different commander identity,
		// and recompute the active tool set.
		currentModelFacts = { provider: event.model.provider, model: event.model.id };
		if (writeLease) {
			const now = new Date().toISOString();
			const reason = leaseRevokeReason(writeLease, {
				mode,
				provider: currentModelFacts.provider,
				model: currentModelFacts.model,
			});
			if (reason) {
				writeLease = revokeLease(writeLease, reason, now);
				persistLease();
			}
		}
		applyModeTools();
	});

	pi.on("thinking_level_select", (event) => {
		cacheTelemetry.observeThinkingChange(event.level);
	});

	// Pi 0.83 calls `context` before constructing every provider request. It
	// structured-clones the active messages first, so this replacement affects
	// only the outgoing copy and can never rewrite session entries. The handler
	// catches its own failures because Pi otherwise swallows an extension error
	// and continues with the unprojected (raw) context.
	pi.on("context", (event) => {
		const role = outputTurnRole();
		const maxToolTextBytes = role === "commander"
			? COMMANDER_HISTORY_TOOL_TEXT_MAX_BYTES
			: role === "worker"
				? WORKER_HISTORY_TOOL_TEXT_MAX_BYTES
				: OTHER_HISTORY_TOOL_TEXT_MAX_BYTES;
		try {
			const projection = projectContextHistory({
				messages: event.messages,
				maxToolTextBytes,
				maxBundles: HISTORY_MAX_BUNDLES,
				descriptorMaxBytes: HISTORY_DESCRIPTOR_MAX_BYTES,
				role,
			});
			latestHistoryProjectionFacts = { ...projection.facts };
			ensureOutputControlTelemetry().recordHistory(projection.facts, role);
			mirrorOutputControlCompactFacts();
			return { messages: projection.messages };
		} catch {
			const messages = historyProjectionFailureMessages(
				event.messages,
				maxToolTextBytes,
				HISTORY_DESCRIPTOR_MAX_BYTES,
			);
			latestHistoryProjectionFacts = {
				originalToolTextBytes: 0,
				finalToolTextBytes: historyToolTextBytes(messages),
				collapsedResults: 0,
				removedBundles: 0,
				protectedLatestBundles: 0,
			};
			ensureOutputControlTelemetry().recordHistory(latestHistoryProjectionFacts, role);
			mirrorOutputControlCompactFacts();
			return { messages };
		}
	});

	// READ-ONLY structural peek: the payload is never replaced, mutated or
	// stored — only a structural digest (roles, lengths, per-segment hashes,
	// tool names) is kept in memory for contextShapeHash classification.
	pi.on("before_provider_request", (event) => {
		cacheTelemetry.observePayload(event.payload);
		return undefined;
	});

	// The first message_end handler plans assistant batches before Pi starts
	// any tool, and owns every immediate toolResult path that bypasses
	// tool_result middleware (unknown tool, validation failure, guard block,
	// abort, or length-stop). It is registered before telemetry/persistence
	// observers and never creates/finalizes a receipt.
	pi.on("message_end", (event) => {
		const messageValue = event.message as unknown;
		const calls = assistantToolCalls(messageValue);
		if (calls !== undefined) {
			const plan = planTurnOutputBudget({
				turnSerial: currentTurnSerial,
				role: outputTurnRole(),
				calls,
			});
			turnOutputBudget.installPlan(plan);
			pendingOutputAuthorizations.clear();
			return undefined;
		}
		if (ownDataValue(messageValue, "role") !== "toolResult") return undefined;

		const toolCallIdValue = ownDataValue(messageValue, "toolCallId");
		const toolNameValue = ownDataValue(messageValue, "toolName");
		const toolCallId = typeof toolCallIdValue === "string" ? toolCallIdValue : "";
		const toolName = typeof toolNameValue === "string" ? toolNameValue : "";
		// Never trust caller-supplied output_envelope/receipt facts as proof of
		// processing. Only this private, exact FIFO marker can bypass immediate
		// result accounting after the normal tool_result middleware path.
		if (takeProcessedNormalResult(toolCallId, toolName)) return undefined;
		let authorization = takeOutputAuthorization(toolCallId, toolName);
		try {
			const content = ownDataValue(messageValue, "content");
			const details = ownDataValue(messageValue, "details");
			const role = outputTurnRole();
			authorization ??= authorizeOutput(toolCallId, toolName, undefined);
			pendingReceiptHandles.delete(toolCallId);
			const policy = resolveToolOutputPolicy({ toolName, args: undefined, role });
			let envelope: OutputEnvelopeResult;
			if (!authorization.authorizationId) {
				envelope = enforceOutputEnvelope({
					toolName,
					content: [],
					isError: true,
					policy,
					allocatedBytes: 0,
				});
			} else if (!authorization.allowed) {
				const controlText = authorization.controlAllocatedBytes > 0
					? authorization.controlText ?? blockedControlText(authorization.blockCode ?? "turn_output_budget")
					: "";
				envelope = enforceOutputEnvelope({
					toolName,
					content: controlText ? [{ type: "text", text: controlText }] : [],
					isError: true,
					policy,
					allocatedBytes: authorization.controlAllocatedBytes,
				});
				const accounting = turnOutputBudget.accountImmediate({
					authorizationId: authorization.authorizationId,
					actualBytes: envelope.facts.shownTextBytes,
				});
				if (!accounting.accepted) {
					envelope = enforceOutputEnvelope({ toolName, content: [], isError: true, policy, allocatedBytes: 0 });
				}
			} else {
				envelope = enforceOutputEnvelope({
					toolName,
					content: content as RuntimeOutputContent,
					isError: true,
					policy,
					allocatedBytes: authorization.allocatedBytes,
				});
				const accounting = turnOutputBudget.accountImmediate({
					authorizationId: authorization.authorizationId,
					actualBytes: envelope.facts.shownTextBytes,
				});
				if (!accounting.accepted) {
					envelope = enforceOutputEnvelope({ toolName, content: [], isError: true, policy, allocatedBytes: 0 });
				}
			}
			const projectedDetails = projectToolResultDetails({
				toolName,
				details,
				envelope: envelope.facts,
			}).details;
			observeOutputEnvelope(toolName, envelope.facts);
			const replacement = {
				...(messageValue as Record<string, unknown>),
				content: envelope.content,
				details: projectedDetails,
				isError: true,
			};
			return { message: replacement as never };
		} catch {
			if (authorization?.authorizationId) {
				turnOutputBudget.accountImmediate({ authorizationId: authorization.authorizationId, actualBytes: 0 });
			}
			pendingReceiptHandles.delete(toolCallId);
			const policy = resolveToolOutputPolicy({ toolName, args: undefined, role: outputTurnRole() });
			const envelope = enforceOutputEnvelope({ toolName, content: [], isError: true, policy, allocatedBytes: 0 });
			observeOutputEnvelope(toolName || "unknown", envelope.facts);
			const timestampValue = ownDataValue(messageValue, "timestamp");
			return {
				message: {
					role: "toolResult",
					toolCallId: toolCallId || "unknown",
					toolName: toolName || "unknown",
					content: envelope.content,
					details: projectToolResultDetails({
						toolName: toolName || "unknown",
						details: undefined,
						envelope: envelope.facts,
					}).details,
					isError: true,
					timestamp: typeof timestampValue === "number" && Number.isFinite(timestampValue) ? timestampValue : 0,
				} as never,
			};
		}
	});

	// message_end records telemetry for ASSISTANT messages and refreshes cost
	// status for assistant/tool-result usage. All work is wrapped so a failure
	// can never block, delay or alter the request.
	pi.on("message_end", async (event, ctx) => {
		const message = event.message as {
			provider?: string;
			model?: string;
			api?: string;
			usage?: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				totalTokens: number;
				cost: { total: number };
			};
			stopReason?: string;
			errorMessage?: string;
		};
		if (event.message.role === "assistant") {
			try {
				// Telemetry is best-effort and must never block or alter the request.
				if (ctx.isProjectTrusted()) {
					const projectRoot = await projectRootFor(ctx);
					cacheTelemetry.setProjectRoot(projectRoot);
					if (message.usage) {
						await cacheTelemetry.observeMessageEnd({
							provider: message.provider ?? "unknown",
							model: message.model ?? "unknown",
							apiKind: typeof message.api === "string" ? message.api : ctx.model?.api ?? null,
							usage: message.usage,
							stopReason: message.stopReason,
							errorMessage: message.errorMessage,
							thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
							systemPrompt: ctx.getSystemPrompt(),
							activeToolNames: pi.getActiveTools(),
							tools: pi.getAllTools().map((t) => ({
								name: t.name,
								description: t.description,
								promptSnippet: (t as { promptSnippet?: string }).promptSnippet,
								parameters: t.parameters,
								promptGuidelines: t.promptGuidelines,
							})),
						});
					}
				}
			} catch {
				// telemetry must never break a model request
			}
			// Worker role only, one-shot: at/above the 80% soft budget, send one
			// hidden steer telling the worker to stop new implementation, finish a
			// concise handoff, and list the remaining work. The commander session
			// never receives this steer.
			if (workerRoleContext.role === "worker" && !workerSoftSteerSent) {
				try {
					const contextTokens = workerContextTokens(message.usage);
					if (workerBudgetBand(contextTokens) !== "ok") {
						pi.sendMessage(
							{
								customType: WORKER_SOFT_STEER_MESSAGE_TYPE,
								content: WORKER_SOFT_STEER_TEXT,
								display: false,
								details: {
									context_tokens: contextTokens,
									budget: WORKER_MODEL_CONTEXT_TOKENS,
									soft: WORKER_SOFT_BUDGET,
									hard: WORKER_HARD_BUDGET,
								},
							},
							{ deliverAs: "steer" },
						);
						workerSoftSteerSent = true;
					}
				} catch {
					// a steer must never break a model request
				}
			}
			// Phase 2 cumulative spend accounting (worker role only, independent
			// of the context steer above): every assistant message_end increments
			// the independent spend state exactly once via the pure policy
			// (malformed usage contributes zero but still counts the turn — never
			// NaN). When the cumulative band FIRST becomes soft or hard, send
			// exactly ONE hidden steer (its own flag — independent of the context
			// steer flag), naming the profile and the triggered dimension(s) in
			// the fixed reason order with current/limit values. The commander
			// session never receives it; a send failure is swallowed and never
			// breaks a model request.
			if (workerRoleContext.role === "worker") {
				try {
					workerSpendState = addWorkerSpendUsage(workerSpendState, message.usage);
					if (!workerSpendSoftSteerSent && workerSpendBand(workerSpendState, workerRoleContext.spendProfile) !== "ok") {
						pi.sendMessage(
							{
								customType: WORKER_SPEND_SOFT_STEER_MESSAGE_TYPE,
								content: formatWorkerSpendSteerText(workerSpendState, workerRoleContext.spendProfile),
								display: false,
								details: {
									profile: workerRoleContext.spendProfile,
									band: workerSpendBand(workerSpendState, workerRoleContext.spendProfile),
									reasons: workerSpendReasons(workerSpendState, workerRoleContext.spendProfile),
									turns: workerSpendState.turns,
									total_tokens: workerSpendState.totalTokens,
									output_tokens: workerSpendState.outputTokens,
								},
							},
							{ deliverAs: "steer" },
						);
						workerSpendSoftSteerSent = true;
					}
				} catch {
					// a spend steer must never break a model request
				}
			}
		}
		// Pi 0.83 persists message_end after extension handlers. Include this
		// pending assistant/tool-result message exactly once so COST is current
		// immediately; buildCostBreakdown deduplicates if persistence ordering
		// changes in a future compatible Pi version.
		try {
			await refreshStatus(ctx, event.message);
		} catch {
			// a status refresh must never break a model request
		}
		return undefined;
	});

	// Safe flush: persist the session state entry (append-only JSONL records
	// are already written per request; nothing is buffered here).
	pi.on("session_shutdown", () => {
		cacheTelemetry.flush();
		// P7: a commander write lease never outlives its session.
		if (writeLease) {
			const now = new Date().toISOString();
			const reason = leaseRevokeReason(writeLease, { mode, sessionEnded: true });
			if (reason) {
				writeLease = revokeLease(writeLease, reason, now);
				persistLease();
				// Reapply the locked tool set (back to the exact canonical 15).
				applyModeTools();
			}
		}
	});

	// --------------------------------------------------------------- commands

	pi.registerCommand("q-mode-audit", {
		description: "Switch workbench to AUDIT mode (read-only: read, grep, find, ls, workbench_project_inspect, workbench_read_run)",
		handler: async (_args, ctx) => setMode("AUDIT", ctx, "AUDIT mode"),
	});

	pi.registerCommand("q-mode-dev", {
		description: "Switch workbench to DEV mode (full local development tools)",
		handler: async (_args, ctx) => setMode("DEV", ctx, "DEV mode"),
	});

	pi.registerCommand("q-mode-verify", {
		description:
			"Switch workbench to VERIFY mode (read, grep, find, ls, workbench tools; no free bash/edit/write — declared recipes only)",
		handler: async (_args, ctx) => {
			// P7: a pending or stale review blocks VERIFY (final gate
			// verification) until the current worker diff is reviewed — never
			// falls back.
			if (blocksVerify(delegationState)) {
				output(ctx, [`/q-mode-verify: ${reviewBlockReason(delegationState, "verify")}`]);
				return;
			}
			setMode("VERIFY", ctx, "VERIFY mode");
		},
	});

	pi.registerCommand("q-status", {
		description: "Show workbench mode, cwd, project trust, active tools, and workbench tools",
		handler: async (_args, ctx) => {
			// P7: lazy lease-lock sync — the /q-status facts are never stale.
			syncLeaseLock();
			const trust = ctx.isProjectTrusted() ? "trusted" : "not trusted";
			const workbenchTools = pi
				.getAllTools()
				.map((t) => t.name)
				.filter((name) => name.startsWith("workbench_"));
			const lines = [
				`workbench mode : ${mode} — ${describeMode(mode)}`,
				`cwd            : ${ctx.cwd}`,
				`project trust  : ${trust}`,
				`active tools   : ${pi.getActiveTools().join(", ") || "(none)"}`,
				`mode tool set  : ${MODE_TOOLS[mode].join(", ")}`,
				`workbench tools: ${workbenchTools.length > 0 ? workbenchTools.join(", ") : "(none registered)"}`,
				`agent role     : ${workerRoleContext.role ?? "commander"}`,
				`actor identity : ${detectActorRole({ roleEnv: workerRoleContext.role, provider: currentModelFacts.provider, model: currentModelFacts.model })} (${currentModelFacts.provider ?? "(none)"}/${currentModelFacts.model ?? "(none)"})`,
				`write policy   : ${defaultWritePolicy(currentModelFacts.provider, currentModelFacts.model) ?? "not-applicable"}`,
				`write lease    : ${leaseCompactSummary(writeLease, new Date().toISOString())}`,
				`delegation     : ${delegationCompactSummary(delegationState)}`,
				`path policy    : write .env/.pem/.key/credentials.*/secrets.*/auth.json blocked in all modes; read blocked in AUDIT/VERIFY, allowed in DEV`,
				`command guard  : rm -rf / or ~, git reset --hard, git clean -fd, git push --force, git checkout -- ., git restore ., git remote changes, rm .git, git config --global writes, sudo, npm/yarn/pnpm/bun publish`,
			];
			// P7 bounded-handoff diagnostics: visibly flag the single-huge-recent-
			// turn hazard (a delegation tool-result turn too large for safe
			// context compaction) with the exact CONTEXT RISK line.
			const contextRisk = delegationContextRiskLine(ctx.sessionManager.getEntries());
			if (contextRisk) lines.push(contextRisk);
			output(ctx, lines);
		},
	});

	// ------------------------------------------------------ /q-cost-status

	pi.registerCommand("q-cost-status", {
		description:
			"Show the split session cost breakdown from session entries: commander (assistant usage), worker (workbench_delegate_worker tool results), other (tools/summaries), total, per-model commander costs, and the P7 commander advisory facts (observation-only — never a hard stop)",
		handler: async (_args, ctx) => {
			// Session facts only — no project config, no trust gate; works in
			// TUI and print/json modes through the shared output helper. P7:
			// the advisory facts append additively; the trusted project.yaml
			// commander.advisory thresholds are loaded best-effort and the
			// command NEVER becomes trust-gated (defaults on untrusted /
			// unavailable / error paths).
			const breakdown = buildCostBreakdown(ctx.sessionManager.getEntries());
			let advisoryConfig: AdvisoryConfig | undefined;
			try {
				if (ctx.isProjectTrusted()) {
					const projectRoot = await projectRootFor(ctx);
					advisoryConfig = (await loadProjectConfig(projectRoot, { trusted: true })).commanderAdvisory;
				}
			} catch {
				// defaults — the advisory section is never trust-gated
			}
			const facts = evaluateAdvisory(breakdown, advisoryConfig);
			output(ctx, [...renderCostBreakdown(breakdown), "", ...renderAdvisoryFacts(facts)]);
		},
	});

	// ------------------------------------------- /q-context-output-status

	pi.registerCommand("q-context-output-status", {
		description:
			"Show numeric-only context-output observations; optional exact subcommand: json (observation-only, never enforcement)",
		handler: async (args, ctx) => {
			const format = typeof args === "string" ? args.trim() : "";
			if (format !== "" && format !== "json") {
				output(ctx, ["usage: /q-context-output-status [json]"]);
				return;
			}
			const snapshot = ensureOutputControlTelemetry().snapshot();
			output(ctx, renderOutputControlStatus(snapshot, format === "json" ? "json" : "text").split("\n"));
		},
	});

	// ------------------------------------------------------ /q-delegation-status

	pi.registerCommand("q-delegation-status", {
		description:
			"Show write-authority and delegation review status: actor, write policy, lease, latest delegation, review status, current/reviewed diff hashes, blocked write attempts, latest review verdict (refreshes against the real git diff — any change after REVIEWED turns the delegation STALE)",
		handler: async (_args, ctx) => {
			// P7: lazy lease-lock sync — the reported lease state is never stale.
			syncLeaseLock();
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-delegation-status: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const status = await delegationStatusLines(projectRoot);
			// P7 bounded-handoff diagnostics: same exact CONTEXT RISK line as
			// /q-status when the latest delegation tool-result turn is detected
			// too large for safe context compaction.
			const contextRisk = delegationContextRiskLine(ctx.sessionManager.getEntries());
			output(ctx, contextRisk ? [...status.lines, contextRisk] : status.lines);
			void refreshStatus(ctx);
		},
	});

	// ------------------------------------------- P7 lease slash commands

	pi.registerCommand("q-write-policy", {
		description:
			"Show the P7 write policy status: /q-write-policy status (actor, fixed worker-first-strict policy, direct-write lock/lease status, bounded active/pending lease summary — never any confirmation token)",
		handler: async (args, ctx) => {
			// The command accepts exactly the trimmed `status` subcommand;
			// other/missing arguments print usage and alter no state.
			const parsed = parseWritePolicyArgs(args);
			if (!parsed.ok) {
				output(ctx, [`/q-write-policy: ${parsed.error}`]);
				return;
			}
			syncLeaseLock();
			const now = new Date().toISOString();
			const actor = detectActorRole({
				roleEnv: workerRoleContext.role,
				provider: currentModelFacts.provider,
				model: currentModelFacts.model,
			});
			const policy = defaultWritePolicy(currentModelFacts.provider, currentModelFacts.model);
			output(
				ctx,
				renderWritePolicyStatus({
					actor,
					provider: currentModelFacts.provider,
					model: currentModelFacts.model,
					policy,
					lease: writeLease,
					now,
				}),
			);
		},
	});

	pi.registerCommand("q-commander-write-unlock", {
		description:
			"Temporary commander write lease (Sol + DEV + worker-first-strict only): /q-commander-write-unlock <reason> --paths <comma-list> --calls <N> --minutes <N> (reasons: bootstrap-policy|worker-unavailable|security-emergency|user-directed; TUI asks for explicit confirmation, non-TUI issues two token parts and confirms via /q-commander-write-unlock confirm <partA> <partB>)",
		handler: async (args, ctx) => {
			const now = new Date().toISOString();
			// P7: lazy lease-lock sync — an expired/exhausted lease is
			// reverted to the exact canonical 15 before any lease logic runs.
			syncLeaseLock(now);
			// Only the approved GPT-5.6 Sol commander under the fixed
			// worker-first-strict policy may unlock, and only in DEV mode
			// (leases never outlive DEV; leaving DEV revokes them).
			const actor = detectActorRole({
				roleEnv: workerRoleContext.role,
				provider: currentModelFacts.provider,
				model: currentModelFacts.model,
			});
			const policy = defaultWritePolicy(currentModelFacts.provider, currentModelFacts.model);
			if (actor !== "sol-commander" || policy !== "worker-first-strict") {
				output(ctx, [
					`/q-commander-write-unlock: refused — only GPT-5.6 Sol on an approved provider under the fixed worker-first-strict policy may unlock (current actor: ${actor}, policy: ${policy ?? "not-applicable"})`,
				]);
				return;
			}
			if (mode !== "DEV") {
				output(ctx, [
					`/q-commander-write-unlock: refused — write leases exist only in DEV mode (current mode: ${mode}); leaving DEV revokes any lease`,
				]);
				return;
			}
			const parsed = parseUnlockArgs(args);
			if (!parsed.ok) {
				output(ctx, [`/q-commander-write-unlock: ${parsed.error}`, UNLOCK_USAGE]);
				return;
			}
			if (parsed.kind === "confirm") {
				if (!writeLease) {
					output(ctx, [
						`/q-commander-write-unlock: no pending lease to confirm — issue one first (${UNLOCK_USAGE})`,
					]);
					return;
				}
				if (parsed.leaseId !== undefined && parsed.leaseId !== writeLease.id) {
					output(ctx, [`/q-commander-write-unlock: lease id mismatch — the pending lease is "${writeLease.id}"`]);
					return;
				}
				const status = leaseStatus(writeLease, now);
				if (status !== "pending") {
					output(ctx, [`/q-commander-write-unlock: lease ${writeLease.id} is ${status}, not pending — it cannot be confirmed now`]);
					return;
				}
				const confirmed = confirmLease(writeLease, parsed.partA, parsed.partB, now);
				if (!confirmed.ok) {
					output(ctx, [`/q-commander-write-unlock: ${confirmed.error} — the lease stays locked`]);
					return;
				}
				writeLease = confirmed.lease;
				persistLease();
				applyModeTools();
				output(ctx, renderLeaseConfirmed(writeLease, now));
				void refreshStatus(ctx);
				return;
			}
			// Issuance. A pending or active lease must be confirmed or locked
			// first; terminal leases (expired/exhausted/revoked) may be replaced.
			const existingStatus = writeLease ? leaseStatus(writeLease, now) : "locked";
			if (existingStatus === "pending") {
				output(ctx, [
					`/q-commander-write-unlock: lease ${writeLease!.id} is already pending confirmation — confirm it or run /q-commander-write-lock first`,
				]);
				return;
			}
			if (existingStatus === "active") {
				output(ctx, [
					`/q-commander-write-unlock: lease ${writeLease!.id} is already active — run /q-commander-write-lock first to replace it`,
				]);
				return;
			}
			const leaseId = makeLeaseId(now);
			const tokens = newConfirmationParts();
			const issued = issueLease({
				id: leaseId,
				reason: parsed.reason,
				paths: parsed.paths,
				maxCalls: parsed.calls,
				durationMs: parsed.minutes * 60_000,
				confirmationTokenA: tokens.partA,
				confirmationTokenB: tokens.partB,
				now,
			});
			if (!issued.ok) {
				output(ctx, [`/q-commander-write-unlock: ${issued.error}`]);
				return;
			}
			if (ctx.mode === "tui") {
				// Real TUI only: every scope/reason/calls/expiry fact is shown
				// and an explicit human confirmation is required; cancel leaves
				// the lease locked (nothing issued, nothing persisted).
				// RPC/print/json are NON-TUI — they use the pending two-part
				// token flow even though RPC contexts carry hasUI.
				const preview = renderUnlockPreview({
					leaseId,
					reason: parsed.reason,
					paths: parsed.paths,
					calls: parsed.calls,
					minutes: parsed.minutes,
					now,
				});
				const yes = await ctx.ui.confirm("Grant temporary commander write lease?", preview.join("\n"));
				if (!yes) {
					output(ctx, [
						"/q-commander-write-unlock: canceled — no lease issued (write authority stays locked)",
					]);
					return;
				}
				// The human TUI confirmation IS the confirmation: activate
				// immediately with the freshly generated parts (never displayed).
				const confirmed = confirmLease(issued.lease, tokens.partA, tokens.partB, now);
				if (!confirmed.ok) {
					output(ctx, [`/q-commander-write-unlock: ${confirmed.error}`]);
					return;
				}
				writeLease = confirmed.lease;
				persistLease();
				applyModeTools();
				output(ctx, renderLeaseConfirmed(writeLease, now));
			} else {
				// Non-TUI (print/json/RPC without a terminal): create the PENDING
				// lease and visibly emit the two distinct bounded token parts;
				// the SAME command confirms later with both exact parts. The
				// pending lease enables nothing yet (still exactly 14 tools).
				writeLease = issued.lease;
				persistLease();
				applyModeTools();
				output(ctx, renderLeaseIssued(writeLease, now));
			}
			void refreshStatus(ctx);
		},
	});

	pi.registerCommand("q-commander-write-lock", {
		description:
			"Explicitly revoke/lock the temporary commander write lease and persist the audit facts (edit/write return to the canonical 15-tool strict Sol DEV set)",
		handler: async (_args, ctx) => {
			const now = new Date().toISOString();
			// P7: lazy lease-lock sync — the lock reflects the true state.
			syncLeaseLock();
			if (writeLease) {
				writeLease = revokeLease(writeLease, "user-directed lock via /q-commander-write-lock", now);
				persistLease();
			}
			applyModeTools();
			output(ctx, [
				writeLease
					? `/q-commander-write-lock: lease ${writeLease.id} revoked (${writeLease.revokedReason}) — commander edit/write is blocked until a new user-issued lease is confirmed`
					: "/q-commander-write-lock: already locked (no lease) — commander edit/write is blocked",
				leaseCompactSummary(writeLease, now),
			]);
			void refreshStatus(ctx);
		},
	});

	// ------------------------------------------------ P5 milestone handoff

	pi.registerCommand("q-milestone-handoff", {
		description:
			"USER-ONLY milestone handoff: /q-milestone-handoff <next step> — waits for idle, persists a bounded/redacted prepared milestone record in the current session, then starts a fresh parent-linked session that resumes the same mode/compact/delegation state with a hidden pointer-only note (commander write leases are NEVER carried — the target stays locked; no model/provider call and no agent turn)",
		handler: async (args, ctx) => {
			// The milestone handoff is a user-only session-lifecycle command:
			// a delegated worker can never start a session replacement. Refusal
			// happens FIRST, with no state touched and no entry appended.
			if (workerRoleContext.role === "worker") {
				output(ctx, [
					"/q-milestone-handoff: refused — this command is user-only; a delegated worker cannot start a milestone handoff",
				]);
				return;
			}
			// Reject empty/overlong next steps BEFORE anything else happens
			// (no state is touched on a parse failure).
			const parsed = parseNextStepArg(args);
			if (!parsed.ok) {
				output(ctx, [`/q-milestone-handoff: ${parsed.error}`, milestoneHandoffUsage()]);
				return;
			}
			// Wait for any in-flight agent work to finish before touching the
			// session (a handoff mid-turn would lose the running turn).
			await ctx.waitForIdle();
			// A milestone handoff needs a persisted source session file: the
			// prepared record and the parent link both point at it.
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				output(ctx, [
					"/q-milestone-handoff: refused — the current session is not persisted yet (wait for the first assistant response before handing off)",
				]);
				return;
			}
			// P7: refresh the compaction mirror so the snapshot carries the
			// current worker-first facts. Everything the target needs is
			// CAPTURED here, BEFORE newSession: Pi fires session_start("new")
			// BEFORE setup, which would otherwise reset the in-memory mode/
			// compact/delegation state to the fresh session's defaults before
			// setup runs.
			refreshCompactP7Facts();
			const now = new Date().toISOString();
			const record = prepareMilestoneHandoff({
				milestoneId: makeMilestoneId(new Date()),
				nextStep: parsed.nextStep,
				session: sessionFile,
				state: compactState,
				secrets,
				now,
			});
			const sourceMode = mode;
			const sourceDelegation = serializeDelegationState(delegationState);
			const sourceDelegationSummary = delegationCompactSummary(delegationState);
			// Persist-first: the additive prepared record lands in the SOURCE
			// session before any replacement is attempted.
			pi.appendEntry(MILESTONE_HANDOFF_ENTRY_TYPE, record);
			const outcome = await ctx.newSession({
				parentSession: sessionFile,
				setup: async (sessionManager) => {
					// Additive target records (schema v1, same custom types as
					// the source). session_start("new") already ran BEFORE setup
					// against the empty fresh session, so withSession reloads
					// afterwards to restore these entries into the running
					// session before the user continues.
					const resumed = toResumedRecord(record, new Date().toISOString());
					sessionManager.appendCustomEntry(MILESTONE_HANDOFF_ENTRY_TYPE, resumed);
					sessionManager.appendCustomMessageEntry(
						MILESTONE_HANDOFF_NOTE_ENTRY_TYPE,
						buildMilestoneHandoffNote(resumed),
						false,
						{ milestone_id: resumed.milestone_id, lifecycle: "resumed", updated_at: resumed.updated_at },
					);
					sessionManager.appendCustomEntry(MODE_ENTRY_TYPE, { mode: sourceMode });
					sessionManager.appendCustomEntry(COMPACT_STATE_ENTRY_TYPE, record.state);
					sessionManager.appendCustomEntry(DELEGATION_STATE_ENTRY_TYPE, sourceDelegation);
					// Deliberately NO write-lease entry: the target write
					// authority stays locked even when the source held an
					// active/pending lease.
				},
				withSession: async (replacementCtx) => {
					// Use ONLY the replacement context here — the captured
					// command ctx and pi are stale after the switch. Announce
					// success visibly, then reload: reload re-fires
					// session_start, which restores the setup-appended entries
					// (mode/compact/delegation/note) before the user continues.
					output(replacementCtx, [
						`/q-milestone-handoff: milestone ${record.milestone_id} handed off to a fresh parent-linked session`,
						`next step   : ${record.next_step}`,
						`source      : ${record.session}`,
						`mode        : ${record.state?.mode ?? sourceMode}`,
						`delegation  : ${sourceDelegationSummary}`,
						"write lease : NOT carried — target commander writes stay locked",
						"hidden milestone note injected (pointers/status only); reloading to restore copied state…",
					]);
					await replacementCtx.reload();
				},
			});
			if (outcome.cancelled) {
				// The replacement was cancelled while the source session remains
				// valid: record the cancellation additively in the source and
				// report — nothing was replaced and no setup ran.
				pi.appendEntry(MILESTONE_HANDOFF_ENTRY_TYPE, toCancelledRecord(record, new Date().toISOString()));
				output(ctx, [
					`/q-milestone-handoff: cancelled — no new session was started; the current session is unchanged (cancellation recorded for milestone ${record.milestone_id})`,
				]);
				return;
			}
			// Success: the session was replaced. The old ctx/pi must not be
			// used anymore, so nothing further happens here.
		},
	});

	// ------------------------------------------------------------ /q-init

	pi.registerCommand("q-init", {
		description:
			"Initialize .pi/workbench configuration for a profile: generic | quant-research/stock-selection | quant-research/market-timing",
		handler: async (args, ctx) => {
			const profile = args.trim().split(/\s+/)[0] ?? "";
			if (!isSupportedInitProfile(profile)) {
				output(ctx, [
					`/q-init: unsupported profile "${profile || "(empty)"}"`,
					`supported profiles: ${INIT_PROFILES.join(", ")}`,
					"unsupported (by design): hft, market-making, lob, execution-engine",
				]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-init: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const exists = async (p: string): Promise<boolean> => access(p).then(() => true, () => false);

			// Phase 1: display what will be written, BEFORE touching the disk.
			const preview = await planInit(projectRoot, profile, { exists, confirmOverwrite: async () => false });
			output(ctx, [...renderInitPlan(preview, CONFIG_DIR_NAME), ""]);

			// Phase 2: overwrites require per-file confirmation (only when a
			// dialog UI exists; otherwise existing files are never touched).
			const overwrite = new Set<string>();
			if (ctx.hasUI) {
				for (const entry of preview.entries) {
					if (entry.action !== "skip") continue;
					const yes = await ctx.ui.confirm("Overwrite?", `${CONFIG_DIR_NAME}/workbench/${entry.file} already exists. Overwrite it?`);
					if (yes) overwrite.add(entry.file);
				}
			}

			// Phase 3: apply.
			const plan = await planInit(projectRoot, profile, { exists, confirmOverwrite: async (file) => overwrite.has(file) });
			await applyInit(plan, {
				exists,
				write: async (path, content) => {
					await mkdir(dirname(path), { recursive: true });
					await writeFile(path, content, "utf8");
				},
			});
			const written = plan.entries.filter((e) => e.action !== "skip").length;
			const skipped = plan.entries.filter((e) => e.action === "skip").length;
			const lines = [
				`Workbench initialized for profile "${profile}" in ${projectRoot}`,
				`${written} file(s) written, ${skipped} existing file(s) left untouched`,
				"",
				"Next steps:",
				"  1. Exit Pi",
				"  2. Re-enter the project directory",
				"  3. Approve project trust when prompted (project config is only read under trust)",
				"",
				`Config files live in ${CONFIG_DIR_NAME}/workbench/ (project.yaml, recipes.yaml, gates.yaml, profiles.yaml).`,
				"AGENTS.md (project root) was selected from the profile's AGENTS template.",
				"Existing files, including an existing AGENTS.md, are never overwritten by default.",
				"Add declarative recipes to recipes.yaml — the workbench only runs declared commands.",
			];
			output(ctx, lines);
		},
	});

	// ------------------------------------------------------------ /q-run

	function parseRunArgs(args: string): { recipe: string; params: Record<string, unknown>; cacheMode: CacheRequestMode } {
		let cacheMode: CacheRequestMode = "default";
		const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0 && !t.startsWith("--"));
		const flags = args.trim().split(/\s+/).filter((t) => t.startsWith("--"));
		if (flags.includes("--no-cache")) cacheMode = "no-cache";
		if (flags.includes("--refresh-cache")) cacheMode = "refresh-cache";
		const recipe = tokens[0] ?? "";
		const params: Record<string, unknown> = {};
		for (const token of tokens.slice(1)) {
			const eq = token.indexOf("=");
			if (eq <= 0) continue;
			const key = token.slice(0, eq);
			const raw = token.slice(eq + 1);
			if (raw === "true") params[key] = true;
			else if (raw === "false") params[key] = false;
			else if (/^-?\d+(\.\d+)?$/.test(raw)) params[key] = Number(raw);
			else params[key] = raw;
		}
		return { recipe, params, cacheMode };
	}

	pi.registerCommand("q-run", {
		description: "Run a declared recipe: /q-run <recipe> [key=value ...] [--no-cache|--refresh-cache] (same service as workbench_run_recipe)",
		handler: async (args, ctx) => {
			const { recipe, params, cacheMode } = parseRunArgs(args);
			if (!recipe) {
				output(ctx, ["/q-run: usage: /q-run <recipe> [key=value ...] [--no-cache|--refresh-cache]"]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-run: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			try {
				const result = await runRecipe({
					projectRoot,
					recipeName: recipe,
					params,
					mode,
					exec: execFn,
					signal: ctx.signal,
					cacheMode,
					// P7: the shared mutation policy applies to /q-run exactly like
					// the model tool (strict Sol / delegated worker restrictions).
					actorFacts: {
						role: workerRoleContext.role,
						provider: currentModelFacts.provider,
						model: currentModelFacts.model,
					},
				});
				if (!result.ok && result.error) {
					output(ctx, [`/q-run: ${result.error}`]);
					return;
				}
				const summary = result.summary;
				if (!summary) {
					output(ctx, ["/q-run: no summary produced"]);
					return;
				}
				// P1: /q-run renders the same bounded parent summary as
				// workbench_run_recipe (plan §8) — never the raw output; full
				// logs stay persisted and are named by path.
				const parentSummary = buildRecipeParentSummary({
					runId: summary.run_id,
					recipe: summary.recipe,
					command: summary.argv.join(" "),
					ok: result.ok,
					exitCode: summary.exit_code,
					durationMs: summary.duration_ms,
					timedOut: summary.timed_out,
					cancelled: summary.cancelled,
					stdout: summary.stdout,
					stderr: summary.stderr,
					stdoutLogPath: displayRelative(projectRoot, summary.stdout_log),
					stderrLogPath: displayRelative(projectRoot, summary.stderr_log),
					stdoutTruncated: summary.stdout_truncated,
					stderrTruncated: summary.stderr_truncated,
					artifactPaths: summary.artifact_paths,
					cache: result.cache,
				});
				output(ctx, parentSummary.lines);
				void refreshStatus(ctx);
				void refreshWidget(ctx);
			} catch (error) {
				const message = error instanceof RecipeSetupError ? error.message : `failed to run recipe: ${(error as Error).message}`;
				output(ctx, [`/q-run: ${message}`]);
			}
		},
	});

	// ------------------------------------------------------------ /q-runs

	pi.registerCommand("q-runs", {
		description: "List recent workbench runs: /q-runs [limit]",
		handler: async (args, ctx) => {
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-runs: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const limitToken = args.trim().split(/\s+/)[0];
			const limit = limitToken && /^\d+$/.test(limitToken) ? Math.min(Number(limitToken), 50) : 10;
			const runs = await listRuns(projectRoot, limit);
			if (runs.length === 0) {
				output(ctx, [`No runs yet in ${displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs`)}`]);
				return;
			}
			const lines = runs.map((r) => {
				const status = r.timed_out ? "TIMED OUT" : r.cancelled ? "CANCELLED" : r.exit_code !== null && r.expected_exit_codes.includes(r.exit_code) ? "OK" : "FAILED";
				return `${r.run_id}  ${r.recipe.padEnd(28)} exit=${r.exit_code ?? "killed"} ${status.padEnd(9)} ${r.duration_ms}ms  ${r.started_at}`;
			});
			output(ctx, [`${lines.length} run(s) in ${displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs`)}`, ...lines]);
		},
	});

	// ------------------------------------------------------ /q-run-show

	pi.registerCommand("q-run-show", {
		description: "Show a run record: /q-run-show <run-id> (manifest, summary, bounded log tails)",
		handler: async (args, ctx) => {
			const emitRunShow = (value: unknown): void => {
				const text = boundedToolText(value, TOOL_DEFAULT_MAX_BYTES, TOOL_DEFAULT_MAX_LINES);
				output(ctx, text.split("\n"));
			};
			const runId = args.trim();
			if (!isValidRunId(runId)) {
				emitRunShow("/q-run-show: usage: /q-run-show <run-id> (e.g. 20260101-120000-abcd)");
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				emitRunShow(`/q-run-show: ${trustError}`);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const manifest = await readManifest(projectRoot, runId);
			if (!manifest) {
				emitRunShow(`/q-run-show: run ${runId} not found`);
				return;
			}
			const stdoutSnippet = await readLogSnippet(projectRoot, runId, "stdout");
			const stderrSnippet = await readLogSnippet(projectRoot, runId, "stderr");
			const argvValues = Array.isArray(manifest.argv) ? manifest.argv.filter((value): value is string => typeof value === "string") : [];
			const artifactValues = Array.isArray(manifest.artifact_paths) ? manifest.artifact_paths.filter((value): value is string => typeof value === "string") : [];
			const argv = boundedDetailsList(argvValues, 32, 256);
			const artifacts = boundedDetailsList(artifactValues, 32, 256);
			const lines = [
				`run       : ${boundedInlineDetail(manifest.run_id, 128)}`,
				`full record: ${displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs/${runId}/manifest.json`)}`,
				`recipe    : ${boundedInlineDetail(manifest.recipe, 256)}`,
				`profile   : ${boundedInlineDetail(manifest.profile ?? "(none)", 256)}`,
				`mode      : ${boundedInlineDetail(manifest.mode, 64)}`,
				`started   : ${boundedInlineDetail(manifest.started_at, 128)}`,
				`finished  : ${boundedInlineDetail(manifest.finished_at, 128)}`,
				`duration  : ${manifest.duration_ms} ms`,
				`cwd       : ${boundedInlineDetail(manifest.cwd, 512)}`,
				`argv      : ${argv.items.join(" ") || "(none)"}${argv.omitted_items > 0 ? ` (+${argv.omitted_items} argv item(s) omitted)` : ""}`,
				`exit code : ${manifest.exit_code ?? "killed"}`,
				`timed out : ${manifest.timed_out}`,
				`cancelled : ${manifest.cancelled}`,
				`git       : ${typeof manifest.git_commit === "string" ? boundedInlineDetail(manifest.git_commit, 12) : "(no git)"}${manifest.git_dirty ? " (dirty)" : ""}`,
				`artifacts : ${artifacts.items.join(", ") || "(none)"}${artifacts.omitted_items > 0 ? ` (+${artifacts.omitted_items} artifact path(s) omitted)` : ""}`,
				`stdout log: ${displayRelative(projectRoot, stdoutSnippet.path)}${stdoutSnippet.truncated ? " (truncated below)" : ""}`,
				`stderr log: ${displayRelative(projectRoot, stderrSnippet.path)}${stderrSnippet.truncated ? " (truncated below)" : ""}`,
				"",
				"--- stdout tail ---",
				stdoutSnippet.content || "(empty)",
				"--- stderr tail ---",
				stderrSnippet.content || "(empty)",
			];
			emitRunShow(lines.join("\n"));
		},
	});

	// ------------------------------------------------------------ /q-gate

	function parseGateArgs(args: string): { selector: string; manualEvidence: Record<string, string>; preflight: boolean } {
		const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
		let selector = "";
		let preflight = false;
		const manualEvidence: Record<string, string> = {};
		for (const token of tokens) {
			// Phase 3B: the --preflight flag is a read-only marker, never a
			// selector and never evidence; it may appear anywhere in the args.
			if (token === "--preflight") {
				preflight = true;
				continue;
			}
			const eq = token.indexOf("=");
			if (eq > 0 && token.slice(0, eq).startsWith("manual:")) {
				manualEvidence[token.slice("manual:".length, eq)] = token.slice(eq + 1);
				continue;
			}
			// The selector is the first non-flag, non-evidence token (existing
			// calls keep their selector-first semantics).
			if (!selector) selector = token;
		}
		return { selector, manualEvidence, preflight };
	}

	/**
	 * P1: bounded gate parent summary (plan §8) — status/exit, failing and
	 * blocked gate identifiers + reasons BEFORE passing-gate detail, the
	 * full persisted record path, and omission facts, under the same
	 * success/failure caps as recipe summaries.
	 */
	function gateParentSummaryLines(result: Awaited<ReturnType<typeof runGates>>, projectRoot: string): string[] {
		const summary = buildGateParentSummary({
			runId: result.runId,
			requested: result.requested,
			profile: result.profile,
			status: result.status,
			gates: result.gates.map((g) => ({
				id: g.id,
				status: g.status,
				title: g.title,
				failure_reason: g.failure_reason,
				blocked_reason: g.blocked_reason,
			})),
			recordPath: displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs/${result.runId}`),
		});
		return clampWholeResultText(summary.text, { maxBytes: 16_384, maxLines: 240 }).text.split("\n");
	}

	pi.registerCommand("q-gate", {
		description: "Run gates: /q-gate <gate-id|base|quant|all> [--preflight] [manual:<check-id>=<evidence> ...]",
		handler: async (args, ctx) => {
			const { selector, manualEvidence, preflight } = parseGateArgs(args);
			if (!selector) {
				output(ctx, ["/q-gate: usage: /q-gate <gate-id|base|quant|all> [--preflight] [manual:<check-id>=<evidence> ...]"]);
				return;
			}
			// P7: final gate verification in VERIFY mode is blocked while a
			// review is pending or stale (defense in depth — /q-mode-verify
			// already refuses to enter VERIFY in that state).
			if (mode === "VERIFY" && blocksVerify(delegationState)) {
				output(ctx, [`/q-gate: ${reviewBlockReason(delegationState, "verify")}`]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-gate: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			try {
				// Phase 3B: read-only preflight — same core preflight and
				// renderer as the model tool; no run, no exec, no recipe, no
				// status/widget refresh.
				if (preflight) {
					const preflightResult = await preflightGateManualEvidence({ projectRoot, selector, manualEvidence });
					const details: GatePreflightToolDetails = {
						preflight: true,
						selector: preflightResult.selector,
						requested: preflightResult.requested,
						profile: preflightResult.profile,
						manual_evidence_ready: preflightResult.manual_evidence_ready,
						required_manual_checks: preflightResult.required_manual_checks,
						provided_manual_evidence: preflightResult.provided_required_ids,
						missing_manual_evidence: preflightResult.missing_required_ids,
						gate_run_created: false,
						recipes_executed: 0,
						gate_status_assigned: false,
					};
					output(ctx, renderGatePreflightLines(details, true));
					return;
				}
				// P7 slice 3: every gate run receives the injected worker-first
				// compliance facts (slash command AND model tool) plus the actor
				// facts for the shared recipe mutation policy.
				const workerFirstFacts = await buildWorkerFirstGateFacts(projectRoot, new Date().toISOString());
				const result = await runGates({
					projectRoot,
					selector,
					mode,
					exec: execFn,
					signal: ctx.signal,
					manualEvidence,
					workerFirstFacts,
					actorFacts: {
						role: workerRoleContext.role,
						provider: currentModelFacts.provider,
						model: currentModelFacts.model,
					},
				});
				output(ctx, gateParentSummaryLines(result, projectRoot));
				void refreshStatus(ctx);
				void refreshWidget(ctx);
			} catch (error) {
				const message = error instanceof GateSetupError ? error.message : `failed to run gates: ${(error as Error).message}`;
				output(ctx, [`/q-gate: ${message}`]);
			}
		},
	});

	// ------------------------------------------------------------ /q-gates

	pi.registerCommand("q-gates", {
		description: "List the gates available for this project with their latest status",
		handler: async (_args, ctx) => {
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-gates: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			try {
				const gates = await loadGates(projectRoot);
				if (gates.length === 0) {
					output(ctx, ["No gates available for this project/profile."]);
					return;
				}
				const lines = [`${gates.length} gate(s) for this project:`];
				for (const g of gates) {
					const latest = await latestGateStatus(projectRoot, g.id);
					const status = latest ? `${latest.status} (run ${latest.run_id})` : "NOT_RUN (never run)";
					const prereqs = g.prerequisites.length > 0 ? ` needs: ${g.prerequisites.join(",")}` : "";
					lines.push(`  ${g.id.padEnd(4)} ${status.padEnd(42)} ${g.title}${prereqs}`);
				}
				output(ctx, lines);
			} catch (error) {
				output(ctx, [`/q-gates: ${error instanceof GateSetupError ? error.message : (error as Error).message}`]);
			}
		},
	});

	// ------------------------------------------------------- /q-gate-show

	pi.registerCommand("q-gate-show", {
		description: "Show a gate definition: /q-gate-show <gate-id>",
		handler: async (args, ctx) => {
			const gateId = args.trim();
			if (!gateId) {
				output(ctx, ["/q-gate-show: usage: /q-gate-show <gate-id>"]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-gate-show: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			try {
				const gates = await loadGates(projectRoot);
				const gate = gates.find((g) => g.id === gateId);
				if (!gate) {
					const known = gates.map((g) => g.id).join(", ") || "(none)";
					output(ctx, [`/q-gate-show: gate "${gateId}" not found. Available: ${known}`]);
					return;
				}
				const latest = await latestGateStatus(projectRoot, gate.id);
				output(ctx, renderGateDefinition(gate, latest?.status, latest?.run_id));
			} catch (error) {
				output(ctx, [`/q-gate-show: ${error instanceof GateSetupError ? error.message : (error as Error).message}`]);
			}
		},
	});

	// --------------------------------------------------------- /q-evidence

	pi.registerCommand("q-evidence", {
		description: "Show the evidence of a gate run: /q-evidence <run-id>",
		handler: async (args, ctx) => {
			const emitEvidence = (value: unknown): void => {
				const text = boundedToolText(value, TOOL_DEFAULT_MAX_BYTES, TOOL_DEFAULT_MAX_LINES);
				output(ctx, text.split("\n"));
			};
			const runId = args.trim();
			if (!isValidRunId(runId)) {
				emitEvidence("/q-evidence: usage: /q-evidence <run-id> (e.g. 20260101-120000-abcd)");
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				emitEvidence(`/q-evidence: ${trustError}`);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const manifest = await readManifest(projectRoot, runId);
			if (!manifest) {
				emitEvidence(`/q-evidence: run ${runId} not found`);
				return;
			}
			if (manifest.recipe !== "gate") {
				emitEvidence(`/q-evidence: run ${runId} is a recipe run (recipe "${boundedInlineDetail(manifest.recipe, 256)}") — it has no gate evidence`);
				return;
			}
			try {
				const evidence = await readGateEvidenceView(projectRoot, runId);
				emitEvidence(evidence.text);
			} catch {
				emitEvidence("/q-evidence: gate evidence unavailable");
			}
		},
	});

	// ----------------------------------------------------------- /q-report

	pi.registerCommand("q-report", {
		description: "Show a run report: /q-report latest | /q-report <run-id> (manifest, gates, quant facts)",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (!target) {
				output(ctx, ["/q-report: usage: /q-report latest | /q-report <run-id> (e.g. 20260101-120000-abcd)"]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-report: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const runId = await resolveRunTarget(projectRoot, target);
			if (!runId) {
				output(ctx, [
					`/q-report: ${isValidRunId(target) ? `run ${target} not found` : `unknown target "${target}" (use "latest" or a run id)`}`,
				]);
				return;
			}
			const lines = await buildRunReport(projectRoot, runId);
			output(ctx, lines ?? [`/q-report: run ${runId} not found`]);
		},
	});

	// ---------------------------------------------------------- /q-compare

	pi.registerCommand("q-compare", {
		description: "Compare two runs: /q-compare <run-id-a> <run-id-b> (exit code, duration, artifacts, gates, quant metrics)",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
			if (tokens.length < 2) {
				output(ctx, ["/q-compare: usage: /q-compare <run-id-a> <run-id-b> (e.g. /q-compare 20260101-120000-abcd 20260102-120000-efgh)"]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-compare: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const outcome = await compareRuns(projectRoot, tokens[0] ?? "", tokens[1] ?? "");
			if (!outcome.ok) {
				output(ctx, [`/q-compare: ${outcome.error}`]);
				return;
			}
			output(ctx, renderCompareLines(outcome.report, true));
		},
	});

	// ----------------------------------------------------------- /q-widget

	pi.registerCommand("q-widget", {
		description: "Toggle the workbench widget: /q-widget on | /q-widget off (widget also shows during tasks and gate failures)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") {
				widgetForced = true;
				output(ctx, ["workbench widget: on (shown while a task is active, a gate is failing, or forced)"]);
			} else if (arg === "off") {
				widgetForced = false;
				output(ctx, ["workbench widget: off (auto-hides; still shows during tasks and gate failures)"]);
			} else {
				output(ctx, ["/q-widget: usage: /q-widget on | /q-widget off"]);
				return;
			}
			await refreshWidget(ctx);
		},
	});

	// ------------------------------------------------------- P6-A cache cmds

	pi.registerCommand("q-cache-status", {
		description: "Show prompt-cache telemetry for the current session (provider, usage, hit ratio, last inferred invalidation)",
		handler: async (_args, ctx) => {
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-cache-status: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			await refreshCacheConfig(ctx);
			cacheTelemetry.setProjectRoot(projectRoot);
			cacheTelemetry.setMode(mode);
			cacheTelemetry.setThinkingLevel(ctx.thinkingLevel ?? pi.getThinkingLevel());
			output(ctx, renderCacheStatus(cacheTelemetry.snapshot()));
		},
	});

	pi.registerCommand("q-cache-report", {
		description: "Show cache telemetry report: /q-cache-report [session|project] [--save <name>]",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
			const scopeArg = tokens[0] === "session" || tokens[0] === "project" ? (tokens.shift() as "session" | "project") : "session";
			const saveIndex = tokens.indexOf("--save");
			const saveName = saveIndex >= 0 && tokens[saveIndex + 1] ? tokens[saveIndex + 1] : undefined;
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-cache-report: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			await refreshCacheConfig(ctx);
			cacheTelemetry.setProjectRoot(projectRoot);
			const store = new CacheStore(projectRoot);
			const { records, skipped } = await store.readRecords();
			const scope = scopeArg;
			let scoped = records as TelemetryRecord[];
			if (scope === "session") {
				const hashed = cacheTelemetry.snapshot().hashedSessionId;
				scoped = scoped.filter((r) => r.hashedSessionId === hashed);
			}
			const rateLookup: RateLookup = (provider, model) => {
				const m = ctx.modelRegistry.find(provider, model);
				if (!m || typeof m.cost?.cacheRead !== "number" || !Number.isFinite(m.cost.cacheRead)) return undefined;
				return { cacheRead: m.cost.cacheRead };
			};
			const report = buildCacheReport(scoped, scope, rateLookup);
			report.skippedRecords = skipped;
			const lines = renderCacheReport(report);
			if (saveName) {
				const saved = await store.saveReport(saveName, report);
				if (saved.ok && saved.path) {
					lines.push("", `report saved: ${displayRelative(projectRoot, saved.path)}`);
				} else {
					lines.push("", `report save failed: ${saved.error ?? "unknown error"}`);
				}
			}
			if (skipped > 0) lines.push(`(note: ${skipped} corrupted line(s) skipped in telemetry.jsonl)`);
			output(ctx, lines);
		},
	});

	pi.registerCommand("q-cache-doctor", {
		description: "Check cache telemetry health: /q-cache-doctor [json] (provider/model, usage validity, cost metadata, drift, forbidden fields)",
		handler: async (args, ctx) => {
			const jsonMode = args.trim().toLowerCase() === "json";
			const trustError = trustedOrError(ctx);
			if (trustError) {
				const checks = [{ id: "trust", status: "fail" as const, message: trustError }];
				output(ctx, jsonMode ? [JSON.stringify(doctorToJson(checks), null, 2)] : renderDoctor(checks));
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			await refreshCacheConfig(ctx);
			cacheTelemetry.setProjectRoot(projectRoot);
			const store = new CacheStore(projectRoot);
			const { records } = await store.readRecords();
			const model = ctx.model;
			const facts: DoctorFacts = {
				provider: model?.provider ?? null,
				model: model?.id ?? null,
				apiKind: model?.api ?? null,
				modelCostPresent: Boolean(model && typeof model.cost === "object" && model.cost !== null),
				modelCostRatesValid: Boolean(
					model && typeof model.cost?.cacheRead === "number" && Number.isFinite(model.cost.cacheRead) && model.cost.cacheRead >= 0,
				),
				systemPrompt: ctx.getSystemPrompt(),
				activeToolNames: pi.getActiveTools(),
				tools: pi.getAllTools().map((t) => ({
					name: t.name,
					description: t.description,
					promptSnippet: (t as { promptSnippet?: string }).promptSnippet,
					parameters: t.parameters,
					promptGuidelines: t.promptGuidelines,
				})),
				records: records as TelemetryRecord[],
				telemetryEnabled: cacheTelemetry.isEnabled(),
				telemetryBytes: await store.telemetryBytes(),
				telemetryMaxBytes: DEFAULT_MAX_TELEMETRY_BYTES,
				rotatedFiles: await store.rotatedFileCount(),
			};
			const checks = runDoctor(facts);
			output(ctx, jsonMode ? [JSON.stringify(doctorToJson(checks, facts), null, 2)] : renderDoctor(checks));
		},
	});

	// ------------------------------------------------------ P6-C cache cmds

	/** Shared P6-C cache context builder (explain/prune/clear). */
	function actionCacheContextFor(projectRoot: string, recipeName: string, cacheMode: CacheRequestMode) {
		return async (): Promise<{ ok: boolean; error?: string; ctx?: ActionCacheContext; store?: ActionCacheStore; keyResult?: Awaited<ReturnType<typeof computeKey>> | null }> => {
			const config = await loadProjectConfig(projectRoot, { trusted: true });
			const recipe = config.recipes.find((r) => r.name === recipeName);
			if (!recipe) return { ok: false, error: `recipe "${recipeName}" not found in recipes.yaml` };
			const store = new ActionCacheStore(projectRoot, { maxBytes: config.actionCacheMaxBytes });
			const ctx: ActionCacheContext = {
				projectRoot,
				recipe,
				policy: recipe.cache,
				argv: buildArgv(recipe, {}),
				mode,
				profile: config.profile,
				projectGates: config.gates,
				packageVersion: EXTENSION_VERSION,
				exec: execFn,
				store,
				cacheMode,
			};
			const plan = planCache(ctx);
			const keyResult = plan.active ? await computeKey(ctx) : null;
			return { ok: true, ctx, store, keyResult };
		};
	}

	/** Newest stored record for a recipe (different key) — change classification. */
	async function previousRecordFor(store: ActionCacheStore, recipeName: string, currentKey: string | undefined): Promise<ActionRecord | null> {
		try {
			const index = await store.readIndex();
			const candidates = index.entries.filter((e) => e.recipe === recipeName && e.key !== currentKey);
			candidates.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
			for (const candidate of candidates) {
				const { record } = await store.readRecord(candidate.key);
				if (record) return record;
			}
			return null;
		} catch {
			return null;
		}
	}

	pi.registerCommand("q-cache-explain", {
		description: "Explain the action cache for a recipe: /q-cache-explain <recipe> (action key, hit/miss, key components, changed inputs, toolchain/config/env diffs; never prints secrets or per-file hashes)",
		handler: async (args, ctx) => {
			const recipeName = args.trim().split(/\s+/)[0] ?? "";
			if (!recipeName) {
				output(ctx, ["/q-cache-explain: usage: /q-cache-explain <recipe>"]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-cache-explain: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const build = actionCacheContextFor(projectRoot, recipeName, "default");
			const built = await build();
			if (!built.ok || !built.ctx || !built.store) {
				output(ctx, [`/q-cache-explain: ${built.error ?? "unknown error"}`]);
				return;
			}
			const { ctx: cacheCtx, store } = built;
			const config = await loadProjectConfig(projectRoot, { trusted: true });
			const keyResult = built.keyResult;
			const facts: ExplainFacts = {
				recipeName,
				cacheEnabled: cacheCtx.policy.enabled,
				mode: cacheCtx.policy.mode,
				requestMode: "default",
				status: cacheCtx.policy.enabled ? "miss" : "disabled",
				key: keyResult?.ok ? keyResult.key.key : undefined,
				components: keyResult?.ok ? keyResult.key.components : null,
				currentEntries: keyResult?.ok ? keyResult.inputEntries : [],
				record: null,
				previousRecord: null,
				maxBytes: config.actionCacheMaxBytes,
				stats: await store.stats(),
			};
			if (!keyResult) {
				facts.status = cacheCtx.policy.enabled ? "refused" : "disabled";
			} else if (!keyResult.ok) {
				facts.status = "refused";
				facts.reason = keyResult.reason;
			} else {
				const outcome = await lookupValidated(cacheCtx, keyResult.key);
				facts.status = outcome.status;
				facts.reason = outcome.reason;
				facts.record = outcome.record ?? null;
				facts.previousRecord = await previousRecordFor(store, recipeName, keyResult.key.key);
			}
			output(ctx, renderCacheExplain(facts));
		},
	});

	pi.registerCommand("q-cache-prune", {
		description: "Prune the action cache: /q-cache-prune [--apply] (dry-run by default; --apply needs confirmation; never deletes runs/evidence)",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
			const apply = tokens.includes("--apply");
			const confirmToken = tokens.filter((t) => t !== "--apply").join(" ");
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-cache-prune: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const config = await loadProjectConfig(projectRoot, { trusted: true });
			const store = new ActionCacheStore(projectRoot, { maxBytes: config.actionCacheMaxBytes });
			if (apply) {
				let confirmed = false;
				if (ctx.hasUI) {
					confirmed = await ctx.ui.confirm("Prune action cache?", "Delete LRU action-cache records beyond the configured budget? Runs and evidence are never touched.");
				} else {
					confirmed = confirmToken === "yes";
				}
				if (!confirmed) {
					output(ctx, ["/q-cache-prune: not applied (no confirmation)", ...renderPrune(await store.prune({ apply: false }), config.actionCacheMaxBytes)]);
					return;
				}
			}
			const result = await store.prune({ apply });
			output(ctx, renderPrune(result, config.actionCacheMaxBytes));
		},
	});

	pi.registerCommand("q-cache-clear", {
		description: "Clear the action cache: /q-cache-clear <recipe|all> (single recipe needs confirmation; all needs double confirmation; never deletes runs/evidence)",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
			const target = tokens[0] ?? "";
			if (!target) {
				output(ctx, ["/q-cache-clear: usage: /q-cache-clear <recipe|all>"]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-cache-clear: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const config = await loadProjectConfig(projectRoot, { trusted: true });
			const store = new ActionCacheStore(projectRoot, { maxBytes: config.actionCacheMaxBytes });
			const confirmToken = tokens.slice(1).join(" ");
			let confirmed = false;
			if (target === "all") {
				if (ctx.hasUI) {
					const first = await ctx.ui.confirm("Clear ALL action-cache records?", "This deletes every cached recipe result for this project. Runs and evidence are never touched.");
					if (first) confirmed = await ctx.ui.confirm("Really clear ALL?", "This is the second and final confirmation. Type Cancel to keep the cache.");
				} else {
					confirmed = confirmToken === "yes yes";
				}
			} else if (ctx.hasUI) {
				confirmed = await ctx.ui.confirm(`Clear action cache for "${target}"?`, "Only this recipe's cached results are deleted. Runs and evidence are never touched.");
			} else {
				confirmed = confirmToken === "yes";
			}
			if (!confirmed) {
				output(ctx, [`/q-cache-clear: ${target} not cleared (no confirmation)`]);
				return;
			}
			const result = await store.clear(target === "all" ? "all" : target);
			output(ctx, renderClear(result));
		},
	});

	// ------------------------------------------------ P6-D quant cache cmds

	pi.registerCommand("q-cache-validate", {
		description: "Validate a quant cache contract manifest: /q-cache-validate <manifest-path> (contract type, schema version, immutable/mutable, content hash, upstream keys, missing fields, warnings, cache eligibility, Q gate implications; never reads data files)",
		handler: async (args, ctx) => {
			const manifestPath = args.trim();
			if (!manifestPath) {
				output(ctx, ["/q-cache-validate: usage: /q-cache-validate <manifest-path> (project-relative, e.g. artifacts/data-snapshot.json)"]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-cache-validate: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const report = await validateQuantManifestCommand(projectRoot, manifestPath);
			output(ctx, renderQuantCacheValidate(report));
		},
	});

	pi.registerCommand("q-cache-lineage", {
		description: "Trace quant cache lineage: /q-cache-lineage <run-id|action-key> (data snapshot -> feature set -> backtest result, upstream relationships, action keys, artifact hashes, reused runs, invalidation reason; never reads data files)",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (!target) {
				output(ctx, ["/q-cache-lineage: usage: /q-cache-lineage <run-id|action-key>"]);
				return;
			}
			const trustError = trustedOrError(ctx);
			if (trustError) {
				output(ctx, [`/q-cache-lineage: ${trustError}`]);
				return;
			}
			const projectRoot = await projectRootFor(ctx);
			const report = await buildQuantLineage(projectRoot, target);
			output(ctx, renderQuantLineage(report));
		},
	});

	// --------------------------------------- NRO N1/N2 native tool overrides

	function nativeReadV3Error(code: string): { content: Array<{ type: "text"; text: string }>; details: { schema: "workbench-read-page-v1"; code: string } } {
		return {
			content: [{ type: "text", text: `workbench_read: ${code}` }],
			details: { schema: "workbench-read-page-v1", code },
		};
	}

	pi.registerTool({
		...NATIVE_OVERRIDE_METADATA.read,
		parameters: NATIVE_OVERRIDE_PARAMETERS.read,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (params.cursor !== undefined && params.offset !== undefined) return nativeReadV3Error("invalid_pagination");
			throwIfNativeReadAborted(signal);
			const pendingAuthorization = peekOutputAuthorization(toolCallId, "read");
			// Direct execute tests/callers have no guard-side authorization and keep
			// the native hard cap. A guarded runtime call must use exactly its own
			// pending reservation; a blocked/zero allocation never falls back up.
			const maxOutputBytes = pendingAuthorization === undefined
				? READ_V3_MAX_OUTPUT_BYTES
				: pendingAuthorization.allowed
					? Math.min(READ_V3_MAX_OUTPUT_BYTES, pendingAuthorization.allocatedBytes)
					: 0;
			const absolutePath = await nativeResolveReadPath(params.path, ctx.cwd);
			const source = computeFileSourceId("read", absolutePath);
			if (!source.ok) return nativeReadV3Error(source.error.code);
			let authority: FileHandle | undefined;
			let authorityClosed = false;
			const closeAuthority = async (): Promise<boolean> => {
				if (authority === undefined || authorityClosed) return true;
				authorityClosed = true;
				return closeNativeReadAuthority(authority, toolCallId);
			};
			try {
				try {
					authority = await open(absolutePath, "r");
				} catch {
					throw new NativeReadV3IoFailure("io_error");
				}
				const initial = await nativeReadHandleSnapshot(authority);
				const prefix = await readNativeHandleExactly(authority, Math.min(initial.fileSize, IMAGE_SNIFF_BYTES), signal);
				const mimeType = sniffImageMimeType(prefix);
				const hookFacts = Object.freeze({ toolCallId, fileSize: initial.fileSize, mimeType });
				await nativeReadV3TestHooks.get(toolCallId)?.afterMagicSniff?.(hookFacts);
				await verifyNativeReadHandle(authority, initial);
				await verifyNativeReadPathIdentity(absolutePath, initial);

				if (mimeType !== null) {
					if (params.cursor !== undefined) return nativeReadV3Error("invalid_pagination");
					let imageRead = false;
					const verifyImageRequest = async (requestedPath: string): Promise<void> => {
						throwIfNativeReadAborted(signal);
						if (requestedPath !== absolutePath) throw new NativeReadV3IoFailure("source_changed_during_read");
						await verifyNativeReadHandle(authority!, initial);
						await verifyNativeReadPathIdentity(absolutePath, initial);
					};
					const imageTool = createReadToolDefinition(ctx.cwd, {
						operations: {
							access: verifyImageRequest,
							detectImageMimeType: async (requestedPath) => {
								await verifyImageRequest(requestedPath);
								return mimeType;
							},
							readFile: async (requestedPath) => {
								await verifyImageRequest(requestedPath);
								const bytes = await readNativeHandleExactly(authority!, initial.fileSize, signal);
								imageRead = true;
								await nativeReadV3TestHooks.get(toolCallId)?.afterImageBytesRead?.(hookFacts);
								await verifyNativeReadHandle(authority!, initial);
								await verifyNativeReadPathIdentity(absolutePath, initial);
								return bytes;
							},
						},
					});
					let imageResult: Awaited<ReturnType<typeof imageTool.execute>>;
					try {
						// Do not hand Pi the caller signal: its built-in rejects immediately
						// while image processing continues in the background. The custom
						// operations check the signal without closing their live handle early.
						imageResult = await imageTool.execute(toolCallId, params, undefined, onUpdate, ctx);
					} catch (error) {
						if (error instanceof NativeReadV3IoFailure) return nativeReadV3Error(error.code);
						if (error instanceof Error && error.message === "Operation aborted") throw error;
						return nativeReadV3Error("io_error");
					}
					if (!imageRead) return nativeReadV3Error("io_error");
					throwIfNativeReadAborted(signal);
					await verifyNativeReadHandle(authority, initial);
					await verifyNativeReadPathIdentity(absolutePath, initial);
					if (!(await closeAuthority())) return nativeReadV3Error("io_error");
					return imageResult;
				}

				// Text never enters Pi's legacy full-read branch. The classifier handle
				// is closed first; the bounded pager's own handle must report the exact
				// same source identity, so a path/symlink swap cannot expose replacement
				// bytes even if it lands between the two opens.
				if (!(await closeAuthority())) return nativeReadV3Error("io_error");
				let cursorPayload: FileCursorPayload | undefined;
				if (params.cursor !== undefined) {
					const decoded = decodeContinuationCursor(params.cursor);
					if (!decoded.ok || decoded.value.kind !== "read") return nativeReadV3Error("invalid_cursor");
					cursorPayload = decoded.value;
					if (cursorPayload.sourceId !== source.value) return nativeReadV3Error("source_mismatch");
				}
				const page = await readTextPage(absolutePath, {
					...(cursorPayload
						? {
							startByte: cursorPayload.byteOffset,
							lineNumber: cursorPayload.lineNumber,
							expectedSource: cursorPayload,
							verifyStartByteForLine: true,
						}
						: params.offset !== undefined ? { startLine: params.offset } : {}),
					maxBytes: READ_V3_MAX_OUTPUT_BYTES,
					maxLines: params.limit ?? READ_V3_MAX_FILE_LINES,
					signal,
				});
				if (!page.ok) return nativeReadV3Error(page.error.code);
				if (!sameNativeReadSnapshot(initial, page.value.source)) return nativeReadV3Error("source_changed_during_read");
				if (cursorPayload) {
					const validated = validateFileCursorSource({
						payload: cursorPayload,
						expectedKind: "read",
						expectedSourceId: source.value,
						currentSnapshot: page.value.source,
					});
					if (!validated.ok) return nativeReadV3Error(validated.error.code);
				}
				const rendered = buildNativeReadV3Page({
					displayPath: params.path,
					sourceId: source.value,
					page: page.value,
					maxOutputBytes,
				});
				rememberTrustedReadContinuation(toolCallId, rendered.details.next_cursor);
				return { content: [{ type: "text", text: rendered.text }], details: rendered.details };
			} catch (error) {
				if (error instanceof NativeReadV3IoFailure) return nativeReadV3Error(error.code);
				if (error instanceof Error && error.message === "Operation aborted") throw error;
				if (error instanceof Error && error.message === READ_V3_ALLOCATION_TOO_SMALL) {
					return nativeReadV3Error("output_allocation_too_small");
				}
				return nativeReadV3Error("io_error");
			} finally {
				if (!authorityClosed) await closeAuthority();
			}
		},
	});

	pi.registerTool({
		...NATIVE_OVERRIDE_METADATA.grep,
		parameters: NATIVE_OVERRIDE_PARAMETERS.grep,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// NRO N2 (plan §6.2): output=count is the exact uncapped count mode —
			// a dedicated abort-aware Pi-free adapter runs the installed rg
			// directly (explicit argument vector, shell:false, no pi.exec, no
			// download/write); the result is ONE compact line with details
			// undefined, and legacy limit/context never apply. Everything else
			// (output omitted or "matches") delegates byte-for-byte to the
			// captured built-in definition — the new selectors are simply not
			// forwarded, so legacy content/details/errors/abort stay identical.
			if (params.output === "count") {
				const countKind = params.count_kind === "lines" ? "lines" : "matches";
				const { value, files } = await runGrepCount(
					{
						pattern: params.pattern,
						path: params.path,
						glob: params.glob,
						ignoreCase: params.ignoreCase,
						literal: params.literal,
						countKind,
					},
					{ cwd: ctx.cwd, signal },
				);
				return {
					content: [{ type: "text", text: formatGrepCountLine(countKind, value, files) }],
					details: undefined,
				};
			}
			const legacyParams = {
				pattern: params.pattern,
				path: params.path,
				glob: params.glob,
				ignoreCase: params.ignoreCase,
				literal: params.literal,
				context: params.context,
				limit: params.limit,
			};
			return createGrepToolDefinition(ctx.cwd).execute(toolCallId, legacyParams, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...NATIVE_OVERRIDE_METADATA.find,
		parameters: NATIVE_OVERRIDE_PARAMETERS.find,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// NRO N1: exact legacy pass-through — the built-in definition owns
			// schema, metadata and execution byte-for-byte; count/max_depth are
			// staged N3 additions and are NOT exposed.
			return createFindToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	// --------------------------------------------------------- custom tools

	pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_project_inspect,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_project_inspect,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const trustError = trustedOrError(ctx);
				if (trustError) return fixedToolFailure("workbench_project_inspect", "untrusted_project");
				const projectRoot = await projectRootFor(ctx);
				const result = await inspectProject(projectRoot, { trusted: true, exec: execFn });
				const stacks = result.stacks.map((stack) => `${stack.language}${stack.package_manager ? ` (${stack.package_manager})` : ""}`);
				const errors = result.config_errors.map((error) => `${error.file}: ${error.message}`);
				const details: InspectToolDetails = {
					project_root: boundedInlineDetail(result.project_root, 512),
					effective_project_root: boundedInlineDetail(result.effective_project_root, 512),
					git: {
						is_git: result.git.is_git,
						commit: result.git.commit ? boundedInlineDetail(result.git.commit, 128) : null,
						dirty: result.git.dirty,
						branch: result.git.branch ? boundedInlineDetail(result.git.branch, 128) : null,
					},
					stacks: boundedDetailsList(stacks, 24, 256),
					profile: result.profile ? boundedInlineDetail(result.profile, 128) : undefined,
					recipes: boundedDetailsList(result.recipes.map((recipe) => recipe.name), 24, 256),
					recipe_validation_components: boundedCoverageMap(result.recipes),
					config_errors: boundedDetailsList(errors, 24, 512),
					config_files_present: boundedDetailsList(result.config_files_present, 24, 256),
				};
				const text = boundedToolText(renderInspectLines(details, true).join("\n"));
				return { content: [{ type: "text", text }], details };
			} catch {
				return fixedToolFailure("workbench_project_inspect", "runtime_error");
			}
		},
		...workbenchToolRenderer("inspect", "workbench_project_inspect"),
	});

	pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_run_recipe,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_run_recipe,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				const trustError = trustedOrError(ctx);
				if (trustError) return fixedToolFailure("workbench_run_recipe", "untrusted_project");
				const projectRoot = await projectRootFor(ctx);
				if (workerRoleContext.role === "worker") {
					const config = await loadProjectConfig(projectRoot, { trusted: true });
					const recipe = config.recipes.find((candidate) => candidate.name === params.recipe);
					const recipeRoleError = recipe ? workerRecipeBlockReason(workerRoleContext.role, recipe.name, recipe.writes) : undefined;
					if (recipeRoleError) return fixedToolFailure("workbench_run_recipe", "execution_denied");
				}
				onUpdate?.({
					content: [{ type: "text", text: "Running declared recipe..." }],
					details: { phase: "started", recipe: boundedInlineDetail(params.recipe, 256) },
				});
				const result = await runRecipe({
					projectRoot,
					recipeName: params.recipe,
					params: params.params ?? {},
					mode,
					exec: execFn,
					signal,
					cacheMode: params.cache ?? "default",
					// P7: the shared mutation policy applies inside the runner —
					// strict Sol is denied mutation: source, workers run only
					// mutation: none (the worker write-declaration check above
					// stays as the earlier, writes-based guard).
					actorFacts: {
						role: workerRoleContext.role,
						provider: currentModelFacts.provider,
						model: currentModelFacts.model,
					},
				});
				if (!result.ok && result.error) {
					return fixedToolFailure("workbench_run_recipe", "recipe_error");
				}
				const summary = result.summary;
				if (!summary) {
					return fixedToolFailure("workbench_run_recipe", "summary_unavailable");
				}
				const status = summary.timed_out ? "TIMED OUT" : summary.cancelled ? "CANCELLED" : result.ok ? "OK" : "FAILED";
				// P1: the parent result is a BOUNDED presentation summary (plan §8)
				// — success: no raw stdout/stderr, no per-test lines; failure:
				// fixed precedence with bounded excerpts after required facts.
				// Full logs stay persisted and are always named by path.
				const parentSummary = buildRecipeParentSummary({
					runId: summary.run_id,
					recipe: summary.recipe,
					command: summary.argv.join(" "),
					ok: result.ok,
					exitCode: summary.exit_code,
					durationMs: summary.duration_ms,
					timedOut: summary.timed_out,
					cancelled: summary.cancelled,
					stdout: summary.stdout,
					stderr: summary.stderr,
					stdoutLogPath: displayRelative(projectRoot, summary.stdout_log),
					stderrLogPath: displayRelative(projectRoot, summary.stderr_log),
					stdoutTruncated: summary.stdout_truncated,
					stderrTruncated: summary.stderr_truncated,
					artifactPaths: summary.artifact_paths,
					cache: result.cache,
				});
				const text = boundedToolText(parentSummary.text);
				const artifactPaths = summary.artifact_paths
					.slice(0, summary.artifact_paths.length > 32 ? 31 : 32)
					.map((path) => boundedInlineDetail(path, 512));
				if (summary.artifact_paths.length > artifactPaths.length) {
					artifactPaths.push(`... ${summary.artifact_paths.length - artifactPaths.length} artifact path(s) omitted`);
				}
				const details: RecipeToolDetails = {
					ok: result.ok,
					run_id: boundedInlineDetail(summary.run_id, 128),
					recipe: boundedInlineDetail(summary.recipe, 256),
					status,
					exit_code: summary.exit_code ?? null,
					duration_ms: summary.duration_ms,
					artifact_paths: artifactPaths,
					stdout_log: boundedInlineDetail(displayRelative(projectRoot, summary.stdout_log), 512),
					stderr_log: boundedInlineDetail(displayRelative(projectRoot, summary.stderr_log), 512),
					expected_exit_codes: result.record?.expected_exit_codes ?? [0],
					// Phase 2B: BOTH facts are copied ONLY from the persisted/returned
					// run record — a missing record leaves them absent (the renderer
					// shows unavailable) and they are never inferred from the recipe
					// declaration or cache defaults.
					...(result.record
						? {
							validation_components: result.record.validation_components,
							cache_request_mode: result.record.cache_request_mode,
						}
						: {}),
					cache: result.cache,
					phase: "finished",
				};
				onUpdate?.({
					content: [{ type: "text", text }],
					details: { ...details },
				});
				return { content: [{ type: "text", text }], details };
			} catch {
				return fixedToolFailure("workbench_run_recipe", "runtime_error");
			}
		},
		...workbenchToolRenderer("recipe", "workbench_run_recipe"),
	});

	pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_read_run,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_read_run,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			// R0 emergency boundary: EVERY return path (early validation,
			// missing/corrupt records, normal rendering, and caught runtime
			// failures) passes through this one final whole-result clamp. Later
			// phases replace it with the policy-aware generic result envelope.
			const readRunText = (value: unknown): string => clampWholeResultText(value, {
				maxBytes: RUN_LOG_RESULT_MAX_BYTES,
				maxLines: RUN_LOG_RESULT_MAX_LINES,
			}).text;
			try {
				const trustError = trustedOrError(ctx);
				if (trustError) {
					return { content: [{ type: "text", text: readRunText(`workbench_read_run: ${trustError}`) }], details: {} };
				}
				if (!isValidRunId(params.run_id)) {
					return { content: [{ type: "text", text: readRunText(`workbench_read_run: invalid run_id "${params.run_id}"`) }], details: {} };
				}
				const projectRoot = await projectRootFor(ctx);
				const manifest = await readManifest(projectRoot, params.run_id);
				if (!manifest) {
					return { content: [{ type: "text", text: readRunText(`workbench_read_run: run ${params.run_id} not found`) }], details: {} };
				}
				const include = params.include ?? "summary";
				const logMode = include === "logs" || include === "all";
				if (!logMode && params.cursor !== undefined) {
					return { content: [{ type: "text", text: readRunText("workbench_read_run: cursor_requires_logs_or_all") }], details: {} };
				}
				// R3 reservation is applied before file paging/rendering. A direct
				// execute call (unit/UI compatibility) retains the compile-time cap;
				// an authorized runtime call can only lower it.
				const pendingAuthorization = peekOutputAuthorization(toolCallId, "workbench_read_run");
				const requestedOutputBytes = params.max_bytes ?? DEFAULT_SNIPPET_BYTES;
				const outputBytes = pendingAuthorization
					? (pendingAuthorization.allowed ? Math.min(requestedOutputBytes, pendingAuthorization.allocatedBytes) : 0)
					: Math.min(requestedOutputBytes, RUN_LOG_RESULT_MAX_BYTES);
				const outputLines = Math.min(params.max_lines ?? DEFAULT_SNIPPET_LINES, RUN_LOG_RESULT_MAX_LINES);
				if (logMode && outputBytes <= 0) {
					return { content: [{ type: "text", text: "" }], details: {} };
				}
				const logPage = logMode
					? await readRunLogPage(projectRoot, params.run_id, {
						logStream: params.log_stream ?? "both",
						...(params.cursor === undefined ? {} : { cursor: params.cursor }),
						maxLines: outputLines,
						maxBytes: Math.min(RUN_LOG_RESULT_MAX_BYTES, Math.max(1, outputBytes)),
						preferStderr: manifest.exit_code === null || manifest.exit_code !== 0 || manifest.timed_out || manifest.cancelled,
					})
					: null;
				if (logPage && !logPage.ok) {
					return { content: [{ type: "text", text: readRunText(`workbench_read_run: ${logPage.error.code}`) }], details: {} };
				}
			// P4b: current-state validation assessment (strictly read-only —
			// observation only: it never skips recipe/gate execution, never
			// consults/alters the P6-C action cache, never rewrites run
			// artifacts, and never appends session/delegation entries). The
			// worker-first facts for gate runs come from the READ-ONLY
			// projection, so the authoritative in-memory delegation state is
			// never mutated and nothing is persisted.
				const validation = await assessRunValidation({
					projectRoot,
					mode,
					exec: execFn,
					manifest,
					actorFacts: {
						role: workerRoleContext.role,
						provider: currentModelFacts.provider,
						model: currentModelFacts.model,
					},
					...(manifest.recipe === "gate"
						? { workerFirstFacts: await buildReadOnlyWorkerFirstGateFacts(projectRoot, new Date().toISOString()) }
						: {}),
				});
			// Commander Slice B1: the layered bounded renderer (core/run-result.ts)
			// builds the ordered Summary/Evidence/Persisted output (plus the
			// bounded cwd/argv metadata for explicit manifest/logs/all includes
			// and the caller-bounded log tails for logs/all). All paths are
			// durable project-relative; disk records stay untouched. P4b adds
			// the REQUIRED bounded validation line to every include mode.
				const runDirRel = `${CONFIG_DIR_NAME}/workbench/runs/${manifest.run_id}`;
				const stdoutPath = `${runDirRel}/stdout.log`;
				const stderrPath = `${runDirRel}/stderr.log`;
				let renderedText: string;
				let runLogDetails: Record<string, unknown> = {};
				if (logPage?.ok) {
					const rendered = renderRunLogPage({
						manifest,
						page: logPage.value,
						validation,
						stdoutPath,
						stderrPath,
						maxOutputBytes: outputBytes,
						maxOutputLines: outputLines,
					});
					renderedText = rendered.text;
					runLogDetails = {
						include,
						log_stream: logPage.value.selection,
						shown_lines: rendered.shownLines,
						shown_bytes: rendered.shownBytes,
						remaining_bytes: rendered.omittedBeforeBytes,
						...(rendered.previousCursor ? { next_cursor: rendered.previousCursor } : {}),
					};
					if (rendered.previousCursor) rememberTrustedRunLogContinuation(toolCallId, rendered.previousCursor);
				} else {
					renderedText = renderRunResult({
						include,
						manifest,
						validation,
						stdoutSnippet: null,
						stderrSnippet: null,
						runDir: runDirRel,
						manifestPath: `${runDirRel}/manifest.json`,
						summaryPath: `${runDirRel}/summary.json`,
						stdoutPath,
						stderrPath,
					}).text;
				}
				const text = readRunText(renderedText);
				const details: ReadRunToolDetails = {
				run_id: manifest.run_id,
				recipe: manifest.recipe,
				kind: manifest.recipe === "gate" ? "gate" : "recipe",
				status: runStatusLabel(manifest),
				exit_code: manifest.exit_code,
				duration_ms: manifest.duration_ms,
				profile: manifest.profile,
				mode: manifest.mode,
				started_at: manifest.started_at,
				finished_at: manifest.finished_at,
				git_commit: manifest.git_commit,
				git_dirty: manifest.git_dirty,
				artifact_paths: manifest.artifact_paths,
				// P4b additive structured details: bounded status + fixed reason
				// codes only — never raw argv, manual evidence, unavailable
				// reasons, secrets or worker-first facts.
				validation: { status: validation.status, reasons: validation.reasons },
				stdout_log: displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs/${manifest.run_id}/stdout.log`),
				stderr_log: displayRelative(projectRoot, `${CONFIG_DIR_NAME}/workbench/runs/${manifest.run_id}/stderr.log`),
				...runLogDetails,
				};
				return {
					content: [{ type: "text", text }],
					details,
				};
			} catch (error) {
				// Passing the value directly keeps hostile Error/string coercion
				// inside clampWholeResultText's fail-closed boundary.
				return { content: [{ type: "text", text: readRunText(error) }], details: {} };
			}
		},
		...workbenchToolRenderer("read_run", "workbench_read_run"),
	});

	pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_run_gate,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_run_gate,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				const trustError = trustedOrError(ctx);
				if (trustError) return fixedToolFailure("workbench_run_gate", "untrusted_project");
				// P7: while a review is pending or stale, VERIFY is blocked.
				if (mode === "VERIFY" && blocksVerify(delegationState)) {
					const result = fixedToolFailure("workbench_run_gate", "review_blocked");
					result.details.blocked_reason = "review_blocked";
					return result;
				}
				const projectRoot = await projectRootFor(ctx);
				// Read-only preflight: no start update/run/recipe/status mutation.
				if (params.preflight === true) {
					const preflight = await preflightGateManualEvidence({
						projectRoot,
						selector: params.gates,
						manualEvidence: params.manual_evidence,
					});
					const details: GatePreflightToolDetails = {
						preflight: true,
						selector: preflight.selector,
						requested: preflight.requested,
						profile: preflight.profile,
						manual_evidence_ready: preflight.manual_evidence_ready,
						required_manual_checks: preflight.required_manual_checks,
						provided_manual_evidence: preflight.provided_required_ids,
						missing_manual_evidence: preflight.missing_required_ids,
						gate_run_created: false,
						recipes_executed: 0,
						gate_status_assigned: false,
					};
					const text = boundedToolText(renderGatePreflightLines(details, true).join("\n"));
					return { content: [{ type: "text", text }], details };
				}
				onUpdate?.({
					content: [{ type: "text", text: "Running declared gates..." }],
					details: { phase: "started", gates: boundedInlineDetail(params.gates, 256) },
				});
				// P7 slice 3: the model-tool gate run injects the same bounded
				// worker-first compliance facts as the /q-gate slash command.
				const workerFirstFacts = await buildWorkerFirstGateFacts(projectRoot, new Date().toISOString());
				const result = await runGates({
					projectRoot,
					selector: params.gates,
					mode,
					exec: execFn,
					signal,
					manualEvidence: params.manual_evidence ?? {},
					workerFirstFacts,
					actorFacts: {
						role: workerRoleContext.role,
						provider: currentModelFacts.provider,
						model: currentModelFacts.model,
					},
				});
				const text = boundedToolText(gateParentSummaryLines(result, projectRoot).join("\n"));
				const details = boundedGateDetails(result, projectRoot);
				onUpdate?.({ content: [{ type: "text", text }], details: { ...details } });
				return { content: [{ type: "text", text }], details };
			} catch {
				return fixedToolFailure("workbench_run_gate", "runtime_error");
			}
		},
		...workbenchToolRenderer("gate", "workbench_run_gate"),
	});

	pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_read_gate,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_read_gate,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const pendingAuthorization = peekOutputAuthorization(toolCallId, "workbench_read_gate");
				const maxOutputBytes = pendingAuthorization === undefined
					? GATE_READ_MAX_BYTES
					: pendingAuthorization.allowed
						? Math.min(GATE_READ_MAX_BYTES, pendingAuthorization.allocatedBytes)
						: 0;
				if (maxOutputBytes <= 0) return fixedToolFailure("workbench_read_gate", "output_allocation_unavailable");
				const trustError = trustedOrError(ctx);
				if (trustError) return fixedToolFailure("workbench_read_gate", "untrusted_project");
				const runId = params.run_id;
				const hasRun = runId !== undefined;
				const hasGate = params.gate_id !== undefined;
				if (hasRun === hasGate) return fixedToolFailure("workbench_read_gate", "invalid_target");
				const projectRoot = await projectRootFor(ctx);
				if (runId !== undefined) {
					if (!isValidRunId(runId)) return fixedToolFailure("workbench_read_gate", "invalid_run_id");
					const manifest = await readManifest(projectRoot, runId);
					if (!manifest) return fixedToolFailure("workbench_read_gate", "run_not_found");
					if (manifest.recipe !== "gate") return fixedToolFailure("workbench_read_gate", "not_a_gate_run");
					const page = await readGateRunPage({
						projectRoot,
						runId,
						include: params.include,
						cursor: params.cursor,
						maxBytes: maxOutputBytes,
						maxLines: params.max_lines,
					});
					if (!page.ok) return fixedToolFailure("workbench_read_gate", page.code, page.details.source_path);
					if (page.details.next_cursor) rememberTrustedGateContinuation(toolCallId, page.details.next_cursor);
					return {
						content: [{ type: "text", text: boundedToolText(page.text, maxOutputBytes, 320) }],
						details: page.details,
					};
				}
				const gates = await loadGates(projectRoot);
				const gate = gates.find((candidate) => candidate.id === params.gate_id);
				if (!gate) return fixedToolFailure("workbench_read_gate", "gate_not_found", ".pi/workbench/gates.yaml + builtin ladder");
				const latest = (await latestGateStatuses(projectRoot, [gate.id]))[gate.id];
				const page = renderGateDefinitionPage({
					gate,
					latestStatus: latest?.status,
					latestRunId: latest?.run_id,
					include: params.include,
					cursor: params.cursor,
					maxBytes: maxOutputBytes,
					maxLines: params.max_lines,
				});
				if (!page.ok) return fixedToolFailure("workbench_read_gate", page.code, page.details.source_path);
				if (page.details.next_cursor) rememberTrustedGateContinuation(toolCallId, page.details.next_cursor);
				return {
					content: [{ type: "text", text: boundedToolText(page.text, maxOutputBytes, 320) }],
					details: page.details,
				};
			} catch {
				return fixedToolFailure("workbench_read_gate", "runtime_error");
			}
			},
		});

	pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_list_gates,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_list_gates,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const trustError = trustedOrError(ctx);
				if (trustError) return fixedToolFailure("workbench_list_gates", "untrusted_project");
				const projectRoot = await projectRootFor(ctx);
				const gates = await loadGates(projectRoot);
				const latest = await latestGateStatuses(projectRoot, gates.map((gate) => gate.id));
				const presentation = renderGateListPresentation(gates, latest);
				const statuses: Record<string, GateStatus> = {};
				for (const gate of presentation.shownGates) {
					let key = boundedInlineDetail(gate.id, 96) || "(unnamed)";
					let suffix = 1;
					while (Object.prototype.hasOwnProperty.call(statuses, key)) key = `${boundedInlineDetail(gate.id, 80)}#${suffix++}`;
					statuses[key] = latest[gate.id]?.status ?? "NOT_RUN";
				}
				return {
					content: [{ type: "text", text: boundedToolText(presentation.text) }],
					details: {
						gate_count: gates.length,
						shown_count: presentation.shownGates.length,
						omitted_count: gates.length - presentation.shownGates.length,
						statuses,
						source_path: ".pi/workbench/gates.yaml + builtin ladder",
					},
				};
			} catch {
				return fixedToolFailure("workbench_list_gates", "runtime_error", ".pi/workbench/gates.yaml + builtin ladder");
			}
		},
	});

	pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_compare_runs,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_compare_runs,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const trustError = trustedOrError(ctx);
			if (trustError) {
				return { content: [{ type: "text", text: `workbench_compare_runs: ${trustError}` }], details: { ok: false, error: trustError } };
			}
			const projectRoot = await projectRootFor(ctx);
			const outcome = await compareRuns(projectRoot, params.a, params.b);
			if (!outcome.ok) {
				if (outcome.error === COMPARISON_PERSIST_ERROR) {
					throw new Error(`workbench_compare_runs: ${COMPARISON_PERSIST_ERROR}`);
				}
				const details: CompareToolDetails = { ok: false, error: outcome.error };
				return { content: [{ type: "text", text: `workbench_compare_runs: ${outcome.error}` }], details };
			}
			const quant = outcome.report.quant;
			const quantChangedCount = quant === null
				? 0
				: [quant.benchmark_delta, quant.return, quant.drawdown, quant.turnover]
					.filter((delta) => delta.changed).length + quant.costs.length + quant.parameters.length;
			const details: CompareToolDetails = {
				ok: true,
				comparison_id: outcome.comparison_id,
				a_run_id: outcome.report.a.run_id,
				b_run_id: outcome.report.b.run_id,
				compatible: outcome.report.compatible,
				artifact_added_count: outcome.report.generic.artifacts.added.length,
				artifact_removed_count: outcome.report.generic.artifacts.removed.length,
				gate_changed_count: outcome.report.generic.gate_delta?.changed.length ?? 0,
				quant_changed_count: quantChangedCount,
				parameter_changed_count: quant?.parameters.length ?? 0,
				comparison_path: outcome.comparison_path,
			};
			return {
				content: [{ type: "text", text: renderCompareLines(outcome.report, true).join("\n") }],
				details,
			};
		},
		...workbenchToolRenderer("compare", "workbench_compare_runs"),
	});



	pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_delegate_worker,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_delegate_worker,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const trustError = trustedOrError(ctx);
			if (trustError) throw new Error(`workbench_delegate_worker: ${trustError}`);
			const commanderError = commanderBlockReason(ctx.model?.provider, ctx.model?.id);
			if (commanderError) throw new Error(commanderError);
			// Phase 3 (worker token-budget repair): resolve the public
			// budget_profile BEFORE any ledger creation or child launch —
			// omitted resolves to `standard`; the three literals are
			// accepted; unknown/empty/wrong-type values fail closed with a
			// bounded error (the tool schema enforces the same closed union;
			// this pure contract check is the fail-closed decision).
			const budgetProfile = resolveWorkerBudgetProfile(params.budget_profile);
			if (!budgetProfile.ok) throw new Error(`workbench_delegate_worker: ${budgetProfile.error}`);
			// Phase 4A (worker repair contract): resolve the strict repair-
			// provenance pointer BEFORE any ledger creation or child launch —
			// omitted stays undefined (ordinary delegation); anything malformed
			// FAILS CLOSED with a bounded error exactly like the budget profile.
			const repairOf = resolveWorkerRepairOf(params.repair_of);
			if (!repairOf.ok) throw new Error(`workbench_delegate_worker: ${repairOf.error}`);
			const projectRoot = await projectRootFor(ctx);

			// Phase 4A: a repair pointer must reference a FINISHED prior
			// delegation ledger (manifest status "finished" and a non-null after
			// record) — verified BEFORE any new ledger is created or any worker
			// is launched. Only the id/status/after facts are inspected; no other
			// prior fields are read and no prose/scope is ever inherited from the
			// referenced delegation.
			if (repairOf.repairOf !== undefined) {
				const prior = await readDelegationLedger(projectRoot, repairOf.repairOf);
				if (prior === null || prior.manifest.status !== "finished" || prior.after === null) {
					throw new Error(`workbench_delegate_worker: repair_of ${repairOf.repairOf} does not reference a finished delegation ledger`);
				}
			}

			// P7: refresh the delegation state against the REAL git diff (any
			// change after REVIEWED turns the delegation STALE), then refuse
			// to start while a review is pending or stale — never falls back.
			// The before snapshot is a security fact source: an unavailable
			// `git status` REFUSES the delegation BEFORE any ledger is created
			// or any worker is launched (fail closed).
			const startedAt = new Date().toISOString();
			let before: GitFacts;
			try {
				before = await collectGitFacts(projectRoot, execFn);
			} catch (error) {
				throw new Error(`workbench_delegate_worker: cannot collect the real git state before delegating: ${(error as Error).message}`);
			}
			const beforeHash = computeDiffHash(before.changedPaths, before.pathDigests, before.pathStatuses);
			delegationState = observeDiffChange(delegationState, beforeHash, startedAt);
			persistDelegationState();
			const reviewBlock = reviewBlockReason(delegationState, "delegation");
			if (reviewBlock) throw new Error(`workbench_delegate_worker: ${reviewBlock}`);

			// P7: persist the bounded delegation ledger (atomic manifest +
			// before facts) BEFORE the worker starts; the ledger's own
			// directory never counts as a project change.
			const delegationId = makeDelegationId(new Date());
			const created = await createDelegationLedger(
				projectRoot,
				delegationId,
				{
					task: params.task,
					allowedPaths: params.allowed_paths,
					acceptanceCriteria: params.acceptance_criteria,
					verification: params.verification ?? [],
					timeoutSeconds: params.timeout_seconds ?? 1800,
					budgetProfile: budgetProfile.profile,
					// Phase 4A: the SAME resolved repair pointer spreads into the
					// ledger contract conditionally — the omitted path carries no key.
					...(repairOf.repairOf !== undefined ? { repairOf: repairOf.repairOf } : {}),
				},
				before,
				startedAt,
			);
			if (!created.ok) throw new Error(`workbench_delegate_worker: delegation ledger failed: ${created.error}`);
			const recorded = recordDelegation(delegationState, { id: delegationId, diffHash: beforeHash, now: startedAt });
			if (!recorded.ok) throw new Error(`workbench_delegate_worker: ${recorded.error}`);
			delegationState = recorded.state;
			persistDelegationState();
			void refreshStatus(ctx);

			onUpdate?.({
				content: [
					{
						type: "text",
						// Phase 4: the exact text prefix is preserved and the compact
						// deterministic spend segment is appended — numeric counters
						// and the fixed band only, starting state included (zero
						// counters, band ok).
						text: `DeepSeek worker: 0 turn(s), model ${WORKER_MODEL_SELECTOR} | spend total 0 | output 0 | band ok`,
					},
				],
				details: {
					phase: "starting",
					delegation_id: delegationId,
					turns: 0,
					totalTokens: 0,
					outputTokens: 0,
					spendBand: "ok",
					provider: WORKER_PROVIDER,
					model: WORKER_MODEL_SELECTOR,
				},
			});

			// Run the worker; EVERY outcome (success and failure) is recorded
			// in the ledger and stays PENDING_REVIEW.
			let result: WorkerRunResult;
			try {
				result = await runDeepseekWorker({
					projectRoot,
					contract: {
						task: params.task,
						allowedPaths: params.allowed_paths,
						acceptanceCriteria: params.acceptance_criteria,
						verification: params.verification ?? [],
						budgetProfile: budgetProfile.profile,
						// Phase 4A: the SAME resolved repair pointer spreads into the
						// worker contract conditionally — the omitted path carries no key.
						...(repairOf.repairOf !== undefined ? { repairOf: repairOf.repairOf } : {}),
					},
					timeoutMs: (params.timeout_seconds ?? 1800) * 1000,
					signal,
					// Phase 3: the SAME resolved profile the ledger recorded — the
					// runner accumulates and enforces exactly this profile.
					spendProfile: budgetProfile.profile,
					onProgress: (progress) => {
						// Phase 4: the exact compact progress shape — the cumulative
						// numeric spend counters (turns / total / output) and the fixed
						// band plus provider/model identity. Intermediate/final worker
						// text never enters onUpdate.
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `DeepSeek worker: ${progress.turns} turn(s), model ${progress.provider ?? WORKER_PROVIDER}/${progress.model ?? WORKER_MODEL_ID} | spend total ${progress.totalTokens} | output ${progress.outputTokens} | band ${progress.spendBand}`,
								},
							],
							details: {
								phase: "running",
								turns: progress.turns,
								totalTokens: progress.totalTokens,
								outputTokens: progress.outputTokens,
								spendBand: progress.spendBand,
								provider: progress.provider,
								model: progress.model,
							},
						});
					},
				});
			} catch (error) {
				result = {
					exitCode: 1,
					turns: 0,
					output: "",
					reportText: "",
					reportTextOversized: false,
					stderr: "",
					aborted: true,
					timedOut: false,
					errorMessage: (error as Error).message,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					cacheHitRatio: null,
					maxContextTokens: 0,
					maxContextRatio: 0,
					softBudgetReached: false,
					hardBudgetExceeded: false,
					compactionCount: 0,
					compactionReasons: [],
					// Phase 3: exception fallback facts preserve the SAME resolved
					// profile the ledger recorded (never re-defaulted).
					spendProfile: budgetProfile.profile,
					spendState: { ...EMPTY_WORKER_SPEND_STATE },
					spendBand: "ok",
					spendReasons: [],
					spendSoftReached: { turns: false, totalTokens: false, outputTokens: false },
					spendHardExceeded: { turns: false, totalTokens: false, outputTokens: false },
				};
			}
			let failure: string | undefined;
			try {
				assertWorkerSucceeded(result);
			} catch (error) {
				result = { ...result, errorMessage: (error as Error).message };
				failure = (error as Error).message;
			}

			// P7: finish the ledger with the true after facts (digest-based
			// changed paths since before, after diff hash, pinned worker
			// identity, status/exit, usage/budget, bounded redacted summary).
			// Every outcome also atomically persists worker-report.md (the
			// complete final worker text — the ledger redacts FIRST, then caps
			// to 512 KiB with the explicit marker only when the REDACTED
			// report still exceeds the bound), the extended worker-summary.json
			// and usage.json. The returned worker-summary record is the SINGLE
			// shared summary derivation for the parent handoff (no re-parse).
			let after: AfterFacts;
			let handoffSummary: LedgerWorkerSummaryRecord;
			try {
				after = await collectAfterFacts(projectRoot, before, execFn);
				const finished = await finishDelegationLedger(projectRoot, delegationId, {
					after,
					worker: {
						provider: result.provider ?? null,
						model: result.model ?? null,
						status: failure === undefined ? "success" : "failure",
						exitCode: result.exitCode,
						turns: result.turns,
						stopReason: result.stopReason ?? null,
						errorMessage: result.errorMessage ?? null,
						usage: {
							input: result.usage.input,
							output: result.usage.output,
							cacheRead: result.usage.cacheRead,
							cacheWrite: result.usage.cacheWrite,
							totalTokens: result.usage.totalTokens,
							cost: { ...result.usage.cost },
						},
						cacheHitRatio: result.cacheHitRatio,
						budget: {
							maxContextTokens: result.maxContextTokens,
							maxContextRatio: result.maxContextRatio,
							softBudgetReached: result.softBudgetReached,
							hardBudgetExceeded: result.hardBudgetExceeded,
							compactionCount: result.compactionCount,
							compactionReasons: [...result.compactionReasons],
						},
						// Phase 3: the runner's recorded cumulative spend facts feed
						// the canonical ledger spend object (usage.json /
						// worker-summary.json) on EVERY outcome — including hard
						// spend failures with their hard flags/reasons.
						spendProfile: result.spendProfile,
						spendState: { ...result.spendState },
						spendBand: result.spendBand,
						spendReasons: [...result.spendReasons],
						spendSoftReached: { ...result.spendSoftReached },
						spendHardExceeded: { ...result.spendHardExceeded },
						reportSummary: result.output,
					},
					reportText: result.reportText,
					secrets,
					now: new Date().toISOString(),
				});
				if (!finished.ok) throw new Error(finished.error);
				handoffSummary = finished.workerSummary;
			} catch (error) {
				throw new Error(
					failure === undefined
						? `workbench_delegate_worker: delegation ledger finish failed: ${(error as Error).message}`
						: `workbench_delegate_worker: worker failed (${failure}) and the delegation ledger finish also failed: ${(error as Error).message}`,
				);
			}

			if (failure) throw new Error(failure);
			// The bounded parent handoff: never embeds result.output/report/
			// patch/test logs, and renders the SAME bounded summary/parse-
			// warning facts persisted in worker-summary.json — including the
			// reported-vs-actual divergence warning and the parse-reliability
			// flag (exactly one summary derivation; the parent never re-parses
			// the report text). It shows the delegation id, provider/model,
			// status, ACTUAL changed paths (collectAfterFacts.changedSinceBefore
			// — never the report prose), bounded parsed section items (or the
			// safe fallback), usage/cache/budget summary, the durable report
			// path, parse/review warnings, and the explicit instruction that
			// Sol must inspect the actual diff.
			return buildDelegateWorkerResult({
				delegationId,
				provider: result.provider,
				model: result.model,
				status: "success",
				turns: result.turns,
				exitCode: result.exitCode,
				stopReason: result.stopReason,
				changedPaths: after.changedSinceBefore,
				usage: result.usage,
				cacheHitRatio: result.cacheHitRatio,
				budget: {
					maxContextTokens: result.maxContextTokens,
					maxContextRatio: result.maxContextRatio,
					softBudgetReached: result.softBudgetReached,
					hardBudgetExceeded: result.hardBudgetExceeded,
					compactionCount: result.compactionCount,
					compactionReasons: [...result.compactionReasons],
				},
				reportPath: handoffSummary.report_path,
				summary: handoffSummary,
				// Phase 3: the parent renders the SAME canonical spend object the
				// ledger persisted in worker-summary.json (single derivation —
				// never recomputed from runner internals or worker prose).
				spend: handoffSummary.spend,
				reviewStatus: delegationState.status,
			});
		},
	});

	pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_review_worker_diff,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_review_worker_diff,
		executionMode: "sequential",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const pendingAuthorization = peekOutputAuthorization(toolCallId, "workbench_review_worker_diff");
			const requestedMaxBytes = Math.min(params.max_bytes ?? DIFF_REVIEW_RESULT_MAX_BYTES, DIFF_REVIEW_RESULT_MAX_BYTES);
			const renderMaxBytes = pendingAuthorization === undefined
				? requestedMaxBytes
				: pendingAuthorization.allowed
					? Math.min(requestedMaxBytes, pendingAuthorization.allocatedBytes)
					: 0;
			const renderMaxLines = Math.min(params.max_lines ?? DIFF_REVIEW_RESULT_MAX_LINES, DIFF_REVIEW_RESULT_MAX_LINES);
			const reviewText = (value: unknown): string => clampWholeResultText(value, {
				maxBytes: renderMaxBytes,
				maxLines: renderMaxLines,
			}).text;
			if (renderMaxBytes <= 0) return { content: [], details: { ok: false, error: "output_allocation_unavailable" } };
			const trustError = trustedOrError(ctx);
			if (trustError) {
				return { content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: ${trustError}`) }], details: {} };
			}
			// P7: lazy lease-lock sync — the review guard never runs against
			// stale advertised edit/write tools.
			syncLeaseLock();
			const projectRoot = await projectRootFor(ctx);
			const delegationId = params.delegation_id.trim();
			// The review lifecycle is a single latest-delegation slot: only the
			// latest delegation can be reviewed. Slice B2: the tool is callable
			// repeatedly while the delegation is PENDING_REVIEW, STALE or
			// REVIEWED — every call re-runs the real git facts, scope and hash
			// (a same-hash complete PASS rerender keeps the valid REVIEWED
			// binding; a changed hash resets coverage).
			if (delegationState.latestId === undefined) {
				return { content: [{ type: "text", text: reviewText("workbench_review_worker_diff: no delegation to review") }], details: {} };
			}
			if (delegationState.latestId !== delegationId) {
				return {
					content: [
						{
							type: "text",
							text: reviewText(`workbench_review_worker_diff: delegation ${delegationId} is not the latest delegation (${delegationState.latestId}); only the latest delegation can be reviewed`),
						},
					],
					details: {},
				};
			}
			const result = await reviewDelegation({
				projectRoot,
				delegationId,
				exec: execFn,
				includePaths: params.include_paths,
				maxLines: renderMaxLines,
				maxBytes: renderMaxBytes,
				secrets,
			});
			if (!result.ok || !result.record) {
				return { content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: ${result.error ?? "review failed"}`) }], details: { ok: false, error: result.error } };
			}
			// Bind the state to the REAL current hash (the review record binds
			// it too). Slice B2: REVIEWED means scope PASS AND complete
			// displayed-path coverage with NO exception. A changed hash resets
			// coverage so PASS stays blocking until fresh coverage is
			// complete; a same-hash complete PASS rerender keeps the valid
			// REVIEWED binding (markReviewed refuses REVIEWED → REVIEWED, so
			// the already-REVIEWED state is left untouched).
			const now = new Date().toISOString();
			delegationState = observeDiffChange(delegationState, result.record.bound_diff_hash, now);
			if (result.record.verdict === "PASS" && result.record.coverage_complete) {
				if (delegationState.status !== "REVIEWED") {
					const marked = markReviewed(delegationState, now);
					if (!marked.ok) {
						return {
							content: [{ type: "text", text: reviewText(`workbench_review_worker_diff: review record written but state refused REVIEWED: ${marked.error}`) }],
							details: { ok: false, error: marked.error },
						};
					}
					delegationState = marked.state;
				}
			} else if (delegationState.status === "REVIEWED") {
				// Fail-closed invalidation: REVIEWED must never survive a
				// re-review of the CURRENT diff that is anything other than
				// PASS with complete coverage — a scope FAIL OR an incomplete
				// PASS (e.g. a legacy partial review record) demotes to
				// PENDING_REVIEW with the reviewed hash cleared, exactly like
				// the scope-FAIL path.
				const demoted = demoteReviewedToPending(delegationState, now);
				if (demoted.ok) delegationState = demoted.state;
			}
			persistDelegationState();
			void refreshStatus(ctx);
			const record = result.record;
			const text = reviewText(result.lines.join("\n"));
			const nextIncludePaths: string[] = [];
			let nextIncludeBytes = 0;
			for (const path of record.remaining_paths) {
				if (nextIncludePaths.length >= MAX_REVIEW_PATCH_PATHS) break;
				if (typeof path !== "string" || Buffer.byteLength(path, "utf8") > MAX_REVIEW_PATH_BYTES) break;
				if (/[\u0000-\u001f\u007f]/.test(path)) break;
				const quotedBytes = Buffer.byteLength(JSON.stringify(path), "utf8") + (nextIncludePaths.length > 0 ? 2 : 0);
				if (nextIncludeBytes + quotedBytes > MAX_REVIEW_GUIDANCE_BYTES) break;
				nextIncludePaths.push(path);
				nextIncludeBytes += quotedBytes;
			}
			return {
				content: [{ type: "text", text }],
				details: {
					ok: true,
					delegation_id: delegationId,
					verdict: record.verdict,
					review_status: delegationState.status,
					bound_diff_hash: record.bound_diff_hash,
					recorded_after_hash: record.recorded_after_hash,
					mismatch: record.mismatch,
					violation_count: record.violations.length,
					drift_count: record.drift_paths.length,
					checked_count: record.checked_paths.length,
					displayed_count: record.displayed_paths.length,
					remaining_count: record.remaining_paths.length,
					coverage_complete: record.coverage_complete,
					review_record: record.review_path,
					next_include_paths: nextIncludePaths,
					patch_truncated: record.patch_truncated,
				},
			};
		},
		...workbenchToolRenderer("review", "workbench_review_worker_diff"),
	});

	pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_delegation_status,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_delegation_status,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const trustError = trustedOrError(ctx);
			if (trustError) {
				return { content: [{ type: "text", text: `workbench_delegation_status: ${trustError}` }], details: {} };
			}
			// P7: lazy lease-lock sync — the reported lease state is never stale.
			syncLeaseLock();
			const projectRoot = await projectRootFor(ctx);
			const status = await delegationStatusLines(projectRoot);
			// P7 bounded-handoff diagnostics: same exact CONTEXT RISK line as
			// /q-delegation-status when the latest delegation tool-result turn is
			// detected too large for safe context compaction.
			const contextRisk = delegationContextRiskLine(ctx.sessionManager.getEntries());
			return {
				content: [{ type: "text", text: contextRisk ? [...status.lines, contextRisk].join("\n") : status.lines.join("\n") }],
				details: { git_refresh: status.gitRefresh },
			};
		},
	});

	pi.registerTool({
		...WORKBENCH_TOOL_METADATA.workbench_recover_tool_result,
		parameters: WORKBENCH_TOOL_PARAMETERS.workbench_recover_tool_result,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const trustError = trustedOrError(ctx);
			if (trustError) {
				return { content: [{ type: "text", text: `workbench_recover_tool_result: ${trustError}` }], details: {} };
			}
			// P8b exact-one runtime rule: the schema params are both OPTIONAL,
			// but exactly one of result_id / tool_call_id is required — both or
			// neither is the fixed `invalid` code.
			const hasResultId = params.result_id !== undefined;
			const hasToolCallId = params.tool_call_id !== undefined;
			if (hasResultId === hasToolCallId) {
				return {
					content: [{ type: "text", text: `workbench_recover_tool_result: ${recoverFailureText("invalid")}` }],
					details: { ok: false, available: false, code: "invalid" },
				};
			}
			const projectRoot = await projectRootFor(ctx);
			let id: string | undefined;
			let outcome: RecoverOutcome;
			if (hasResultId) {
				id = params.result_id;
				outcome = await recoverReceipt({ projectRoot, id });
			} else {
				// tool_call_id derives in the CURRENT native Pi session.
				// BOTH the current native session identity and the parameter
				// are validated/narrowed BEFORE any hash: missing/invalid/
				// control-char/over-bound identity returns the fixed `invalid`
				// code and hashes nothing.
				const sessionIdentity = ctx.sessionManager.getSessionId();
				const toolCallId = params.tool_call_id;
				if (typeof sessionIdentity !== "string" || typeof toolCallId !== "string" || !isValidIdentity(sessionIdentity, toolCallId)) {
					return {
						content: [{ type: "text", text: `workbench_recover_tool_result: ${recoverFailureText("invalid")}` }],
					details: { ok: false, available: false, code: "invalid" },
					};
				}
				id = deriveResultId(sessionIdentity, toolCallId);
				outcome = await recoverReceipt({ projectRoot, sessionIdentity, toolCallId });
			}
			if (!outcome.ok) {
				const facts: Record<string, unknown> = { ok: false, available: false, code: outcome.kind };
				if (outcome.kind === "missing" && id !== undefined) facts.result_id = id;
				else if (outcome.kind === "incomplete") facts.result_id = outcome.started.id;
				return {
					content: [{ type: "text", text: `workbench_recover_tool_result: ${recoverFailureText(outcome.kind)}` }],
					details: facts,
				};
			}
			const receipt = outcome.receipt;
			return {
				content: [{ type: "text", text: renderReceiptRecovery(projectRoot, receipt) }],
				details: {
					ok: true,
					available: true,
					result_id: receipt.id,
					tool: receipt.tool,
					status: receipt.status,
					path: receiptRelativePath(projectRoot, receipt.id),
					summary_omitted_lines: receipt.summary_omitted_lines,
					summary_omitted_bytes: receipt.summary_omitted_bytes,
				},
			};
		},
	});

	// ------------------------------------------- second-layer tool_call guard

	/** tool_result #1 — final envelope using only this call's reservation. */
	pi.on("tool_result", (event) => {
		let envelope: OutputEnvelopeResult;
		try {
				const trustedContinuation = takeTrustedReadContinuation(event.toolCallId, event.toolName)
					?? takeTrustedRunLogContinuation(event.toolCallId, event.toolName)
					?? takeTrustedGateContinuation(event.toolCallId, event.toolName);
			const authorization = takeOutputAuthorization(event.toolCallId, event.toolName)
				?? authorizeOutput(event.toolCallId, event.toolName, event.input);
			const policy = resolveToolOutputPolicy({
				toolName: event.toolName,
				args: event.input,
				role: outputTurnRole(),
			});
			if (!authorization.allowed || !authorization.authorizationId) {
				envelope = enforceOutputEnvelope({ toolName: event.toolName, content: [], isError: true, policy, allocatedBytes: 0 });
			} else {
				envelope = enforceOutputEnvelope({
					toolName: event.toolName,
					content: event.content,
					isError: event.isError,
					policy,
					allocatedBytes: authorization.allocatedBytes,
					continuation: trustedContinuation,
				});
				const accounting = turnOutputBudget.consumeResult({
					authorizationId: authorization.authorizationId,
					actualBytes: envelope.facts.shownTextBytes,
				});
				if (!accounting.accepted) {
					envelope = enforceOutputEnvelope({ toolName: event.toolName, content: [], isError: true, policy, allocatedBytes: 0 });
				}
			}
		} catch {
			const policy = resolveToolOutputPolicy({ toolName: event.toolName, args: undefined, role: outputTurnRole() });
			envelope = enforceOutputEnvelope({ toolName: event.toolName, content: [], isError: true, policy, allocatedBytes: 0 });
		}
		outputEnvelopeFactsByEvent.set(event, envelope.facts);
		observeOutputEnvelope(event.toolName, envelope.facts);
		// Even a fail-closed normal middleware result is already bounded and its
		// authorization has been settled/released. Preserve FIFO multiplicity for
		// repeated exact id+name pairs so message_end never double-accounts it.
		rememberProcessedNormalResult(event.toolCallId, event.toolName);
		return { content: envelope.content, isError: envelope.isError };
	});

	/**
	 * tool_result #2 — receipt FINALIZE. The preceding middleware has already
	 * replaced event.content, so receipts can consume only bounded text. This
	 * handler records bounded metadata in a WeakMap and never alters content.
	 */
	pi.on("tool_result", async (event) => {
		const pending = pendingReceiptHandles.get(event.toolCallId);
		if (!pending) return undefined;
		const { handle, projectRoot } = pending;
		try {
			if (event.toolName !== handle.toolName) {
				receiptFactsByEvent.set(event, {
					available: false,
					code: "tool_name_mismatch",
					result_id: handle.id,
					tool: handle.toolName,
				});
				return undefined;
			}
			const text = event.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("");
			const outcome = await finalizeReceipt({
				projectRoot,
				handle,
				status: event.isError ? "error" : "success",
				content: text,
				error: event.isError ? text : undefined,
				secrets,
			});
			receiptFactsByEvent.set(event, outcome.ok
				? {
						available: true,
						result_id: outcome.receipt.id,
						status: outcome.receipt.status,
						path: receiptRelativePath(projectRoot, outcome.receipt.id),
					}
				: { available: false, code: finalizeUnavailableCode(outcome), result_id: handle.id });
		} catch {
			receiptFactsByEvent.set(event, { available: false, code: "storage_error", result_id: handle.id });
		} finally {
			// Matching ids are consumed after every attempt, including mismatch.
			pendingReceiptHandles.delete(event.toolCallId);
		}
		return undefined;
	});

	/**
	 * tool_result #3 — bounded per-tool details projection/attachment. The
	 * projector receives envelope/receipt facts only from private side channels,
	 * drops full domain records, and enforces the 8 KiB session invariant before
	 * Pi emits tool_execution_end or persists the tool-result message.
	 */
	pi.on("tool_result", (event) => {
		try {
			const envelope = outputEnvelopeFactsByEvent.get(event) ?? runtimeFailureEnvelope().facts;
			const receipt = receiptFactsByEvent.get(event);
			let details: unknown;
			try {
				details = event.details;
			} catch {
				details = undefined;
			}
			return {
				details: projectToolResultDetails({
					toolName: event.toolName,
					details,
					envelope,
					receipt,
				}).details,
			};
		} finally {
			outputEnvelopeFactsByEvent.delete(event);
			receiptFactsByEvent.delete(event);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const streamingBoundaryReason = streamingControl.toolCallBlockReason(event.toolName);
		if (streamingBoundaryReason) return { block: true, reason: streamingBoundaryReason };
		const workerRoleReason = workerRoleToolCallBlockReason(workerRoleContext, event.toolName, event.input);
		if (workerRoleReason) return { block: true, reason: boundedGuardReason(workerRoleReason) };
		if (
			workerRoleContext.role === "worker" &&
			(event.toolName === "edit" || event.toolName === "write") &&
			workerRoleContext.projectRoot &&
			event.input &&
			typeof event.input === "object" &&
			typeof (event.input as { path?: unknown }).path === "string"
		) {
			const path = (event.input as { path: string }).path;
			if (!(await isWorkerPathAllowedRealpath(workerRoleContext.projectRoot, path, workerRoleContext.allowedPaths))) {
				return { block: true, reason: boundedGuardReason("Delegated worker path failed realpath/symlink scope validation") };
			}
		}
		// P7 second layer — strict Sol commander guard: bash is always
		// blocked; edit/write require a valid user-issued temporary write
		// lease; every tool outside the fixed allowlist is blocked despite
		// any re-enable. Delegated workers and other controllers are outside
		// this guard (the worker guards above remain authoritative). P7
		// slice 3: EVERY blocked strict-Sol edit/write attempt increments
		// the bounded blockedWriteAttempts audit counter (not only attempts
		// while a review is outstanding) — the counter is persisted and
		// mirrored into the compaction state.
		const actor = detectActorRole({
			roleEnv: workerRoleContext.role,
			provider: currentModelFacts.provider,
			model: currentModelFacts.model,
		});
		const now = new Date().toISOString();
		// P7: lazy lease-lock sync inside the guard — an expired/exhausted
		// edit/write call both BLOCKS (the second-layer decision below) and
		// removes the stale edit/write from the advertised set, with no
		// timer or background job.
		syncLeaseLock(now);
		if (actor === "sol-commander") {
			const commanderReason = commanderToolCallBlockReason({
				actor,
				toolName: event.toolName,
				input: event.input,
				lease: writeLease,
				now,
			});
			if (commanderReason) {
				if (event.toolName === "edit" || event.toolName === "write") {
					delegationState = recordBlockedWriteAttempt(delegationState, now);
					persistDelegationState();
				}
				return { block: true, reason: boundedGuardReason(commanderReason) };
			}
		}
		const check = checkToolCall(mode, event.toolName, event.input);
		if (!check.allowed) {
			return {
				block: true,
				reason: boundedGuardReason(check.reason ?? `Blocked by workbench ${mode} mode`),
			};
		}

		// R3 budget authorization is the final policy guard and always precedes
		// receipt BEGIN. Keep the exact id+name authorization queued because
		// Pi's immediate-result paths bypass tool_result middleware.
		const authorization = authorizeOutput(event.toolCallId, event.toolName, event.input);
		rememberOutputAuthorization(authorization);
		if (!authorization.allowed) {
			return {
				block: true,
				reason: boundedGuardReason(
					authorization.controlText ?? blockedControlText(authorization.blockCode ?? "turn_output_budget"),
				),
			};
		}
		// P8b: two-phase tool-result receipt BEGIN — the LAST step of this
		// guard, after every worker/commander/mode/path/lease check above has
		// allowed. Every registered workbench tool EXCEPT the public recovery
		// tool begins an exclusive started receipt here (native Pi session id
		// + event.toolCallId + exact tool name + canonical input hash; the
		// effective project root is resolved exactly like each tool's own
		// execute). BEGIN completes BEFORE the tool executes. A matching
		// completed replay blocks re-execution with a short fixed reason
		// carrying the durable result id and a recover instruction; every
		// other outcome (incomplete/corrupt/conflict/invalid/storage) blocks
		// fail-closed and never executes. A full in-memory handle map blocks a
		// new call BEFORE begin with a fixed bounded reason (existing handles
		// are never evicted). This is exact same-toolCallId
		// identity only — P4 validation evidence is never consulted.
		if (isWorkbenchToolName(event.toolName) && event.toolName !== RECOVERY_TOOL_NAME) {
			// P8b capacity: when the in-memory handle map is already at
			// MAX_IN_FLIGHT_RECEIPTS a new registered workbench call is
			// blocked fail-closed BEFORE beginReceipt/execution with a fixed
			// bounded reason. Existing pending handles are NEVER evicted —
			// nothing is begun for the blocked call, so no started receipt is
			// left incomplete.
			if (pendingReceiptHandles.size >= MAX_IN_FLIGHT_RECEIPTS) {
				if (authorization.authorizationId) turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
				return { block: true, reason: boundedGuardReason(capacityBlockReason()) };
			}
			try {
				const projectRoot = await projectRootFor(ctx);
				const begun = await beginReceipt({
					projectRoot,
					sessionIdentity: ctx.sessionManager.getSessionId(),
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					rawInput: event.input,
				});
				if (!begun.ok) {
					if (authorization.authorizationId) turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
					return { block: true, reason: boundedGuardReason(beginBlockReason(begun)) };
				}
				pendingReceiptHandles.set(event.toolCallId, { handle: begun.handle, projectRoot });
			} catch {
				if (authorization.authorizationId) turnOutputBudget.releaseAuthorization({ authorizationId: authorization.authorizationId });
				return { block: true, reason: boundedGuardReason("Tool result receipt storage unavailable") };
			}
		}

		// Only a fully authorized call reaches lease consumption and modified
		// bookkeeping; receipted calls have also completed BEGIN successfully.
		if (actor === "sol-commander" && (event.toolName === "edit" || event.toolName === "write")) {
			const path =
				event.input && typeof event.input === "object" && typeof (event.input as { path?: unknown }).path === "string"
					? (event.input as { path: string }).path
					: "";
			if (writeLease && leaseStatus(writeLease, now) === "active") {
				const consumed = consumeLeaseCall(writeLease, event.toolName, path, now);
				if (consumed.ok) {
					writeLease = consumed.lease;
					persistLease();
					if (leaseStatus(writeLease, now) !== "active") applyModeTools();
				}
			}
		}
		if ((event.toolName === "edit" || event.toolName === "write") && event.input && typeof event.input === "object") {
			const path = (event.input as { path?: unknown }).path;
			if (typeof path === "string" && path.length > 0) {
				compactState.modifiedFiles = pushBounded(compactState.modifiedFiles, path, MAX_MODIFIED_FILES);
			}
		}
		return undefined;
	});
}
