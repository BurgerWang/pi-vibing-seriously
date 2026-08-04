# Security

What pi-dev-workbench protects, what it does not, and the exact boundaries.
Read this before trusting the workbench with anything important.

## Honest threat model

- **Pi has no built-in sandbox.** Pi, extensions, and this package inherit
  the system permissions of the user account that launches them. Nothing in
  this package changes that.
- **The Recipe Runner is not an OS sandbox.** Recipes run with your full
  user permissions: they can read anything you can read and modify anything
  inside the project root. Recipe restrictions (argv-only commands, path
  containment, env allow-list, redaction) are process-level **discipline and
  guardrails**, not isolation.
- **Mode restrictions and the `tool_call` guard are guardrails, not a
  security boundary.** They reduce the blast radius of model mistakes; they
  do not stop a malicious actor, a malicious recipe, or a compromised model.
- For untrusted repositories or unattended automation, run Pi in a
  container/VM per Pi's security documentation.
- Only install this package from sources you trust and review its source
  before use: extensions execute arbitrary code in your Pi session.

## Path protection (P5)

Protected path classes (basename matching, case-insensitive, any depth):

| Class | Patterns |
| ----- | -------- |
| Environment files | `.env`, `.env.*` — **except** `.env.example` and `.env.template` (explicitly allowed) |
| Private keys | `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`, `*.pem`, `*.key`, `*.p8` |
| Keystores | `*.p12`, `*.pfx`, `*.jks` |
| Tokens | `*.token` |
| Credentials | `credentials.*`, `secrets.*`, `exchange-keys.*`, `auth.json`, `.netrc` |

Policy matrix (enforced in the `tool_call` guard):

| Operation | DEV | AUDIT | VERIFY |
| --------- | --- | ----- | ------ |
| `edit`/`write` on a protected path | **blocked** | **blocked** | **blocked** |
| `read`/`ls`/`find`/`grep` on a protected path | allowed | **blocked** | **blocked** |
| bash display-reads (`cat .env`, `head id_rsa`, ...) | allowed | **blocked**¹ | **blocked**¹ |
| reading `.env.example` / `.env.template` | allowed | allowed | allowed |

¹ Defense in depth — bash is already hard-denied in AUDIT/VERIFY.

Why DEV allows reads: during local development the model may legitimately
inspect local configuration (e.g. whether a variable is set). The content
enters the session transcript, so treat DEV reads as visible to the session.
Writes are blocked everywhere because the agent should never create or
modify credential files — the human does that directly.

Implementation: `core/path-policy.ts` (pure), wired into `checkToolCall` in
`core/mode-policy.ts`. Matching is basename-based; a directory named
`credentials/` does not protect its ordinary files.

## Command protection (P5)

Blocked command classes (token-based parsing — `core/command-guard.ts`):

- `rm -rf /`, `rm -rf /*`, `rm -rf ~`, `rm -rf $HOME`, `rm -rf ~/*`
- `rm` of any `.git` directory
- `git reset --hard` (any target)
- `git clean -fd` / `-fdx` / any force+directories combination
- `git push -f` / `--force` / `--force-with-lease` (in any position)
- `git checkout -- .` and `git restore .` (whole-tree restore; single-file
  restore like `git restore src/main.ts` stays allowed)
- `git remote add|remove|rm|set-url|rename`
- `git config --global` / `--system` writes (reads like `--list` and
  local project config stay allowed)
- any command starting with `sudo`
- `npm|yarn|pnpm|bun publish|unpublish` — `--dry-run` stays allowed

The parser is quote-aware: `git commit -m "rm -rf /"`, `echo 'a && b'` and
branch names like `feature/--force-x` cannot false-positive, while quoted
destructive forms (`rm -rf "/"`) are still caught. The guard is a discipline
layer, not a sandbox.

## Controlled worker delegation

`workbench_delegate_worker` starts one short-lived Pi child process in DEV.
It is not a sandbox: the child inherits the launching user's OS permissions
and provider authentication. The parent project must already be trusted.

Defense-in-depth controls:

- only `gpt-5.6-sol` on the `openai-codex` or `openai` provider can invoke it;
- the child selector is pinned to `deepseek/deepseek-v4-flash:max`, and
  assistant provider/model drift fails closed;
- AUDIT and VERIFY hard-deny the delegate tool;
- the worker role removes recursive delegation, free-form `bash`, and
  `workbench_run_gate` from its active matrix, with a hard guard if re-enabled;
