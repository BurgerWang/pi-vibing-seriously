# Adjustments and delisting

## Corporate actions

A price series must be comparable across a corporate action:

- **Split / reverse split** — price and share count change; returns must be
  computed on a consistent basis (split-adjusted prices, or factor-adjusted
  returns).
- **Cash dividend** — a price-only series drops by the dividend on the
  ex-date; total-return series add it back. State which one the research
  uses, and be consistent between signal and benchmark.
- **Spinoff / rights** — value is redistributed; adjustment factors must
  capture the value transfer, otherwise returns around the event are
  distorted.
- **Effective dates** — adjustments apply from the correct date (ex-date,
  not announcement date, not payment date). Getting this wrong creates fake
  jumps or holes.

## Delisting

A backtest that drops delisted names mid-history:

1. overstates returns (failed names vanish before their final losses), and
2. is not investable (the holder cannot exit a delisted name at a stale
   price).

Delisting handling must include:

- A final observable record (last traded/delisting price or a documented
  recovery assumption).
- A rule for the return from the last liquid price to the delisting
  outcome, applied consistently to strategy and benchmark.
- Explicit treatment of names suspended before delisting (see
  `skill:backtest-integrity`).

## Documentation

Record per dataset: adjustment convention, delisting rule, and any known
vendor restatement behavior. The record lives with the data pipeline, and
the research report cites it.
