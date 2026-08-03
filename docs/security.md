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
has been inspected. See
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
never outputs environment values.

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