- worker `edit`/`write` calls must match a parent-approved exact path or
  subtree; lexical plus realpath checks reject project escapes and symlink
  hops outside the approved subtree;
- the tool executes sequentially, propagates abort, enforces a timeout, and
  bounds stdout/stderr processing.

### Worker-first write authority (P7)

Approved GPT-5.6 Sol in DEV resolves to the fixed `worker-first-strict`
policy: the active tool set is exactly the canonical 14-tool allowlist
(`read`, `grep`, `find`, `ls` plus all ten `workbench_*` tools) — no
`bash`/`edit`/`write`, no foreign tools — and no persisted/prompt/config
value can weaken or opt out of it. Actor identity comes only from the
`WORKBENCH_AGENT_ROLE=worker` env contract and the provider/model pair;
project config can never self-label a controller as Sol or as a worker.
Workers and other controllers are outside the policy (the existing worker
guards remain authoritative; other controllers are not newly denied).

Second-layer `tool_call` guard for strict Sol: `bash` is always blocked;
`edit`/`write` require an ACTIVE user-issued temporary write lease
authorizing the project-relative path and the remaining call; every tool
outside the allowlist is blocked despite any re-enable. Leases are user-only
(`/q-commander-write-unlock`, `/q-commander-write-lock`, `/q-write-policy
status` — commands, never model tools), with fixed reasons
(`bootstrap-policy`, `worker-unavailable`, `security-emergency`,
`user-directed`), project-relative exact or `/**` subtree paths (absolute
POSIX, Windows drive and backslash-root paths are categorically rejected
before normalization; `..` escapes refused), `edit`/`write` only (never
`bash`), max 10 calls and max 30 minutes, and one call consumed per
successful authorized write. Confirmation is mode-split: the real TUI
requires an explicit human confirmation dialog; non-TUI issues a PENDING
lease whose two bounded distinct token parts are displayed exactly once and
must both be confirmed by a second invocation — both parts are consumed on
success and a confirmed lease can never be re-confirmed. Token parts never
appear in status/compact summaries or persisted summaries (`/q-write-policy
status` and the footer show only `WF:LEASE used/max` / `WF:LOCKED` facts).
Leases are revoked on leaving DEV, commander model/provider change, session
end, explicit lock, and they expire (30 min) or exhaust (10 calls) —
restoring the exact canonical 14 tools; restore is fail-closed (invalid
records restore to locked).

### Delegation ledger and review lifecycle (P7)

Every delegation — success **and** failure — is recorded in a bounded ledger
at `<project-root>/<CONFIG_DIR_NAME>/workbench/delegations/<id>/`
(`manifest.json`, `before.json` before the worker starts; `after.json`,
`worker-summary.json`, and a `review.json` PENDING_REVIEW placeholder at
finish). Records are written atomically (tmp + rename, mode 0600), bounded
(contract, per-path porcelain status codes + bounded content digests, diff
hashes, usage/budget facts, redacted report summaries — never full worker
transcripts or secrets), and the ledger's own directory is excluded from the
git facts it records so records never pollute the diff they describe. Git
facts come from argv-only `exec` calls (shell=false), never shell strings.

