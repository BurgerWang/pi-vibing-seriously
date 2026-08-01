# Data integrity checklist

Run these checks on every dataset before modeling. Record results per
dataset; any failed check blocks research until resolved or explicitly
documented.

## Coverage

- [ ] Date range: expected start/end present; gaps quantified (missing
      dates per instrument, per market).
- [ ] Instrument count per date is stable or explained (listings, IPOs,
      delistings) — a count that only ever grows points to survivorship.
- [ ] The universe file is point-in-time: membership as of each date, not
      today's membership applied backwards.

## Records

- [ ] Duplicate (instrument, timestamp) rows detected and resolved with a
      documented rule.
- [ ] Suspended/no-trade days are distinguishable from missing data.
- [ ] Zero or negative prices/volumes found and explained (or rejected).
- [ ] Outlier checks: extreme single-period moves flagged and verified
      against corporate actions (a 500% move is often a split).

## Adjustments

- [ ] Price series states whether it is raw, adjusted, or factor-adjusted;
      the adjustment convention is applied consistently across the period.
- [ ] Adjustment factors (if any) have their own audit trail and are
      applied at the correct effective dates.
- [ ] Total-return series include cash distributions; if not, the report
      says returns are price-only.

## Timestamps

- [ ] Timezone and calendar convention documented (e.g. "close of T in
      exchange local time").
- [ ] Cross-dataset joins use aligned timestamps or an explicit alignment
      rule (close-to-close, next-open, etc.).
- [ ] No look-ahead introduced by timestamp convention (see
      `skill:backtest-integrity`).

## Identifiers

- [ ] Stable identifier used across time; ticker/name changes mapped.
- [ ] Join keys unique on both sides; join cardinality verified.
- [ ] Security type/class filters (ordinary vs preference shares, ADRs,
      units) are explicit.
