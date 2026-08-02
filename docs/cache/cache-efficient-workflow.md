# Cache-Efficient Workflow (P6-B)

How to actually get cache hits on DeepSeek with the workbench. The cache is
automatic and full-prefix — the only lever is keeping the prefix stable.

## The one rule

**Stay in one mode for the whole phase, and only switch modes when the
phase changes.** Every `AUDIT → DEV → VERIFY` switch is an allowed,
expected cold change: the tool set (and therefore the prefix) changes once,
and the next request starts a new cache line. That is fine. Switching modes
frequently within a phase is what kills caching.

## Recommended session shape

1. **Plan/read phase → `AUDIT`.** Inspect the project, read docs and code.
   The AUDIT tool set is read-only and small; its prefix stays stable for
   the whole phase.
2. **Build phase → `DEV`.** One switch (expected invalidation). Do all
   editing here; keep the mode until the phase is done.
3. **Verify phase → `VERIFY`.** One switch (expected invalidation). Run
   declared recipes and gates only; read results with the read-only tools.

Each switch costs exactly one cold prefix. Three switches per task = three
cold prefixes — that is the designed cost and it buys you the security
boundaries. Never switch modes to "make the tools fit" mid-phase.

## What to avoid

- ❌ **Frequent `/reload`.** A reload is an expected invalidation, but it
  also rebuilds the whole session. Reload when the extension changed —
  not to "refresh state".
- ❌ **Frequent model / thinking-level switches.** `model_select` and
  `thinking_level_select` are expected invalidations but each one resets
  the provider cache. Pick model and thinking level at session start.
- ❌ **Same-mode tool drift.** If `/q-cache-doctor` reports
  `same_mode_drift` or `/q-cache-report` shows `UNEXPECTED_DRIFT` growth,
  something changed the prefix inside a mode. Fix the source (usually a
  dynamic tool description or a per-turn system-prompt append) instead of
  living with it.
- ❌ **Touching the system prompt or tool metadata at runtime.** The
  workbench never does; other extensions doing it will show up as drift.
- ❌ **Sacrificing permissions for caching.** AUDIT/VERIFY's read-only
  boundaries are security semantics (P5). Do not loosen them to make the
  tool set "smaller" — the cache is never worth a security hole.
- ❌ **Expecting 100% hits.** Provider-side misses (TTL, eviction) are
  normal and outside your control (`PROVIDER_BEST_EFFORT_MISS`).

## The lifecycle changes that reset the prefix (expected)

First request, new session, mode switch, model switch, thinking-level
switch, package reload, compaction, and provider-side best-effort misses.
None of these are bugs; the telemetry classifies them as **expected**.

Same-mode system-prompt changes, same-mode tool set/order/schema changes,
and dynamic state leaking into the system prompt or tool metadata are
**`UNEXPECTED_DRIFT`** — those are the only things to actually fix.

## Using the telemetry to check yourself

- `/q-cache-status` — current session: provider/model, hit ratio, last
  inferred invalidation.
- `/q-cache-report` — session or project totals: hit ratio, change counts
  (model/thinking/mode/reload/compaction), expected invalidations vs
  unexpected drifts, same-mode mutations, estimated avoided cost.
- `/q-cache-doctor [json]` — current prefix hashes
  (systemPromptHash, activeToolNamesHash, activeToolOrderHash,
  activeToolSchemaHash), same-mode drift, churn, tool-metadata statics,
  and the P6-A hygiene checks.

Good signs: hit ratio climbing within a phase; `same-mode mutat.` = 0;
`churn` counts equal to the number of phase switches.

## Cache maintenance uses slash commands

All cache maintenance is done with slash commands (`/q-cache-status`,
`/q-cache-report`, `/q-cache-doctor`) — never with model-callable tools, so
the tool set stays frozen and slash commands never appear in the prompt.

## Summary checklist

- [ ] One mode per phase; mode switches are planned phase boundaries
- [ ] No mid-phase `/reload`
- [ ] Model and thinking level chosen once
- [ ] `/q-cache-doctor` shows `same_mode_drift: ok` and static tool metadata
- [ ] No cache-control fields, no warm-up, no dynamic tool loader
- [ ] Permissions unchanged — caching never outranks security
