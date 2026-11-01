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

- `legit` (46 rows): faithful values, copied or paraphrased the way the open
  contract asks, in English, Russian and Portuguese. Most turns come from the
  memory-fitness corpus.
- `bad` (24 rows): values the turn does not support, such as a misread figure,
  a swapped name, a claim the turn negates, or an injected secret.

## Result at the change that introduced it

| | |
|---|---|
| legit kept | 43/46 |
| bad rejected | 23/24 |

Remaining misses:

- Three faithful paraphrases the base NLI model does not resolve:
  `relationship_status=single`, `hobby=hiking (no longer)`,
  `diet=вегетарианка`. These turns still stand in the raw episode layer.
- One spelled-out figure misread: `$5,000,000` against "fifty thousand
  dollars".

The rows are hand-written, so this measures the check on known cases. It does
not estimate the share of real extractions it drops; the memory-fitness and
state-transition batteries are the regression check for that.
