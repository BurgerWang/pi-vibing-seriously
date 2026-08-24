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
- the child selector is pinned to `openai-codex/gpt-5.6-luna:xhigh`, and
  assistant provider/model drift fails closed;
- AUDIT and VERIFY hard-deny the delegate tool;
- the worker role removes recursive delegation, free-form `bash`, and
  `workbench_run_gate` from its active matrix, with a hard guard if re-enabled;
- worker `edit`/`write` calls must match a parent-approved exact path or
  subtree; lexical plus realpath checks reject project escapes and symlink
  hops outside the approved subtree;
- the tool executes sequentially, propagates abort, enforces a timeout, and
  bounds stdout/stderr processing.

### Fixed Sol -> Luna write authority (current; legacy id P7)

Approved GPT-5.6 Sol in DEV receives the fixed 15-tool read/control/delegation
surface; `bash`, `edit`, `write`, and foreign tools stay unavailable by
default. The serialized `worker-first-strict` policy id describes the active
product behavior: routine development is implemented by Luna. Actor identity comes only from the
`WORKBENCH_AGENT_ROLE=worker` env contract and the provider/model pair;
project config can never self-label a controller as Sol or as a worker.
Workers and other controllers are outside the policy (the existing worker
guards remain authoritative; other controllers are not newly denied).

Second-layer `tool_call` guard for Sol: `bash` is always blocked; any direct
canonical project-relative `edit`/`write` requires an ACTIVE user-issued
temporary write lease plus project realpath containment. Every tool
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
restoring the locked Sol surface. Invalid lease records fail closed for all
direct commander edit/write paths.

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

The v2 transaction lock protects individual atomic updates; a separate
bounded `execution-owner.json` protects the complete PREPARED/RUNNING worker
lifetime. It binds boot id, PID, process-start identity, delegation, contract,
and pinned worker identity. Restart reconciliation auto-terminates only a
provably dead, artifact-free transaction whose write journal contains no
attempted path, completed path, byte read, or operation. Historical ownerless
records additionally require both durable record mtimes and the transaction
time to predate the current system boot. PID reuse is detected by process-start
identity. Any write evidence, COMMITTING state, live/unknown owner, malformed
record, extra artifact, or storage uncertainty remains fail-closed.

New public worker contracts are normalized and bounded before any authority
work: meaningful internal task/criterion layout is preserved, duplicate
comparison keys are removed deterministically, 12 KiB is the ordinary soft
ceiling, and 64 KiB is absolute. Exceeding the soft ceiling requires explicit
`extended` budget plus a bounded `extended_reason`; neither expands path or
review authority. Verification input is restricted to `recipe:<name>` and is
checked both before transaction work and immediately before launch against a
valid `recipes.yaml`: the recipe must exist, declare `mutation:none`, and have
no required parameters. Empty verification remains compatible and does not
load the catalog.

A known-root-cause `repair_of` starts a fresh no-session worker. A wrong
`PENDING_REVIEW` delta is eligible only after active Sol inspects its complete
current packet and publishes an immutable hash-bound `REPAIR` decision; the
decision is negative authority and never grants review or Gate PASS. The child
capsule remains at most 8 KiB and contains typed machine facts only. An
unresolved semantic lineage also binds the cumulative rejected W/D paths,
exact-file scope, root plan presence/hash, root decision, and latest
continuation decision so the bad delta cannot be laundered into a new baseline.
No old transcript, report prose, logs, error text, or session crosses the
boundary.

`workbench_review_worker_diff` (DEV-only, Sol) re-evaluates the CURRENT
workspace authority. Every record generation scope-checks all worker-delta
paths W against the parent-approved `allowed_paths` (realpath/symlink-safe;
`include_paths` narrows only the patch and can never hide a violation). For
new tagged v2, the current authority binding is the W/D/S relevance
projection: W is the attributed worker delta, D is the explicit dependency
closure, and S is the closed relevant control set. Baseline unrelated dirty
paths and recognized workbench artifacts are excluded, while Git HEAD,
W/D/S drift, or a new unknown-origin path fails closed. Historical untagged
v2/v1 instead re-reads the real Git facts and binds the complete current
full-diff hash. The review compares that generation-specific current binding
with the recorded after binding (mismatch/drift are warnings), warns when the
worker's `## Files Changed` section is missing or inconsistent with W, and
writes the completed `review.json` atomically. The tool is callable
repeatedly on the latest delegation (PENDING_REVIEW / STALE / REVIEWED), and
EVERY call refreshes the appropriate generation-specific authority and the
full scope check over all W. `include_paths` only narrows the rendered patch,
so a segment can never skip a scope check or its authority binding.

