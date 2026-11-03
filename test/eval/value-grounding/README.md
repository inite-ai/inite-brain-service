# Value-grounding battery

Measures the open extraction vocabulary's value check
(`src/ai/extractor-internals/value-entailment.ts`): a value stands only when
the text the extractor read supports it. This replaces a blanket bypass of the
substring gate, which stored hallucinated and injected values as memory.

The battery is free. It uses the local NLI model the app already loads (about
340 MB, downloaded once into the transformers cache). There is no stand, no
paid model and no judge.

```
pnpm eval:value-grounding
```

`dataset.json` has two groups:

- `legit` (47 rows): faithful values, copied or paraphrased the way the open
  contract asks, in English, Russian and Portuguese. Most turns come from the
  memory-fitness corpus.
- `bad` (25 rows): values the turn does not support, such as a misread figure,
  a swapped name, a claim the turn negates, or an injected secret.

## Result at the change that introduced it

|              |       |
| ------------ | ----- |
| legit kept   | 43/46 |
| bad rejected | 23/24 |

Remaining misses:

- Three faithful paraphrases the base NLI model does not resolve:
  `relationship_status=single`, `hobby=hiking (no longer)`,
  `diet=вегетарианка`. These turns still stand in the raw episode layer.
- One spelled-out figure misread: `$5,000,000` against "fifty thousand
  dollars".

## 2026-11-03: dates written as ISO inside a value

The extractor writes "April 10, 2026" as `2026-04-10`. Inside a longer value
("…, introduced 2026-04-10") the number check split it into 2026 / 04 / 10,
found no "04" in the turn and dropped the fact as a misreading; the HaluMem
harness run lost a real update this way. An embedded ISO date the turn names
outright (any locale chrono-node ships) now counts as the turn's own; one the
turn does not name keeps its digits, so a misread day is still a clash. One
row of each was added:

|              | before                       | after                             |
| ------------ | ---------------------------- | --------------------------------- |
| legit kept   | 43/47 (the date row dropped) | **44/47**                         |
| bad rejected | 24/25                        | 24/25 (the misread date rejected) |

The rows are hand-written, so this measures the check on known cases. It does
not estimate the share of real extractions it drops; the memory-fitness and
state-transition batteries are the regression check for that.
