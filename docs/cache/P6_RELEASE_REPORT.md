# P6 Release Report (P6-E)

Release: **pi-dev-workbench v0.8.0** — P6 complete (prompt-cache telemetry,
stable-prefix contract, recipe action cache, quant cache contracts, offline
cache benchmark). This report records what was tested, what was verified,
and exactly how to roll back or clean up. The milestone itself performs
**no commit, tag or npm publish** — versioning, committing and pushing are
developer actions carried out after the milestone (see the git history of
this repository for the commit that carries this release).

## Tested environment

| Component | Version | How it was exercised |
| --- | --- | --- |
| Pi (`@earendil-works/pi-coding-agent`) | **0.83.0** | `npm run typecheck` / `npm test` against the pinned devDependency; live `pi -a -p` print-mode and `pi --mode json -a -p` JSON-mode smokes; extension direct-load smoke (stub API via tsx). |
| Pi TUI (`@earendil-works/pi-tui`) | 0.83.0 | Component tests render status/widget/renderer pieces through pi-tui `Text`. |
| Node.js | v24.13.0 | All test runs and smoke runs. |
| npm | 11.18.0 | `npm install`, all scripts. |
| OS / kernel | CachyOS Linux, x86_64 | All runs above. |
| typebox / yaml / typescript / tsx | 1.3.7 / 2.9.x / 5.9.x / 4.23.x | Typecheck, schema tests, CLI execution. |

## Tested provider/model

- Provider: **deepseek**, model **deepseek-v4-flash**, thinking level **max**,
  workbench mode **DEV**.
- API kind: **openai-completions** — confirmed from Pi model metadata and
  recorded in every telemetry record (`apiKind: "openai-completions"`); the
  usage semantics for this kind were verified against the installed Pi 0.83.0
  source (see P6-A usage mapping below). The benchmark corpus is 602
  requests across 5 sessions on 2026-08-02 (see
  [P6_BENCHMARK_REPORT.md](P6_BENCHMARK_REPORT.md)).

## P6-A — usage mapping (verified against installed Pi source)

