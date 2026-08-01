---
name: market-data-integrity
description: Verify market data before trusting it in research — point-in-time availability, survivorship, delisting, corporate actions and adjustments, missing/duplicate records, timestamps and alignment. Use before any modeling, backtest, or data study.
---

# Market Data Integrity

Goal: demonstrate (not assume) that the dataset supports the research claims
made on it. Data errors look like strategy alpha; integrity checks are the
first line of defense.

## Checks

1. **Point-in-time availability** — is each record knowable at its
   timestamp? Are restatements, revisions, and backfilled fields identified?
2. **Survivorship** — does the dataset contain names that later delisted or
   were acquired? A universe filtered to today's listings flatters history.
3. **Delisting handling** — are delisted names present with a final record
   and a delisting date? What happens to their returns after the last quote?
4. **Corporate actions** — splits, dividends, spinoffs, rights: are prices
   adjusted consistently, or are raw prices used with adjustment factors?
   Are cash dividends included in total-return series?
5. **Missing and duplicate records** — missing dates (suspensions, no
   trade), duplicate timestamps, overlapping sources. How is each handled?
6. **Timestamps and alignment** — timezone, exchange calendar, and the
   convention for "the price at date T" (close, adjusted close, timestamp
   of the bar). Alignment errors create fake signals at day boundaries.
7. **Identifiers** — symbol/ID changes over time (ticker changes, mergers);
   joins across datasets must use stable identifiers with a mapping table.

## Rules

- Every assumption about the data (adjusted vs raw, point-in-time vs
  restated) is written down and checked, not inherited silently.
- Integrity checks run BEFORE modeling and are part of the reproducible
  pipeline, not a one-off investigation.
- When data cannot be validated, the research report says so and states the
  impact on conclusions.

## Details

- See [references/data-integrity-checklist.md](references/data-integrity-checklist.md)
  for the executable checklist with concrete checks per dataset.
- See [references/adjustments-and-delisting.md](references/adjustments-and-delisting.md)
  for corporate-action adjustment and delisting return handling.
- See `skill:backtest-integrity` for how data problems surface inside
  backtests.
