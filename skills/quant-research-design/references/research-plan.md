# Research plan template

```markdown
# Research plan: <name>

## Hypothesis
<one falsifiable statement; define every term>

## Universe
- Instruments: <definition, point-in-time>
- Period: <start> to <end>
- Frequency: <daily/weekly/monthly/...>

## Data
- <dataset> — <resolution, point-in-time availability, source of truth>
- Survivorship handling: <plan>
- Corporate actions/adjustments: <plan>

## Strategy definition
- Signal: <what is computed, from what, at what timestamp>
- Position rule: <long/flat/short, weights, caps>
- Rebalance: <calendar/event, at what time>

## Benchmark
<name, construction, alignment>

## Evaluation
- Metrics: <list, with definitions>
- Segmentation: <in-sample / out-of-sample / walk-forward plan>
- Parameter selection: <protocol decided in advance>
- Decision rule: <what would make this research "done", stated in advance>

## Risks and limitations
<what could invalidate the results>
```

## Section checklists

- **Hypothesis**: is it falsifiable? Can a single dataset and procedure
  answer it? Are terms defined (what is "X", what is "outperform")?
- **Universe**: can the universe be reconstructed point-in-time from the
  data (membership as of each date)? Does it include names that later
  delisted?
- **Data**: does each dataset have a timestamp that says WHEN the
  information was knowable? Is the vendor's correction/restatement policy
  understood?
- **Benchmark**: does the benchmark overlap the universe and the strategy's
  risk exposure? Is it investable at the same frequency?
- **Evaluation**: are the metrics defined so a colleague could compute them
  from the same outputs? Is the segmentation decided before the first run?
