# pi-dev-workbench

<p align="center">
  <img src="assets/banner.svg" alt="pi-dev-workbench v0.10.0 — fixed Sol and Luna collaboration with evidence-backed delivery" width="720" />
</p>

<p align="center"><strong>Plan with Sol. Build with Luna. Verify with evidence.</strong></p>

**pi-dev-workbench** is a [Pi Package](https://pi.dev) for shipping software
and quantitative-research work with clear operating modes, reproducible
commands, bounded AI context, and evidence-backed release decisions.

It stays inside Pi: no companion daemon, agent platform, or replacement
runtime.

## Why use it?

| Product capability | What it changes |
| --- | --- |
| **Fixed Sol → Luna delivery** | GPT-5.6 Sol owns requirements, architecture, scope, review, and verdict; GPT-5.6 Luna xhigh owns routine implementation inside one bounded contract |
| **Low-ceremony governance** | One successful delegation scope-checks, reviews, and closes itself; explicit review/status is reserved for recovery |
| **Bounded Git completion** | After semantic acceptance, Sol checkpoints all compatible reviewed slices at once while preserving unrelated worktree/index state; an explicitly requested exact-HEAD ordinary push is available without force or history rewriting |
| **Repeatable verification** | Named recipes create durable evidence; gates return PASS / FAIL / BLOCKED / NOT_RUN |
| **Context that stays usable** | Bounded results, pagination, history projection, and cumulative worker budgets prevent long sessions from collapsing under their own output |
| **Safe reuse** | Success-only action caching reuses declared recipe results without caching model answers or arbitrary shell work |
| **Quant-ready profiles** | Stock selection and market-timing profiles add research, data, backtest, experiment, and reporting contracts |

## Quick start

Install the package from this checkout:

```bash
npm install --ignore-scripts
pi install -l .
pi -a -p "/q-status"
```

Initialize a project from Pi:

```text
/q-init generic
# or: /q-init quant-research/stock-selection
# or: /q-init quant-research/market-timing
```

Reload the initialized project, approve project trust, then work normally:

```text
/q-mode-dev
workbench_project_inspect   # see the exact recipes generated/detected
/q-run check:typecheck     # example: only when q-init found that package script
workbench_delegate_worker   # normal bounded implementation path
/q-mode-verify
/q-gate base               # final evidence pass when risk requires it
```

After updating or reinstalling the package, run `/reload` before starting a
new conversation. `/new` resets conversation history but does not reload the
workbench extension code already held by the Pi process. `/q-runtime-doctor`
compares the immutable load-time source-tree fingerprint with the current
on-disk fingerprint; a stale result blocks mutation until that individual Pi
session reloads or restarts. Session restoration reads the selected Pi branch
(`getBranch()`); sibling or abandoned branch entries cannot become the active
projection merely because they were appended later.

If a project was initialized from the pre-release local-commit draft and its
existing `AGENTS.md` still names `workbench_commit_reviewed`, run `/q-init`
again with the project's current profile, decline the four workbench-config
overwrites, and approve only the `AGENTS.md` overwrite. This is an explicit
one-time template migration; the runtime does not register a second Git alias
or silently rewrite project instructions.

Execution summaries are checked against machine evidence. In particular, the
assistant may report a current-turn worker attempt only when that turn actually
called `workbench_delegate_worker`; delegation status and completion claims
must match durable workbench authority. If the claim guard rejects a summary,
follow its emitted `next_action` and avoid treating the rejected prose as
evidence. Run-related failures direct you to `workbench_read_run`; delegation
failures direct you to `workbench_delegation_status`. Explicit `delegation_id`
and `run_id` labels are never interchangeable. For an otherwise unlabeled id,
the guard resolves the shared id shape through exclusive strict on-disk run or
delegation authority instead of relying only on prose word order. New guard
messages use the `[workbench-delegation-claim-guard-v2]` envelope and include
`binding_revision: authority-resolved-v2` plus bounded claim/authority counts.
The counts diagnose missing authority without echoing an untrusted id. If the
header still says `workbench-delegation-claim-guard-v1`, the binding revision
line is absent, or `fresh_status_facts` is absent after updating, the Pi process
still has older extension code loaded and must be `/reload`ed before starting
the next conversation.

Diff review is optimized for continuity: call `workbench_review_worker_diff`
without `delegation_id` or semantic fields to inspect the durable latest
delivery. The returned complete packet supplies the exact id and hash required
for a later `ACCEPT` or `REPAIR`; never guess either value. A provisional
read-only call that nevertheless carries a stale or guessed id now recovers to
the durable latest delegation and discards selector-bound path hints. This
recovery never applies to `ACCEPT` or `REPAIR`, which remain exact-id/hash
bound. TUI failures retain the controller's actionable error instead of
collapsing to `review unavailable`, and status/footer guidance follows the
durable transaction (`RUNNING`, `FAILED`, or `PENDING_REVIEW`) so only one next
action is shown. A session custom entry is only a UI/recovery projection:
v2 transaction, generation, review, repair, and command-effect files are the
authority. If a projection append fails after a durable transition succeeds,
the operation still succeeds with a warning and later reconciliation rebuilds
the projection from durable authority.

Long worker runs use actual cumulative turn/token/output boundaries. The soft
threshold requests a coherent handoff; reaching any hard boundary terminates
the attempt and retains its evidence for a bounded continuation. There are no
hidden 65%/85% wall-clock workflow checkpoints.

For a successful diagnosis worker, the durable transaction is `FINISHED` and
semantic review is not required because no implementation delta exists. Any
session `REVIEWED` value is only a non-authoritative projection of that strict
committed diagnosis generation; it cannot turn a failed transaction into
success and grants no Gate authority.

## The product workflow

| Mode | Use it for | Write behavior |
| --- | --- | --- |
| **AUDIT** | Understand the project | Read-only inspection |
| **DEV** | Build and repair | Sol directs; Luna performs routine writes; temporary Sol writes require an explicit bounded lease |
| **VERIFY** | Re-check a stable candidate | Declared recipes and gates only |

The normal path is intentionally short:

```text
inspect → Sol contract → one Luna delivery → focused feedback → stable candidate → final verification
```

A successful delegated implementation performs its scope check and completes
its bounded mechanical presentation in the same call. At no more than 32
pages, the runtime then invokes the structured GPT-5.6 Sol reviewer and
persists only a hash-bound `ACCEPT` or `REPAIR`; model/protocol/drift failure
leaves durable worker success intact and returns `/q-review <id>` for direct,
idempotent recovery. `/q-review` and `/q-repair` execute their exact durable
services without asking the commander model to choose or reconstruct a tool
call. Machine-facing results instead return callable
`workbench_review_worker_diff` or `workbench_repair_delegation` actions, so an
agent never deadlocks on a user-only slash command. Manual
`workbench_review_worker_diff` remains available for legacy,
oversized, mechanically failed, or authority-gap cases.

A closed implementation failure with attributable partial work is persisted as
`INTERRUPTED`, not as reviewable success. Strictly eligible `INTERRUPTED` (and
compatible committed `FAILED`) evidence may receive only a terminal-negative
Sol `REPAIR` sidecar; `ACCEPT` and ordinary `REVIEWED` are forbidden before an
exact repair successor is reviewed normally. The canonical model route is
`workbench_repair_delegation` with only the rejected delegation id;
`/q-repair` is the equivalent human convenience command.

All mutation-capable Workbench tools and commands share one checkout writer
lane, including delegation, recipes, Git completion, review/repair publication,
and project/config writes. Reentrancy requires the exact live token; cleanup of
a settled generic operation is same-process, exact-token recovery, never a TTL
or guessed-PID unlock.

Once semantic acceptance and the relevant final checks are complete, Sol can
call `workbench_git` with
`action=checkpoint` and one commit message. The runtime derives exact paths
from durable review authority, verifies their sealed after-records, batches
all compatible accepted slices into one commit, and preserves unrelated dirty
and staged work. A newer unrelated pending/failed/diagnostic transaction does
not hide an older accepted slice. A malformed older candidate may be skipped
only when a newer valid review fully supersedes all of its dirty paths; any
uncovered invalid path still fails closed. Path-disjoint descendant commits and index
status changes do not force semantic re-review; reviewed path-content drift,
non-descendant history, or an intervening commit touching a still-dirty
reviewed path still fails closed.

When the user explicitly asks to publish, Sol may call the same tool with
`action=push` and the exact current `expected_head`. It performs only an
ordinary push of the current named branch to the same remote branch and reads
the remote ref back for exact verification. Force, ref deletion, amend,
reset, clean, stash, branch switching, and caller-selected checkpoint paths
are not expressible.

## Sol + Luna

The active worker is pinned to `openai-codex/gpt-5.6-luna:xhigh`.

| Actor | Responsibility |
| --- | --- |
| **GPT-5.6 Sol** | Requirements, architecture, scope, acceptance criteria, actual-diff review, final verification, verdict |
| **GPT-5.6 Luna xhigh** | Routine source, test, and documentation implementation inside one approved, bounded contract |

Sol does not receive ordinary `edit`/`write` tools. A user may grant a
short-lived, path- and call-bounded lease for an explicit exceptional direct
write; locking, expiry, or exhaustion restores the fixed worker-first surface.
Git completion is separate from that lease: the approved Sol commander in DEV
may use `workbench_git` to checkpoint still-present non-zero deliveries with
finalized semantic ACCEPT authority. One call batches all compatible sealed
path sets. `action=push` is available only for an explicitly requested
publication and must bind the exact current HEAD; it grants no release, Gate,
Formal, or production authority.

Worker cumulative limits provide a continuation reserve rather than an early
dead end:

| Profile | Soft → advisory turn marker | Soft → hard total tokens | Soft → hard output tokens |
| --- | ---: | ---: | ---: |
| `standard` | 32 → 64 | 5,440,000 → 10,880,000 | 160,000 → 320,000 |
| `extended` | 64 → 96 | 10,880,000 → 17,408,000 | 320,000 → 512,000 |

`standard` is the bounded default for new delegations. Select `extended`
explicitly only for a justified larger bounded slice.

Soft limits request a coherent handoff and allow a bounded follow-up in the
same Sol session. Every hard turn, cumulative-total, or cumulative-output
boundary terminates the bounded attempt with retained evidence. Every profile
also keeps the per-message 272,000-token
context guard: 217,600 soft, 244,800 hard; timeout, compaction rejection, and
model-identity checks are unchanged.

The retired `low` profile remains readable only in historical delegation
records. New requests reject it before persistence or worker launch; old or
internal runtime values fall back to the bounded `standard` default.

Historical DeepSeek fixtures remain only for compatibility and cache behavior;
they are not an active worker selector.

## What ships

- Pi-native commands, tools, skills, prompts, and compact TUI status.
- Five concise default workflow/router skills; nine orientation, release, CLI,
  and research specialists remain available explicitly without inflating every
  model prompt. Detailed references load only when the current question needs
  them.
- Shell-free recipe definitions with contained paths and redacted run records.
- Base gates `b0–b6` and quant gates `q0–q5`.
- Bounded file reads, run pages, comparisons, gate output, diff reviews, and
  tool-result history.
- Streaming file identities and immutable delegation evidence for trustworthy
  worker attribution and review.
- Durable command-effect provenance: exact declared outputs are content-bound
  even when Git-ignored; declaration violations, unknown origin, and
  out-of-scope effects fail closed and never imply semantic acceptance.
- Cache telemetry, cache health checks, and content-keyed recipe result reuse.
- Generic, stock-selection, and market-timing project templates.

## Measured evidence

- Current full check: **2,404 passed, 0 failed, 1 intentional skip**.
- Formal context/output stress: **101/101 acceptance checks passed**.
- Frozen native read/grep cohort: median gross tokens **−76.72%**, successful
  inline bytes **−89.46%**, and requests **−30%** versus its control arm.

The benchmark figures are arithmetic facts for the frozen 20-control /
20-treatment cohort, not a universal speed or causality claim. See the
[benchmark report](docs/baselines/commander-native-tool-benchmark-v2.md).

## Popular commands

```text
/q-status                         current mode, trust, tools, review state
/q-mode-audit | dev | verify      switch operating mode
/q-run <recipe> [key=value]       run a declared recipe
/q-runs                           list durable runs
/q-gate base                      run the base validation ladder
/q-promote research <id> <run>    freeze and Gate one Candidate for research acceptance
/q-promote release <id> <run> --artifact-run <run> --authorize-release
                                  explicitly authorize a provenance-bound release Candidate
/q-delegation-status              inspect delegation/review recovery state
/q-runtime-doctor                 compare loaded and on-disk runtime fingerprints
/q-review <delegation-id>         directly resume one durable Sol semantic review
/q-repair <delegation-id>         directly execute one exact durable repair
/q-cache-status                   inspect current cache telemetry
/q-cache-doctor                   run cache health checks
```

`/q-review` is reserved for the deterministic durable-review command. The
former read-only code-review prompt is `/q-code-review [scope]`; the old prompt
name has no alias so a review request cannot accidentally start a model turn.

`/q-promote` is user-only and requires VERIFY mode. It never pushes or
publishes. A failed Gate withholds promotion but leaves DEV available for a
new Candidate; release promotion additionally binds the exact source, recipe,
runtime, resolved inputs, and artifact hashes. Neither promotion nor run
comparison grants profitability or “better strategy” authority.

## Security boundary

The workbench is a discipline and evidence boundary, not an OS sandbox.
Recipes run with the user's permissions. Project trust, strict path handling,
output redaction, high-risk write authorization, and fail-closed evidence
parsing reduce accidental misuse; they do not replace operating-system
isolation.

The current runtime and its committed transaction/run records are the product
authority. Historical plans, handoffs, benchmark narratives, and compatibility
notes explain decisions but never override current code or create a required
development step.

Production uses the v2 filesystem authority and one shared-checkout writer at
a time. Before a delegation starts, strict historical path-lane admission
scans durable blockers and is revalidated after the checkout lease is held;
known non-overlapping history may proceed, while overlap, unknown provenance,
or corrupt authority still fail closed.

## Compatibility

Released v0.10.0 was qualified with Pi/pi-tui 0.83.0. The current source and
dependency tree target Pi/pi-tui 0.84.2 and pin the worker to GPT-5.6 Luna
xhigh. A private-data-free live smoke verified the current provider/model;
deployment into another Pi installation still requires `/reload` and an
environment-local canary.

See the [tested environment matrix](docs/compatibility.md) and its
[machine-readable record](compatibility/pi.json).

## Documentation

- [Project onboarding](docs/project-onboarding.md)
- [Architecture](docs/architecture.md)
- [Worker collaboration](docs/worker-delegation.md)
- [Context and output control](docs/context-output-control-plane.md)
- [Security model](docs/security.md)
- [Quant research profiles](docs/quant-research-profile.md)
- [Cache documentation](docs/cache/)

## Development

```bash
npm run typecheck
npm test
npm run check
npm run test:release-assets
node tools/make-banner.mjs
```

MIT licensed. See [LICENSE](LICENSE).