Presentation coverage is machine-derived from the actually rendered patch
entries: a globally omitted path never counts. An ordinary truncated source
entry is visible but incomplete. When exactly one ordinary source path is
selected, repeated calls continue a contiguous UTF-8 byte cursor bound to the
same current diff and complete redacted-stream SHA-256 (bounded at 4 MiB);
only a page whose full title and body fit the final tool envelope advances the
cursor. The provisional record carries a contiguous per-page receipt chain;
before Sol ACCEPT, the runtime rebuilds every current redacted source/diff
stream and checks its source, total, full-stream hash, every receipt range/hash,
and the current visible page slice. Gaps, overlaps, stream changes, cut pages,
self-asserted PENDING acceptance and malformed cursor facts fail closed, while
a bound-hash or redacted-stream change resets progress. A sufficiently large current regular
`.svg`/`.json` may instead carry strict bounded compact facts: status, size,
digest binding, bounded head/tail previews, and explicit
`generator_equality: NOT_VERIFIED`. Only a complete validated compact packet
may count without the full generated bytes. Prior presentation coverage
merges ONLY from persisted `review.json` with the SAME `bound_diff_hash` and
valid worker-path membership; a hash change resets it. Legacy records remain
readable, but persisted coverage/completeness claims are recomputed and never
trusted by themselves.

These receipts are a crash/reload continuity and accidental-corruption
guardrail, not a cryptographic attestation that a human/model paid attention.
As stated in the honest threat model, a malicious actor with the same OS user
permissions can read the real source and rewrite workbench files; that actor is
outside this package's security boundary. Use an isolated container/VM and
external audit storage when that threat matters.

Mechanical verdict and semantic acceptance are separate authorities. The
normal delegation result and the first review call may persist only a
provisional scope/integrity packet; every non-zero delta stays
`PENDING_REVIEW` even when scope is `PASS`. After inspecting the complete
current packet, Sol makes a second call with the pair
`semantic_decision=ACCEPT` and the exact `expected_bound_diff_hash`. The
runtime verifies the active Sol identity, rechecks current authority, and
atomically binds decision, reviewer provider/model, hash, and timestamp. One
field without the other, first-call acceptance, legacy or non-migratable
finalized mechanical authority, incomplete or handoff-clipped presentation,
an unfinished ordinary-source page sequence, corrupt compact/page facts,
drift, and hash mismatch all fail closed.
Zero actual delta alone is `semantic_review:not_required`. For a complete but
wrong current packet, `semantic_decision=REPAIR` additionally requires the
exact bound hash and bounded reason. It atomically creates an immutable
`v2/repair-decision.json` negative sidecar, leaves the transaction
`PENDING_REVIEW`, and enables only the reported exact fresh `repair_of`
lineage. The project remains Gate-blocking.

Every semantic-repair start is serialized by a project lock bound to OS boot,
PID, and process-start identity. The child carries root and continuation
decision hashes plus cumulative scope. Reload, status, read-only Gate facts,
and formal Gate execution audit the complete bounded lineage graph: siblings,
hidden active work, missing/tampered decisions, plan drift, unsafe owner/journal
recovery, and unknown artifacts fail closed. A dead terminal execution owner
is removed only by exact-token recovery; a live or unverifiable owner never
authorizes a second worker. A lineaged `ABORTED` record remains part of the
unresolved obligation and never authorizes an unrelated fresh delegation. It
may be continued only by the exact reported `repair_of` after the runtime
proves a known before-write abort reason, absent owner, pristine or missing
journal, and exact v2 inventory. Non-lineaged recovered aborts remain terminal
FAIL compatibility data rather than semantic repair authority.