`workbench_review_worker_diff` (DEV-only, Sol) re-reads the REAL git state:
it scope-checks every worker path against the parent-approved `allowed_paths`
(realpath/symlink-safe; `include_paths` narrows only the patch and can never
hide a violation), compares the current diff hash with the recorded after
hash (mismatch/drift are warnings), warns when the worker's `## Files
Changed` section is missing or inconsistent with the actual diff, and writes
the completed `review.json` (atomic). Verdict `PASS` marks the delegation
REVIEWED bound to the CURRENT hash; `FAIL` keeps it PENDING_REVIEW. A
pending or stale review blocks the next delegation AND VERIFY (mode entry
and gate runs in VERIFY are refused); any diff change after REVIEWED turns
the delegation STALE (a diff returning to exactly the reviewed hash
re-validates). Blocked commander write attempts are counted while a review
is outstanding. The review lifecycle and the lease persist as custom
entries (`workbench-delegation-state`, `workbench-write-lease`) — durable
across compaction and session replacement — and restore fail-closed on
`session_start`.

B6 (Worker-First Compliance, P7) is a machine-backed universal base gate:
the runtime injects bounded worker-first facts into every gate run —
strict policy active, zero unauthorized commander writes (or hard denial
active), no pending/stale worker review, reviewed hash matches the current
diff, worker paths within the approved contracts, no active unexplained
write lease, and final verification initiated by the Sol commander. Missing
facts are NOT_RUN (a required NOT_RUN never PASSes), a pending/stale review
BLOCKs B6, and model prose can never satisfy B6.1-B6.8.

Context-budget protection (model-specific, independent of the
Commander/project compaction reserve):

- the pinned worker window is 1,000,000 context tokens; per-message tokens
  use Pi's normalized usage semantics (positive `totalTokens` wins,
  otherwise the non-negative `input + output + cacheRead + cacheWrite` sum);
- at 800,000 tokens (80%) the worker role sends one hidden steer to stop new
  implementation, finish a concise handoff, and list remaining work;
- at 900,000 tokens (90%) the runner terminates the child and the invocation
  fails closed;
- in the worker role only, `session_before_compact` is cancelled
  (`{ cancel: true }`) so a worker never silently continues through lossy
  compaction — the Commander's compaction behavior is unchanged;
- defense in depth: the runner counts `compaction_start` events (with
  distinct reasons) and any compaction attempt fails the result closed even
  if the child exits 0.

Only recipes with an empty declared `writes` list are available to a worker.
Recipe mutation policy (P7): every recipe declares
`mutation: none | artifacts | source`; delegated workers run only
`mutation: none` (write-free) recipes, and strict Sol runs only
`none`/`artifacts` recipes — `source`-mutating recipes are denied to both
(legacy inference maps non-empty declared `writes` to `source`, so this is
exactly as strict as the declared writes for legacy recipes; other
controllers are unaffected).
This blocks honestly declared mutating recipes, but recipes remain
trusted-project discipline mechanisms: a malicious command can write despite
an empty declaration. They are not an OS sandbox or a substitute for reviewing
repository configuration. Provider
credentials may be used by the child but are never copied into the task
message or tool details.

Every delegation is a fresh `--no-session` child — worker sessions are never
resumed (fresh-worker continuation), so no worker state persists between
delegations. The tool executes sequentially and a worker can never delegate,
so at most one writing worker exists per worktree at any time; Sol must not
start a second writing delegation before the first has returned and its diff
has been reviewed (a pending or stale review blocks the next delegation in
code as well). See
[worker-delegation.md](worker-delegation.md).

## Records and redaction

Run records (`manifest.json`, `command.json`, `environment.json`,
`summary.json`, `stdout.log`, `stderr.log`) are redacted:

- env vars whose names look like secrets (`*API_KEY*`, `*TOKEN*`,
  `*SECRET*`, `*PASSWORD*`, `*AUTH*`, `*CREDENTIAL*`, `*PRIVATE_KEY*`,
  ...) are stored as `[REDACTED]` in `environment.json`;
- well-known credential shapes (OpenAI `sk-...`, GitHub `ghp_...`, Google
  `AIza...`, Slack `xox...`, AWS `AKIA...`, JWTs) are scrubbed from every
  log and record;
- argv entries of the form `--key=value` whose key names a credential
  carrier (`--api-key=...`, `--token=...`, `--password=...`, `--auth=...`)
  are redacted in `manifest.json`/`command.json` — with word-boundary
  parsing so `--tokenizer=...` or `--auth-type=...` are never touched;
- redaction is applied to stdout/stderr before writing logs, to summaries,
  and to the compaction note.

**Never written to records:** API keys, tokens, full environment, auth
material. Redaction hides secrets from *records*; it does not stop a process
from *using* them.

## Secret content in surfaces

No secret content appears in logs, manifests, error messages, the TUI
status/widget, or reports: all display paths consume redacted or
structural data (run ids, gate ids, paths). `workbench_project_inspect`
never outputs environment values. Lease confirmation token parts appear
only in the non-TUI issuance output and are never written into status or
compact summaries; delegation ledger and review records are redacted and
bounded.

## Path traversal and symlinks

- Run ids are strictly validated (`^\d{8}-\d{6}-[A-Za-z0-9]{4}$`) before
  any filesystem path is constructed from them.
- Recipe `cwd`, `writes`, and `artifacts` are containment-checked:
  lexical (`..`, absolute escapes) plus realpath (symlinks inside the
  project pointing outside are rejected, including for not-yet-existing
  paths via deepest-existing-ancestor resolution).
- Evidence paths are containment-checked the same way; escaping paths abort
  the gate run with a setup error.

## Log growth

- Run logs are truncated with Pi's official helpers (2000 lines / ~50 KB in
  summaries; `workbench_read_run` returns 200-line / 20 KB tails by
  default). Full content stays on disk at the run directory.
- The compaction supplement is bounded (40 lines / 2.4 KB), deduplicated,
  and never contains run log content — it only carries pointers (run ids,
  gate ids, evidence paths).
- Workbench state entries are bounded lists (20 modified files, 10 evidence
  paths, 8 do-not-retry notes, 12 gate ids).

## Compaction

In the commander session the workbench never cancels Pi compaction and never
replaces Pi's summary. On `session_before_compact` it may add (only when
there is meaningful state) a hidden, bounded note — task, mode, gates, last
run, evidence paths, next step, do-not-retry — via
`pi.sendMessage(..., { deliverAs: "nextTurn" })` and a durable custom entry.
No run logs are ever written into the session context.

Inside a delegated worker process the same event is cancelled
(`{ cancel: true }`) so a worker never silently continues through lossy
compaction; the runner additionally fails closed on any `compaction_start`
event and on the 90% hard context budget (see Controlled worker delegation
above).

## Cache layer (P6)

### Privacy properties

- Telemetry records are **hash-only**: a deep forbidden-key scan
  (`prompt`, `content`, `text`, `messages`, `toolInput`, `toolResult`,
  `apiKey`, `auth`, `secret`, `token`, `sessionId`, `cwd`, `env`, `files`,
  …) refuses any record before disk; `systemPromptHash` is a hash, never
  the prompt. Provider payloads are only structurally digested (roles,
  lengths, per-segment SHA-256, tool names) — never copied, never mutated.
- The benchmark CLI (`scripts/cache-benchmark.ts`) is observation-only: no
  model calls, no HTTP, no `auth.json`, no `models.json`/`models-store.json`
  access, no warmup/keepalive, no cache_control/prompt_cache_key/
  prompt_cache_retention, no TTL configuration, no hardcoded provider
  prices (`estimatedAvoidedCost` requires an explicit `--cost-map`). The
  only write it ever performs is an optional new file in
  `.pi/workbench/cache/reports/` via `--save` (atomic, sanitized, contained).
- Action records store hashes of env values, never values; recipe output is
  redacted and truncated before it reaches the model context.

### Corruption and tampering

- Corrupted action JSON or key/schema mismatches → quarantined copy in
  `tmp/` + treated as a miss (a wrong cached answer is impossible by
  construction).
- `cache-index.json` is rebuildable from `actions/`; the benchmark doctor
  detects entry/record mismatches (index drift is never trusted blindly).
- CAS (v1: disabled) would re-verify SHA-256 and quarantine mismatches.
- Telemetry read skips and counts bad lines; a record with forbidden keys
  is refused at write time.

### Concurrency and locks

- Per-key lockfiles carry `{key, token, ownerPid, createdAt}`; a lock whose
  owner is alive is never broken; dead-owner locks older than 60 s are
  broken; lock-wait timeouts proceed without the lock (cache writes become
  best-effort — never a task blocker). The benchmark counts stale locks as
  `fallbackCount` evidence.

### Storage bounds and deletion safety

- Telemetry rotates at 5 MB (max 5 archives, oldest dropped); the action
  cache prunes by LRU against a budget (default 256 MB); report files are
  written only on explicit `--save`/`/q-cache-report --save`.
- `/q-cache-prune` and `/q-cache-clear` **never** delete run records,
  evidence, telemetry or reports; `.pi/workbench/cache/` and `runs/` are
  gitignored.

### Caching vs gates

- Recipe cache hits materialize a **new** run manifest
  (`execution_source: "cache"`) and re-validate through the full gate
  ladder; quant contracts re-validate at key time AND write time;
  backtest-result hits re-verify `resultArtifactHash`; mutable
  `latest`/`current` ids are never cache keys; failed folds are never
  filtered.

## What is out of scope

- HFT, L2/LOB order books, market making, queue position, matching engines,
  millisecond/microsecond latency work, exchange order routing, live
  high-frequency execution, colocation — explicitly out of scope and not
  implemented anywhere in the package.
- The workbench implements no backtesting engine; it only validates what a
  target project declares in `results/quant-result.json`.
- No standalone agent and no standalone service ships in this package — it
  is a Pi extension and does nothing outside a Pi session.
