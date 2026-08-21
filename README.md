# pi-dev-workbench

<p align="center">
  <img src="assets/banner.svg" alt="pi-dev-workbench v0.10.0 — development-first Pi workbench with Sol and Luna, evidence-backed delivery" width="720" />
</p>

<p align="center"><strong>Build directly. Delegate when useful. Verify once.</strong></p>

**pi-dev-workbench** is a [Pi Package](https://pi.dev) for shipping software
and quantitative-research work with clear operating modes, reproducible
commands, bounded AI context, and evidence-backed release decisions.

It stays inside Pi: no companion daemon, agent platform, or replacement
runtime.

## Why use it?

| Product capability | What it changes |
| --- | --- |
| **Development-first workflow** | Ordinary source, test, and documentation work stays direct in DEV instead of passing through a governance ceremony |
| **Optional Sol → Luna collaboration** | GPT-5.6 Sol owns the plan and verdict; a bounded GPT-5.6 Luna xhigh worker can implement a well-scoped slice |
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
/q-run typecheck
workbench_delegate_worker   # optional bounded implementation
/q-mode-verify
/q-gate base               # final evidence pass when risk requires it
```

## The product workflow

| Mode | Use it for | Write behavior |
| --- | --- | --- |
| **AUDIT** | Understand the project | Read-only inspection |
| **DEV** | Build and repair | Ordinary edits are direct; high-risk paths require explicit temporary authorization |
| **VERIFY** | Re-check a stable candidate | Declared recipes and gates only |

The normal path is intentionally short:

```text
inspect → develop → focused feedback → stable candidate → final verification
```

A successful delegated implementation performs its scope check and bounded
actual-diff review in the same call. Explicit review and status tools are
recovery surfaces, not mandatory follow-up steps.

## Sol + Luna

The active worker is pinned to `openai-codex/gpt-5.6-luna:xhigh`.

| Actor | Responsibility |
| --- | --- |
| **GPT-5.6 Sol** | Requirements, architecture, scope, acceptance criteria, actual-diff review, final verification, verdict |
| **GPT-5.6 Luna xhigh** | Routine implementation decisions inside one approved, bounded contract |

Worker cumulative limits provide a continuation reserve rather than an early
dead end:

| Profile | Soft → hard turns | Soft → hard total tokens | Soft → hard output tokens |
| --- | ---: | ---: | ---: |
| `low` | 8 → 16 | 816,000 → 1,632,000 | 50,000 → 100,000 |
| `standard` | 32 → 64 | 5,440,000 → 10,880,000 | 160,000 → 320,000 |
| `extended` | 64 → 96 | 10,880,000 → 17,408,000 | 320,000 → 512,000 |

Soft limits request a coherent handoff and allow a bounded follow-up in the
same Sol session. Hard limits remain fail-closed runaway protection. Every
profile also keeps the per-message 272,000-token context guard: 217,600 soft,
244,800 hard.

Historical DeepSeek fixtures remain only for compatibility and cache behavior;
they are not an active worker selector.

## What ships

- Pi-native commands, tools, skills, prompts, and compact TUI status.
- Shell-free recipe definitions with contained paths and redacted run records.
- Base gates `b0–b6` and quant gates `q0–q5`.
- Bounded file reads, run pages, comparisons, gate output, diff reviews, and
  tool-result history.
- Streaming file identities and immutable delegation evidence for trustworthy
  worker attribution and review.
- Cache telemetry, cache health checks, and content-keyed recipe result reuse.
- Generic, stock-selection, and market-timing project templates.

## Measured evidence

- Current full check: **2,398 passed, 0 failed, 1 intentional skip**.
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