An upgrade-era immutable schema-2 mechanical `FINAL/PASS` is likewise never
relabelled or rewritten as semantic acceptance. Its only compatibility path is
a two-step historical migration review: active Sol first inspects the complete
immutable packet plus a freshly collected migration binding, then calls again
with `semantic_decision=ACCEPT`, `expected_bound_diff_hash`, and
`expected_migration_binding_hash`. The binding requires a descendant HEAD whose
raw committed delta contains exactly the historical W/checked paths, every
current W path is clean, current W/D/S content is exact, and the non-W baseline
guard is unchanged; extra paths, content or mode drift, and non-descendant
history fail closed. Acceptance is stored in a
separate hash-bound supplement and grants no Gate authority. A fresh exact
`repair_of` is expressly not a recovery route because it would absorb the
unaccepted delta into a new baseline; the old review and transaction bytes
remain immutable.

`PASS` plus complete presentation plus durable semantic acceptance marks the
delegation REVIEWED bound to the CURRENT authority binding; `FAIL` keeps it
PENDING_REVIEW, and ANY re-review of the SAME current authority binding that
is not PASS with complete presentation (a scope FAIL or an incomplete PASS,
e.g. a legacy partial review record) invalidates a prior REVIEWED state
fail-closed (demoted to
PENDING_REVIEW with the reviewed hash cleared — pending/stale stay safely
blocking). A pending or stale review blocks VERIFY (mode entry and gate runs
in VERIFY are refused) and normally blocks the next delegation. The sole
successor exception requires the exact latest mirror to be STALE and a strict
committed v2 read to prove its immutable review is FINAL/PASS with explicit Sol
semantic acceptance; after a second pre-launch authority check, a fresh
delegation may adopt the current workspace as its new baseline. It does not
rewrite the old review or use `repair_of`. Pending, corrupt, unpublished, recovery-required, non-final,
legacy, and untagged authority remain blocked. New tagged v2
uses a W/D/S relevance binding: baseline unrelated dirty paths and recognized
workbench artifacts do not stale it, while Git HEAD, W/D/S, or a new
unknown-origin path fails closed. Historical untagged v2/v1 retains the
complete full-diff binding, where any diff change after REVIEWED turns the
delegation STALE. A binding returning to exactly the reviewed hash
re-validates. Blocked commander write attempts are counted while a review is
outstanding. The review lifecycle and the lease persist as custom
entries (`workbench-delegation-state`, `workbench-write-lease`) — durable
across compaction and session replacement — and restore fail-closed on
`session_start`.

Optional delegation `plan_ref` input is traceability, never authority. Its
strict nested shape is canonical-hash-bound into the existing v2 contract;
the referenced regular file must remain inside the project after realpath
resolution, fit the fixed 1 MiB read ceiling, and match the supplied SHA-256
both before transaction work and immediately before worker launch. Unsafe
paths, proxies, unknown fields, concurrent-change detection, and digest drift
fail closed. The reference adds no allowed path, review verdict, evidence
status, or Gate PASS.

Plan continuity also fails closed: after the latest strict committed
delegation carries a plan reference, a successor cannot omit it to erase the
binding. It must explicitly retain the current reference or supply another
strict, current reference; no plan status string (including `EVIDENCED`)
releases the obligation. This uses the immutable delegation chain directly
and creates no writable active-plan state.

Gate execution never trusts the injected plan facts by themselves. Immediately
before run allocation it strict-reads the latest committed contract and repeats
the bounded contained-byte verification; drift, unsafe paths, unreadable data,
invalid generations, or a fact mismatch setup-fail and produce no reusable
authority. Final `base`/`all` selection must cover every mapped Gate (`base`
cannot close a quant mapping), and every mapped Gate must be `PASS`. Focused
selectors may return development feedback but persist `PARTIAL`, unsuccessful
validation authority. The validation target binds the plan-reference hash,
sorted mapped Gate ids and coverage; read-time assessment re-verifies current
bytes and coverage. None of these checks can promote a Gate result.

B6 (Development Safety; legacy P7 machine kind `worker-first`) is a
machine-backed universal base gate: the runtime injects bounded safety facts
into every gate run — development policy active, zero unauthorized high-risk writes (or hard denial
active), no pending/stale worker review, reviewed hash matches the current
diff, worker paths within the approved contracts, no active unexplained
write lease, and final verification initiated by the Sol commander. Missing
facts are NOT_RUN (a required NOT_RUN never PASSes), a pending/stale review
BLOCKs B6, and model prose can never satisfy B6.1-B6.8.