For `openai-completions` (DeepSeek's api kind in Pi 0.83.0):
`usage.input` is the **un-cached** input (`prompt_tokens − cacheRead −
cacheWrite`), `cacheRead` is the cache-hit input (DeepSeek's
`prompt_cache_hit_tokens`), `cacheWrite` is 0 for DeepSeek (not an error),
`cost.total` is Pi's cost fact. At the v0.8.0 release,
`openai-responses`, `azure-openai-responses` and `anthropic-messages`
semantics were also mapped; other api kinds were recorded as `unverified`.
The current Unreleased runtime additionally verifies
`openai-codex-responses`, which uses the same `openai-responses-shared`
normalization. The workbench never guesses. Evidence:
`extensions/workbench-runtime/cache/cache-types.ts` + tests
`tests/p6-cache-usage.test.ts`.

## P6-B — prefix stability (verified)

- Stable zone: system prompt + static rules + extension registration order
  + per-mode tool list + tool metadata + skill/prompt-template metadata.
  Dynamic values (time, git state, run ids, gate status, cache usage) are
  confined to the documented dynamic channels (TUI status/widget, custom
  session entries, tool results, telemetry hash metadata, chat messages).
- Evidence: stable-prefix contract tests
  (`tests/p6-b-stable-prefix.test.ts`), doctor checks
  (`/q-cache-doctor`, `npm run cache:doctor`), and the benchmark corpus:
  **systemPromptHash / toolNamesHash / toolOrderHash constant across all
  602 records**; toolSchemaHash changed twice only when new tools were
  added between milestones.
- Mode tool sets are fixed per mode (AUDIT/DEV/VERIFY, `MODE_TOOLS`) and
  P5 permission isolation is enforced on mode switch via the hard
  `tool_call` guard (`checkToolCall`) — mode switches were regression-tested
  (P0–P5 suites).

## P6-C — recipe action cache (verified)

- Opt-in per recipe (`cache: {enabled: true}`), disabled by default; only
  declared recipes; result-only (artifacts restore disabled in v1);
  content-addressed action keys over declared inputs (never git state,
  mtimes or sizes); success-only writes; corruption → miss + quarantine;
  atomic writes, per-key locks with stale-lock recovery; LRU prune
  (`/q-cache-prune`) and clear (`/q-cache-clear`) never touch runs/evidence/
  telemetry; cache hits materialize a NEW run manifest
  (`execution_source: "cache"`) and **never bypass gates** (P6-D
  re-validation + Q ladder).
- Evidence: `tests/p6-c-*.test.ts`, `tests/p6-cache-*.test.ts`, live runs
  (12 manifests, 5 hits, 138.4 s avoided in the benchmark corpus).

## P6-D — quant cache contracts (verified)

- Versioned DATA_SNAPSHOT / FEATURE_SET / BACKTEST_RESULT manifest
  contracts with strict validation (`invalid`/`unresolved`/`validated`);
  `latest`/`current`/`now` ids can never be a final cache key; logical
  references resolve to immutable revisions only; backtest-result hits
  re-verify `resultArtifactHash`; failed folds are never filtered; cached
  runs re-validate through Q0–Q5.
- Evidence: `tests/p6-d-quant-contracts.test.ts`,
  `tests/p6-d-quant-cache.test.ts`, fixtures in `fixtures/quant/`.

## P6-E — offline cache benchmark (this release)

- `scripts/cache-benchmark.ts` with `npm run cache:report` and
  `npm run cache:doctor`; reads only telemetry JSONL, run manifests and
  action cache records; never calls models, reads `auth.json`, sends HTTP,
  warms caches or modifies providers; no hardcoded prices
  (`estimatedAvoidedCost` needs an explicit `--cost-map`).
- Evidence: `tests/p6-e-cache-benchmark.test.ts` (15 tests), live runs
  against the project's own telemetry.

## DeepSeek final constraints (audited, all hold)

1. `auth.json` — never read/modified (only listed as a P5 protected path).
2. User `models.json` — never created/modified.
3. `models-store.json` — never modified (or read).
4. `DEEPSEEK_API_KEY` — not referenced anywhere.
5–7. `cache_control` / `prompt_cache_key` / `prompt_cache_retention` — no
   occurrences in extensions/scripts/tools.
8. Cache TTL — no provider TTL configuration (the only `maxAgeSeconds` is
   the local action-cache policy, `null` = never expire).
9. Keepalive — none.
10. Cache warmup — none (`warmupPeriod` in the P6-D feature-set contract is
    a strategy data field, not a provider call).
11. Dynamic/deferred tool loader — none.
12. `supportsToolSearch` / `supportsToolReferences` — not set.
13. Mode tool sets stable — fixed `MODE_TOOLS` per mode (P6-B tests).
14. Mode-switch permission isolation — P5 `checkToolCall` guard (tests).
15. `cacheWrite=0` — documented as normal for DeepSeek, never an error.
16. Provider best-effort miss — classified
    `PROVIDER_BEST_EFFORT_MISS` (expected class, low confidence), never
    treated as a workbench fault.
17. DeepSeek prices — never hardcoded; registry rates in-Pi, explicit
    `--cost-map` in the CLI.

## Security/privacy audit (P6-E)

All checks from the audit list were reviewed against the codebase; findings:

- Telemetry is hash-only (forbidden-key deep scan refuses any record with
  prompt/content/secret/token/cwd/env/absolute-file keys before disk).
- Provider payloads are only structurally digested (roles, lengths,
  per-segment hashes); headers and bodies are never copied.
- Tool inputs/outputs never enter telemetry; recipe output is redacted
  (P5 redaction) and truncated.
- API keys/auth: path policy blocks writes everywhere and reads in
  AUDIT/VERIFY; redaction covers `auth.json` etc.
- Path traversal/symlink escape: recipe cwd/writes/artifacts are
  containment-checked (lexical + realpath); report saves verify the
  resolved path stays inside `reports/`.
- Cache poisoning/tampering: action records carry schema+key checks;
  mismatch → quarantine + miss; CAS re-verifies SHA-256 (v1: disabled).
- Action-record tampering: `cache-index.json` is rebuildable; a corrupted
  index is detected by the benchmark doctor.
- Concurrent writers: per-key lockfiles (owner PID + token) with
  double-checked lookup; stale locks broken only for dead owners older
  than 60 s; lock-timeout proceeds without the lock (best-effort writes).
- Unbounded storage: telemetry rotation (5 MB × 5), action-cache LRU prune
  budget (default 256 MB), benchmark reports are explicit `--save` only.
- Prune/clear never delete run evidence or telemetry (tests).
- Non-TUI crash: every UI path is guarded by `ctx.mode`/`ctx.hasUI`;
  telemetry/benchmark failures degrade to caught no-ops or `{ok:false}`.
- Project trust: config and cache commands require `ctx.isProjectTrusted()`;
  the CLI benchmark only reads — trust is not a bypassable factor.
- Cache hits never bypass gates: cached runs re-materialize a fresh run
  manifest and the quant contracts re-validate at read and write time.
- `latest`/`mutable` never cached as final ids (P6-D).
- Failed folds are never hidden (P6-D tests).
- No HFT/L2/market-making/exchange-order routing functionality exists in
  the package (grep-verified; templates assert the same).

## Known limitations

- Single-model/single-mode benchmark corpus (DEV, deepseek-v4-flash, max
  thinking); no long-term savings claim — see the benchmark report's
  Limitations section.
- Full interactive TUI session not automated (component tests + print/json
  smokes only).
- Windows/macOS untested; POSIX path semantics.
- Action-cache artifacts restore disabled in v1 (result-only caching).
- Telemetry is project-scoped; rotated archives older than
  `telemetry.5.jsonl` are dropped.

## Rollback instructions

- **To the previous milestone (0.7.x P6-D state):** the branch
  `feat/p6-cache-efficiency` contains the uncommitted P6-E work. Revert the
  working tree to the last commit (`git checkout -- .` and delete untracked
  P6-E files) or `git stash`. The 0.7.0 commit `2532bd3` is the last tagged
  point; P6-A..D changes were left uncommitted by design, so a clean
  rollback to released v0.6.1 is `git checkout v0.6.1` (tag exists).
- **Downgrade steps:** restore `package.json`/`package-lock.json` version
  (0.7.0), remove the `cache:report`/`cache:doctor` scripts, delete
  `scripts/cache-benchmark.ts`, `docs/cache/cache-benchmark.md`,
  `docs/cache/P6_BENCHMARK_REPORT.md`, `docs/cache/P6_RELEASE_REPORT.md`,
  and `tests/p6-e-cache-benchmark.test.ts`; `EXTENSION_VERSION` in
  `cache-types.ts` must match package.json again.
- The runtime cache (`.pi/workbench/cache/`) is gitignored and safe to keep
  or delete — it is never needed for the package to function.

## Cache clear / prune instructions

| Goal | Command |
| --- | --- |
| Prompt-cache telemetry status | `/q-cache-status` |
| Reports (session/project) | `/q-cache-report [session\|project] [--save <name>]` |
| Health check | `/q-cache-doctor` or `npm run cache:doctor` |
| Benchmark report | `npm run cache:report` |
| Action-cache dry-run prune | `/q-cache-prune` |
| Apply prune (needs confirmation) | `/q-cache-prune --apply` |
| Clear one recipe (needs confirmation) | `/q-cache-clear <recipe>` |
| Clear everything (double confirmation) | `/q-cache-clear all` |
| Manual removal (offline) | delete `.pi/workbench/cache/{actions,cas,locks,tmp,cache-index.json}` — runs/evidence/telemetry are untouched |

Prune/clear never delete run records, evidence artifacts, telemetry or
reports; the benchmark CLI only ever adds optional report files via
`--save`.
