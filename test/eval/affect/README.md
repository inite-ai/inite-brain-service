# Affect battery

Measures the affect reader (#909 step 4, `src/affect/affect-reading.ts`):
does it read how a person feels from their own words, and does it keep
quiet when there is nothing to read?

```
pnpm eval:affect emit  --set=dialogues|goemotions [--n=150] [--out=var/affect]
# the model answers <out>/<set>.requests.jsonl → <out>/<set>.answers.jsonl
pnpm eval:affect score --set=dialogues|goemotions [--out=var/affect] [--json]
```

Keyless. The battery never calls a model: `emit` writes exactly the
requests the reader sends (`AFFECT_READING_SYSTEM` + `affectReadingUser`),
whoever is measured answers them (a connected agent in harness mode, or a
subagent in a measurement session), and `score` passes each answer through
the reader's own parser (`parseAffectReading`), so a reading that quotes
words the turn does not contain counts as no reading — what production
would keep. Hand the answerer only `id` + `user` (and the system prompt);
the requests file also carries the gold.

## Sets

- **dialogues** (`dialogues.json`): 12 hand-written conversations in en / ru
  / pt, 45 OWN turns. Each carries the Ekman labels a careful reader would
  give, or none, and `trap` where the turn is built to tempt a false
  reading: sarcasm, a quoted feeling, someone else's feeling, a
  hypothetical, a formula ("thanks!"), an opinion with no feeling in it.
- **goemotions**: Reddit comments with human emotion labels (Demszky et al.
  2020, CC BY 4.0), test split, folded to Ekman's six + neutral by the
  dataset's own `ekman_mapping.json`. Fetched at run time from the HF
  datasets server and the GoEmotions repository; nothing is vendored.
  `--n=150` takes every other row of three 100-row pages spread across the
  split.

## Measures

- **detection P / R / F1** — feeling found where a human found it, nothing
  where a human found none;
- **label accuracy** — of turns both found emotional, the share where a read
  label is one the human gave; **macro-F1** over the six labels;
- **false positives** on turns with nothing to read, overall and by trap;
- **calibration** — ECE over observations, ten equal-width bins; an
  observation is correct when its label is one the human gave.

## Result (2026-11-06, harness mode: a Claude Opus 5.5 subagent as the reader)

| set        | turns | detection P / R / F1  | label acc. | macro-F1 | FP on nothing | ECE   |
| ---------- | ----- | --------------------- | ---------- | -------- | ------------- | ----- |
| dialogues  | 45    | 100% / 95.5% / 97.7%  | 100%       | 89.7%    | 0% (0/23)     | 0.212 |
| goemotions | 150   | 86.7% / 48.6% / 62.3% | 73.1%      | 43.1%    | 18.6% (8/43)  | 0.127 |

Dialogue traps: 0 of 19 misread (formula 0/5, sarcasm 0/3, someone else's
feeling 0/3, opinion 0/2, hypothetical 0/3, quoted 0/3). By language: en
F1 95.2%, ru 100%, pt 100%, no false positive in any.

GoEmotions reliability (confidence → share correct): 0.42 → 21%, 0.52 →
50%, 0.61 → 83%, 0.72 → 67%, 0.83 → 100%, 0.91 → 100%.

What it shows:

- **It keeps quiet where it should.** Not one of the 19 dialogue traps was
  misread, and every reading quoted words that are in the turn (0 dropped
  by the parser on either set).
- **GoEmotions recall is low by design, not by miss.** 32 of the 55 misses
  are comments GoEmotions labels with its social and cognitive categories,
  which fold into joy / anger / surprise: gratitude ("You're welcome",
  "Thanks will check them out!"), approval ("i mean, yeah tbh."),
  disapproval ("You didn't watch it to the end."), curiosity, realization.
  The reader's prompt tells it not to read formulas and opinions as
  feelings, and a memory of how a person feels should not record a
  "thanks" as joy. The battery does not re-slice the gold to hide this: the
  number is what GoEmotions says.
- **The false positives are low-confidence and partly arguable.** All 8
  readings on comments GoEmotions calls neutral carry confidence 0.4–0.6
  ("Waiting for both of these things is torture" → anger 0.4, "#YES." →
  joy 0.55). In that range the reliability table says they are right a
  third of the time — which is what the confidence says. A consumer
  weighting by confidence (relationship_context does) discounts them.
- **Confidence means what it says on GoEmotions** (ECE 0.127, monotone up to
  0.8+ being always right). On the dialogues the reader is under-confident
  (ECE 0.212: every reading was right at 0.6–0.9), on a set too small to
  calibrate against.
- **Caveats.** The dialogues were written for this battery by the same
  model family that reads them, so GoEmotions is the independent check.
  The production server reads with the tenant's `OPENAI_CHAT_MODEL`; this
  result measures the harness reader. A server-model run needs the
  maintainer's OK (it spends money).