Context-budget protection (model-specific, independent of the
Commander/project compaction reserve):

- the Pi-advertised pinned worker window is 272,000 context tokens; per-message tokens
  use Pi's normalized usage semantics (positive `totalTokens` wins,
  otherwise the non-negative `input + output + cacheRead + cacheWrite` sum);
- at 217,600 tokens (80%) the worker role sends one hidden steer to stop new
  implementation, finish a concise handoff, and list remaining work;
- at 244,800 tokens (90%) the runner terminates the child and the invocation
  fails closed;
- in the worker role only, `session_before_compact` is cancelled
  (`{ cancel: true }`) so a worker never silently continues through lossy
  compaction — the Commander's compaction behavior is unchanged;
- defense in depth: the runner counts `compaction_start` events (with
  distinct reasons) and any compaction attempt fails the result closed even
  if the child exits 0.

Cumulative spend-budget protection (Phases 1–5 of the approved worker
token-budget repair; `core/worker-spend.ts` pure policy, **wired into the
runtime since Phase 2**, public selection + ledger/handoff persistence
since Phase 3, numeric-only progress since Phase 4, task-contract profile
wording and granularity guidance since Phase 5):

- operates independently of the per-message context budget above (which is
  unchanged) and accumulates turns, total tokens and output tokens over
  all assistant messages of a delegation run;
- two active profiles — `extended` (the safe default), `standard`
  (explicit for clearly small bounded slices) — with exact soft/hard turns,
  total-token and output-token limits; "reached" means at or above (`>=`);
- per-message totals reuse the context-budget semantics (positive
  `totalTokens` authoritative, else the non-negative
  `input + output + cacheRead + cacheWrite` sum; `cacheRead` counts); the
  output dimension is normalized independently; malformed, non-finite or
  negative values contribute zero — never NaN, never a crash;
- band evaluation `ok | soft | hard` with hard-over-soft precedence and
  the fixed reason order `turns`, `total_tokens`, `output_tokens`;
- deterministic soft-steer text (one hidden steer per delegation), hard-stop
  reason text, and spend summary formatters; the runner terminates the
  child fail-closed on any hard dimension (the deterministic hard-stop
  message names the winning dimension(s) and values) and the worker-role
  lifecycle sends exactly one hidden cumulative soft steer (worker role
  only — the commander session never receives it, its own one-shot flag
  independent of the context steer, send failures swallowed);
- the spend profile reaches the child through the fixed
  `WORKBENCH_WORKER_SPEND_PROFILE` env contract (the runner always writes
  a valid active value; retired `low` and malformed/missing child env fall back to `extended`
  defensively); public profile selection is an optional `budget_profile`
  tool parameter (closed literal union `standard | extended`,
  default `extended`) validated fail-closed by
  the pure contract check in `core/worker-policy.ts` BEFORE any ledger
  creation or child launch; the resolved profile is recorded in the before
  contract and the canonical cumulative `spend` object (profile, turns,
  total/output tokens, band, per-dimension soft/hard flags, fixed-order
  reasons) is persisted additively in `usage.json` / `worker-summary.json`
  on every finished success and failure (schema_version stays 1;
  pre-repair records read without migration and are never rewritten); the
  bounded parent handoff renders the deterministic spend summary line and
  nested spend details from the SAME persisted worker-summary spend
  object;
- progress events (Phase 4) expose numeric-only cumulative spend counters
  (turns, total/output tokens, fixed `ok | soft | hard` band) plus the
  pinned provider/model identity — never worker text, reasons, report
  content, tool arguments, patches, logs, or error prose; the starting/
  running onUpdate keeps the exact
  `Pinned worker: N turn(s), model provider/model` text prefix and adds
  only deterministic counters/band;
- the 60-minute timeout remains an independent failure path.

Historical committed v1/v2 records with `low` remain read-only compatible.
The public contract and new committed-artifact boundary reject `low` before
persistence or launch; runtime/internal `low` inputs never execute below the
safe `extended` default limits.

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
has been reviewed. A strict finalized-v2 STALE successor is a new sequential
task after the old worker and immutable review have both completed; it never
creates concurrent writers. See
[worker-delegation.md](worker-delegation.md).

## Records and redaction

Run records (`manifest.json`, `command.json`, `environment.json`,
`summary.json`, `stdout.log`, `stderr.log`) are redacted:

