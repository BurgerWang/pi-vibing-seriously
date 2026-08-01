---
name: quant-research-design
description: Design a quantitative research project before writing code — hypothesis, universe, period, frequency, data requirements, benchmark, evaluation plan, and documentation. Use at the start of any research task (stock selection, market timing, or data study).
---

# Quant Research Design

Goal: a written research plan that states what will be tested, on what data,
against what benchmark, and how success will be judged — BEFORE any backtest
code is written.

## Scope

This skill covers research design and evaluation planning for mid/low-
frequency quantitative research: stock selection, market timing, data
studies, and backtesting. Design and validation of exchange execution
infrastructure is out of scope.

## Steps

1. **Hypothesis** — one falsifiable statement: "feature X (as defined, at
   time T) predicts relative return over horizon H". Write the definition
   down; an undefined feature cannot be tested.
2. **Universe and period** — which instruments, over which dates, at what
   frequency. Define the universe point-in-time, not today's list.
3. **Data requirements** — list every dataset needed, its resolution, and
   its point-in-time availability. If the data cannot be obtained
   point-in-time, say so before designing around it.
4. **Benchmark** — choose a benchmark that matches the universe and the
   strategy's exposure (see references). A strategy without a benchmark
   cannot be evaluated.
5. **Evaluation plan** — metrics, data segmentation (in-sample /
   out-of-sample / walk-forward), and the decision rule in advance. Decide
   how parameters will be chosen and validated BEFORE running experiments
   (see `skill:experiment-validation`).
6. **Document** — write the plan into the project (research notes or a
   design doc). The plan is a living contract: changes to it are
   deliberate, recorded changes.

## Rules

- Design decisions come before code; changing the hypothesis after seeing
  results is a different experiment and must be labeled as such.
- State the assumptions (data vendor behavior, survivorship handling,
  cost model) explicitly.
- Never let the benchmark, period, or universe be chosen after the fact to
  flatter results.

## Details

- See [references/research-plan.md](references/research-plan.md) for the
  plan template and per-section checklists.
- See [references/evaluation-plan.md](references/evaluation-plan.md) for
  benchmark choice, metrics, and data segmentation.
- Data quality is assumed by the design but verified by
  `skill:market-data-integrity`; backtest correctness by
  `skill:backtest-integrity`.
