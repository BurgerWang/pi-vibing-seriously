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
| **Review-bound local commits** | After semantic acceptance, Sol can checkpoint each exact reviewed slice locally, including an earlier reviewed backlog after the first checkpoint changes HEAD, without asking you to stage or commit it; push and history rewriting remain unavailable |
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
workbench extension code already held by the Pi process.

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
header still says `workbench-delegation-claim-guard-v1`, or the binding revision
line is absent after updating, the Pi process still has older extension code
loaded and must be `/reload`ed before starting the next conversation.

Diff review is optimized for continuity: call `workbench_review_worker_diff`
without `delegation_id` or semantic fields to inspect the durable latest
delivery. The returned complete packet supplies the exact id and hash required
for a later `ACCEPT` or `REPAIR`; never guess either value. TUI failures retain
the controller's actionable error instead of collapsing to `review unavailable`,
and status/footer guidance follows the durable transaction (`RUNNING`, `FAILED`,
or `PENDING_REVIEW`) so only one next action is shown. Long worker runs also get
hidden wall-clock checkpoints at 65% and 85% of the existing timeout to finish a
coherent slice, preserve verification, and write the required handoff before the
unchanged hard timeout. These are workflow/observability improvements, not new
approval or Gate layers.

For a successful diagnosis worker, the durable transaction remains `FINISHED`
while the worker result and session review projection are `REVIEWED` because no
implementation diff needs semantic review. The guard derives both facts from
the strict committed diagnosis generation, including after a later delegation
becomes the session's latest item; neither projection grants Gate authority.

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

A successful delegated implementation performs its scope check and bounded
actual-diff review in the same call. Explicit review and status tools are
recovery surfaces, not mandatory follow-up steps. Once semantic acceptance and
the relevant final checks are complete, Sol can call
`workbench_commit_reviewed` with only a commit message. The runtime derives the
exact path set from durable review authority, preserves unrelated dirty files,
and reports `push=NOT_RUN`. If reviewed changes remain, its result directs Sol
to call the same tool again; Sol does not hand staging back to the user. An
older slice is accepted after HEAD advances only when the conflict is exactly a
HEAD conflict, the new HEAD descends from the reviewed HEAD without touching
that slice, and its live bytes/status still equal the sealed review snapshot. A
newer finalized successful zero-change diagnosis is skipped because it has no
implementation commit obligation; pending, failed, or incomplete latest work
still blocks.
The tool cannot amend, reset the worktree, clean, stash, switch branches, or
push. If its own commit attempt fails before creating a commit, it may unstage
only the exact paths it staged, without discarding their worktree bytes.

## Sol + Luna

The active worker is pinned to `openai-codex/gpt-5.6-luna:xhigh`.

| Actor | Responsibility |
| --- | --- |
| **GPT-5.6 Sol** | Requirements, architecture, scope, acceptance criteria, actual-diff review, final verification, verdict |
| **GPT-5.6 Luna xhigh** | Routine source, test, and documentation implementation inside one approved, bounded contract |

Sol does not receive ordinary `edit`/`write` tools. A user may grant a
short-lived, path- and call-bounded lease for an explicit exceptional direct
write; locking, expiry, or exhaustion restores the fixed worker-first surface.
Local checkpointing is separate from that lease: the approved Sol commander in
DEV may use `workbench_commit_reviewed` only for a still-present non-zero
delivery with finalized semantic ACCEPT authority and an exact current or
accepted-descendant binding. Repeated calls select the reviewed backlog one
slice at a time. No per-commit user action is required, but
push/publish/release authority is never implied.

Worker cumulative limits provide a continuation reserve rather than an early
dead end:

| Profile | Soft → advisory turn marker | Soft → hard total tokens | Soft → hard output tokens |
| --- | ---: | ---: | ---: |
| `standard` | 32 → 64 | 5,440,000 → 10,880,000 | 160,000 → 320,000 |
| `extended` | 64 → 96 | 10,880,000 → 17,408,000 | 320,000 → 512,000 |

`extended` is the safe default for new delegations. Select `standard`
explicitly only for a clearly small, bounded slice.

Soft limits request a coherent handoff and allow a bounded follow-up in the
same Sol session. A turn marker remains visible but never kills healthy,
tool-heavy work by itself. Cumulative total/output limits remain fail-closed
runaway protection. Every profile also keeps the per-message 272,000-token
context guard: 217,600 soft, 244,800 hard; timeout, compaction rejection, and
model-identity checks are unchanged.

The retired `low` profile remains readable only in historical delegation
records. New requests reject it before persistence or worker launch; old or
internal runtime values fall back to the safe `extended` default.

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
/q-delegation-status              inspect delegation/review recovery state
/q-cache-status                   inspect current cache telemetry
/q-cache-doctor                   run cache health checks
```

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