- new recipe and gate runs are assembled in a hidden staging directory and
  become visible only after all required payload files and their full-byte
  identities have been strictly read back; one directory rename publishes the
  run and `run-commit.json` binds the complete file inventory;
- newly published run manifests use top-level `schema_version: 2` as well as
  the v2 transaction marker. Historical schema-v1 manifests remain read-only;
  mixed v1/v2 and unknown versions fail closed. This prevents v1-only code
  from accepting a current run as v1 SUCCESS;
- a visible directory without a valid v2 commit record is diagnostic/partial,
  never gate authority; the newest same-recipe partial, failed, or corrupt run
  blocks rather than causing fallback to an older success;
- artifact gates accept only a committed successful run with a valid v2
  artifact manifest. Current files are rehashed at consumption time;
  immutable snapshots are content-addressed and verified inside the committed
  run;
- external artifact roots are disabled unless a trusted project explicitly
  maps a bounded name to an absolute directory. Collection and current-state
  gate validation both use a separate process probe; symlink escapes,
  unavailable roots, identity races, and root remapping fail closed.

Before any rollback to v1-only code, the read-only
`npm run governance:rollback-check` inventory must report safe. Any v2,
partial, corrupt, mixed, unknown, unavailable, or over-limit authority blocks
that rollback; no record is migrated, quarantined, rewritten, or deleted. See
[governance-recovery.md](governance-recovery.md).

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

**P0 session observability is numeric-only (commander-token-optimization
plan §6).** The split cost breakdown counts commander requests, compactions
and per-tool inline TEXT bytes over session entries; tool **arguments are
never inspected** and result text is counted as UTF-8 bytes only — it is
never stored, rendered, or otherwise surfaced by the attribution
(`/q-cost-status` shows counts, IDs and tool names only).

**P1 parent-result summaries are bounded presentation (plan §8).** The
`workbench_run_recipe` / `workbench_run_gate` tool results and `/q-run` /
`/q-gate` output are bounded summaries (4096 bytes/40 lines success,
12288 bytes/120 lines failure) that never inline raw successful
stdout/stderr or per-test lines, inline bounded excerpts on failure only
after the required facts, and always reference the full persisted logs by
path. Summaries are never acceptance evidence and never rewrite persisted
records.

**Slice B1 run-result presentation is layered and bounded (plan P2).**
`workbench_read_run` defaults to a machine-derived
Summary/Evidence/Persisted view (≤ 4096 UTF-8 bytes / 40 lines,
control characters sanitized — a field can never inject extra lines —
and code-point-safe truncation) that never inlines raw stdout/stderr,
per-test lines, or argv, always states the exact opt-in instruction for
bounded tails (`include=logs` / `include=all`) in a REQUIRED
Evidence-layer guidance line that survives adversarial fields/lists and
the caps, and never silently loses machine facts: optional cache/quant
lines that cannot fit the caps are dropped lowest-priority-first and
recorded in the aggregate, and bounded/truncated metadata/path/list
displays carry an explicit durable-source fact (manifest.json / run
record / disk) precomputed before the aggregate omissions line is
emitted. It always references the durable project-relative
run-dir/manifest/summary/stdout/stderr paths. Explicit
`manifest`/`logs`/`all` includes add bounded manifest metadata
(cwd/argv) and, for `logs`/`all`, only the caller-bounded log tails
(default 200 lines / 20 KB per stream; custom schema-bounded
max_lines/max_bytes honored) — the renderer never reads or re-bounds
logs. Records on disk are never rewritten.

## Path traversal and symlinks

- Run ids are strictly validated (`^\d{8}-\d{6}-[A-Za-z0-9]{4}$`) before
  any filesystem path is constructed from them.
- Recipe `cwd`, `writes`, and `artifacts` are containment-checked:
  lexical (`..`, absolute escapes) plus realpath (symlinks inside the
  project pointing outside are rejected, including for not-yet-existing
  paths via deepest-existing-ancestor resolution).
- Evidence paths are containment-checked the same way; escaping paths abort
  the gate run with a setup error.

## Tool-result receipt recovery (P8a core + P8b wiring)

`core/tool-result-recovery.ts` persists two-phase tool-result receipts
(`.pi/workbench/tool-results/<id>.started` + `<id>.json`, schema `wtr1`),
wired into the Pi tool lifecycle in P8b. What it protects:

- **Receipts protect side effects, not reads.** Recipe/gate execution,
  delegation and review keep the two-phase replay guard. Project inspect,
  run/gate reads and lists, comparison, delegation status and receipt recovery
  are safely replayable and create no result receipt.

- **Raw input never persists.** Only the exact tool name and a canonical
  SHA-256 hash of the raw input are persisted; raw arguments, the native Pi
  session identity, the toolCallId, env secrets and token-shaped values are
  never written. Non-JSON inputs are rejected before any write.
- **BEGIN only after every policy guard allows.** The started receipt is
  created at the END of the `tool_call` guard — after every
  worker/commander/mode/path/lease check has allowed — and BEFORE the tool
  executes. A matching completed replay and every incomplete/corrupt/
  conflict/invalid/storage outcome block the call fail-closed with a short
  fixed reason (with a recover instruction); the tool never re-executes.
- **Capacity blocks, never evicts.** At `MAX_IN_FLIGHT_RECEIPTS` (256)
  in-flight in-memory handles, a new registered workbench call is blocked
  BEFORE begin/execution with a fixed bounded reason; existing pending
  handles are never evicted and nothing is begun for the blocked call, so
  no started receipt is left orphaned.
- **Finalize requires the EXACT dual match.** One `tool_result` handler
  finalizes ONLY a handle begun by this runtime whose toolCallId AND tool
  name both match exactly; a tool-name mismatch never finalizes (the
  started receipt stays incomplete, the in-memory handle is consumed, and
  only a bounded `tool_name_mismatch` fact is reported). Text blocks only,
  env-secret values scrubbed, status success/error, bounded redacted
  summary. Failure never claims availability and never rewrites or rolls
  back the domain artifact.
- **Redaction first, then caps.** Existing env/token redaction runs over
  the FULL content before explicit UTF-8 byte/line caps apply (summary ≤
  2048 bytes / 20 lines, error ≤ 512 bytes / 8 lines), so a secret at the
  truncation boundary is already replaced; truncation is code-point safe,
  the `\n[truncated]` marker's byte AND line space is reserved inside the
  caps, and control characters are sanitized per line. The bounded
  renderer carries a fixed disclaimer and never renders absolute
  project/session paths.
- **Path safety and permissions.** Receipt ids are strictly validated
  (`^wtr1-[0-9a-f]{64}$`) before any path is built; the receipt directory
  is realpath-containment-checked before AND after mkdir (an escaping
  symlink at `.pi`/`.pi/workbench`/`tool-results` blocks every entry point
  before any write); the directory is 0700, artifacts 0600; reads lstat
  each artifact and reject symlinks, directories and oversized files.
- **Fail closed, no overwrite.** Existing receipts are strictly parsed and
  cross-checked; corruption, unsafe/oversized artifacts, missing-started
  and cross-phase mismatches are never reported completed. Both phases
  publish atomically with no-overwrite semantics (tmp + hard link); an
  existing finalized artifact is never replaced. Recovery is strictly
  read-only and deterministic.
- **Recovery session validation.** The public
  `workbench_recover_tool_result` tool (read-only, in AUDIT/VERIFY and the
  strict Sol DEV allowlist; not receipted itself) accepts EXACTLY ONE of
  `result_id` (strict `wtr1-` shape) or `tool_call_id`. The `tool_call_id`
  path validates the CURRENT native Pi session identity AND the parameter
  (absent/invalid/control-character/over-bound fails closed with the fixed
  `invalid` code and hashes nothing) BEFORE deriving the id. Fixed
  fail-closed codes: `invalid`, `missing`, `incomplete`, `corrupt`,
  `conflict`, `storage_error`. Recovery never re-executes the original
  call, reads no raw logs/domain records, and performs no refresh.
- **Isolation and repository hygiene.** Receipts never touch
  run/cache/gate/delegation artifacts or execution counts;
  `.pi/workbench/tool-results/` is gitignored, and the delegation ledger
  excludes the receipts subtree from the git facts it records exactly like
  its own records (sibling-safe prefix match).
- **Legacy additive.** Legacy run/cache/delegation/domain records are never
  read, migrated, or rewritten; unknown-schema receipts fail closed.

The receipt layer is a hygiene and recovery layer for receipt files, not a
security boundary; persisted receipts are presentation, never acceptance
evidence. This repository implements no WebSocket or any other transport —
receipts are local files with no network path.

## Native tool overrides (NRO N1/N2)

Slices N1+N2 of `docs/plans/commander-native-tool-optimization.md` register
three fixed same-name overrides of the Pi built-in `read`/`grep`/`find`
tools (statically, fixed `read → grep → find` order, BEFORE the unchanged
11-tool `WORKBENCH_TOOL_NAMES` catalog; the resolved tool list the model
sees is unchanged). Security properties:

- **Exact-name guards remain authoritative.** The layer-2 `tool_call` guard
  intercepts by exact tool name BEFORE execution, so it still sees
  `toolName === "read"` / `"grep"` / `"find"` exactly as for the built-ins:
  AUDIT/VERIFY protected-path read blocking, VERIFY/AUDIT hard denials, DEV
  allowances, the `PATH_ARG_TOOLS` path-policy set, the mode matrices and
  the strict-Sol canonical 15-tool allowlist behave exactly as before. The
  mode/write inventories and `WORKBENCH_TOOL_NAMES` (11) are unchanged —
  the overrides are same-name replacements, never new tools, and never
  enter the write-authority/lease lists.
- **No new capability surface.** The overrides add **no write path, no
  shell, no `pi.exec`, no model calls, and no cache/session/ledger
  mutation**: `find` delegates to the built-in definition byte-for-byte,
  `grep` delegates every legacy branch byte-for-byte and runs its
  `output=count` branch through the dedicated read-only rg adapter, and
  `read` delegates everything except the deterministic preview (explicit
  `offset`/`limit`, images, errors, abort). There are exactly two read-only
  second-read cases: the >50KB-first-line full-file fallback (`readFile` of
  the whole target — read-only but not byte-bounded, since the built-in
  cannot return that content) and the image-note magic-byte sniff (≤ 4100
  bytes, validating a text-only built-in image note — failed decode/resize
  or unprocessed BMP — against the source's magic bytes). Both go through
  the policy module's Pi-equivalent path normalization and never mutate
  files, caches, session state, or ledgers: the overrides are pure readers
  like the built-ins they replace.
- **Grep count execution is direct, read-only and fail-closed.**
  `output=count` runs the installed ripgrep engine through the Pi-free
  adapter (`core/native-search-adapter.ts`) with an explicit argument
  vector and `shell:false` — no shell, no `pi.exec`, no downloads, no
  writes, no model calls, no cache/session/ledger mutation. The binary is
  resolved managed-first (`PI_CODING_AGENT_DIR` or `~/.pi/agent/bin/
  rg[.exe]`) and then the system rg on PATH; an unavailable rg fails
  explicitly (`ripgrep (rg) is not available`). Output is parsed strictly
  from the `path\0count\n` framing (`--with-filename --null`): malformed
  records, spawn/execution failure and abort (pre-abort or mid-scan,
  including Pi's timeout abort) all fail explicitly — never a partial
  count; zero matches is an exact `value=0` result, not an error. The
  search path resolves with Pi 0.83.0 `resolveToCwd` parity (unicode-space
  normalization, leading-`@` strip, tilde expansion, `file://` decoding)
  and a missing path fails with the built-in's own `Path not found:` text,
  so the exact-name guard, protected-path policy and mode semantics keep
  behaving exactly as for the built-ins.
- **No hidden truncation.** A preview is never presented as a complete
  read: every no-offset text result states the frozen nine-fact
  `nro-read-facts:` line (`complete` … `line_truncated`), and `details`
  carries at most a valid built-in `ReadToolDetails.truncation` object —
  no additive keys.
- **Deterministic and static.** Preview text and facts are deterministic
  functions of (file bytes, fixed caps); the count line is a deterministic
  function of (search path, flags, rg output); override metadata contains
  no dynamic facts. The one intentional metadata/schema transition (the
  single combined N1/N2 delta) is a documented, one-time fingerprint
  transition, not ongoing churn.
- **NRO savings/adoption are NOT_MEASURED.** No token-savings or adoption
  claim is made; N4 (Commander-owned measurement/verdict) has not run.

## Log growth

- Run logs are truncated with Pi's official helpers (2000 lines / ~50 KB in
  summaries; `workbench_read_run` returns a bounded
  Summary/Evidence/Persisted summary by default (≤ 4096 bytes / 40 lines,
  no raw log content, no argv, with the exact `include=logs`/`include=all`
  opt-in instruction for bounded tails always stated in the Evidence
  layer) and caller-bounded 200-line / 20 KB log
  tails only for the explicit `logs`/`all` includes). Full content stays
  on disk at the run directory.
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

Compact-attempt records are append-only. A successful native compact, a known
cancellation, and an extension fallback callback are terminalized immediately;
Pi 0.84.2 exposes no extension event for an otherwise unobserved native
provider failure, so that orphan `started` record is terminalized exactly once
at the next `session_before_compact` or `session_start`. Synchronous terminal
observation for that one path is `BLOCKED_BY_PI_0_84_2_PUBLIC_API`. If Pi has
already started native overflow compaction, failure or cancellation produces a
handoff and the workbench does not launch a second automatic compact.

Inside a delegated worker process the same event is cancelled
(`{ cancel: true }`) so a worker never silently continues through lossy
compaction; the runner additionally fails closed on any `compaction_start`
event and on the 90% hard context budget (see Controlled worker delegation
above).

## Milestone session handoff (P5)

`/q-milestone-handoff <next step>` is the user-only lifecycle command that
carries workbench state into a fresh parent-linked session (an ordinary
`/new` stays a fresh/DEV session that copies nothing). Privacy and safety
properties:

- **Explicit next step is redacted exactly once.** The user-supplied next
  step is trimmed, passed through the env-secret redactor (secret-looking
  env values plus well-known credential shapes) and re-capped AFTER
  redaction (a `[REDACTED]` replacement can grow the text; caps are applied
  code-point and UTF-8 safe). The SAME normalized value is stored in
  `record.next_step` and in the copied `state.nextStep` — a pre-existing
  compact snapshot's `nextStep` (possibly stale or undefined) never reaches
  the record or the target, so a secret cannot persist via the snapshot or
  reach model context twice. The command parser still rejects empty and
  overlong raw user input up front; prepare only re-caps the redacted value
  and never silently accepts unbounded input.
- **The absolute source session path never enters model context.** The
  hidden note renders only the fixed fact `source session: parent-linked
  (pointer persisted outside model context)`. The parent link lives outside
  LLM context: the custom lifecycle record (persisted pointer) and the
  session parent linkage (`ctx.newSession` uses the original full session
  file). The visible replacement-context user notification may show the
  source path — that is a user notification, not model context.
- **Every record string is bounded and redacted by `prepare`.** Milestone
  id, next step, session pointer and timestamp are redacted against the
  collected env secrets and truncated code-point-safely to their persisted
  caps, so the handoff can never build a record that its own fail-closed
  loader rejects or that violates record bounds.
- **Hidden note bounds are hard and marked.** The note is limited to 40
  lines / 2400 chars / 4096 UTF-8 bytes; every truncation mode (dropped
  lines, char cuts, byte cuts) appends `[truncated]` with the marker's
  space reserved INSIDE all three caps, so the final output never exceeds
  any bound and truncation is never silent. The note is pointers/status
  only — milestone id, lifecycle, the fixed parent-link fact, next step,
  mode, delegation/run/gate/evidence pointers — never run logs.
- **No lease transfer.** The target never receives a write-lease entry;
  even a source with an ACTIVE commander lease yields a target whose
  commander writes stay locked (exact canonical tool set restored).
- **Fail-closed restore and legacy compatibility.** Unknown schema
  versions, unknown lifecycles, missing/empty/overlong required fields and
  malformed snapshots are ignored on load; other custom-entry types are
  never touched; there is no migration or rewrite. Restoration normalizes
  a present snapshot so `state.nextStep` equals the validated
  `record.next_step`, keeping the explicit handoff next step through later
  compaction/restoration.
- **Cancellation.** A cancelled replacement records an additive `cancelled`
  record in the still-valid source session and changes nothing else.
- **No automation, no hard stop, no P6/P8 change.** The handoff never calls
  a model/provider, never starts an agent turn, never runs recipes or
  gates, and never changes worker budgets/defaults, the write-authority
  policy, the command/tool inventory, the P6 cache contracts or the P8
  effective-root resolution.

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
